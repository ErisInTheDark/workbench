/*
 * Exports:
 * - SandboxRelayAdmission: one command's relay-wrapped argv, relay environment and release.
 * - SandboxRelayBrokerOptions: inject relay staging or resolution, host port reading, poll scheduling and error reporting.
 * - default SandboxRelayBroker: own the host half of the Linux sandbox relay: per-command admission tokens, host
 *   loopback port pushes, and host listeners that carry connections into a command's network namespace.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { verifyNativeSidecarArtifact } from "workbench-shared/native/native-sidecar-artifact";
import type { NativeArtifactStager } from "workbench-shared/process/NativeArtifactStage";
import { logError } from "../process-helpers";
import { readListeningLoopbackPorts } from "./proc-net-listeners";
import {
  RELAY_ENV_KEY, RELAY_MESSAGE_BYTES, RELAY_SIDECAR_ARTIFACT, RelayMessageSchema, encodeBrokerMessage, type BrokerMessage,
  type RelayMessage,
} from "./sandbox-relay-protocol";

/** Owner: host port poll. Reason: a host service started mid-command becomes reachable within one interval. */
const HOST_PORT_POLL_MS = 500;
/** Owner: reverse opens. Reason: a relay that never answers must not hold a host connection. Failure: close it. */
const REVERSE_ACCEPT_TIMEOUT_MS = 5_000;
/** Owner: inbound broker connections. Reason: a connection that never identifies itself is dropped. */
const FIRST_LINE_TIMEOUT_MS = 10_000;
/** A host port the machine already uses, or an address family it lacks, simply stays unexposed. */
const EXPECTED_BIND_FAILURES = new Set(["EADDRINUSE", "EADDRNOTAVAIL", "EAFNOSUPPORT"]);

export interface SandboxRelayAdmission {
  argv: string[];
  env: Record<string, string>;
  release(): void;
}

export interface SandboxRelayBrokerOptions {
  /** Workbench repository root holding the relay sidecar. */
  root: string;
  /** Materializes the committed relay as an executable runtime copy. */
  stage?: NativeArtifactStager;
  resolveRelay?: () => Promise<string>;
  readHostPorts?: () => Promise<Set<number>>;
  /** Starts repeating `tick` while relays are connected; returns its stop function. */
  schedulePoll?: (tick: () => void) => () => void;
  reportError?: (message: string) => void;
}

interface Admission {
  token: string;
  control: Socket | null;
  /** Whether the control connection received its first host port snapshot; only synced relays get change pushes. */
  synced: boolean;
  reverse: Map<number, Server[]>;
  pending: Map<string, { socket: Socket; timer: NodeJS.Timeout }>;
  /** Serializes reverse listener changes so reported port sets apply in order. */
  exposure: Promise<void>;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function scheduleInterval(tick: () => void) {
  const timer = setInterval(tick, HOST_PORT_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function sameNumbers(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Reads the first line, then pauses; `rest` holds bytes that arrived after it. */
function readFirstLine(socket: Socket, done: (line: string, rest: Buffer) => void) {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline === -1) {
      if (buffered.length > RELAY_MESSAGE_BYTES) socket.destroy();
      return;
    }
    socket.pause();
    socket.off("data", onData);
    done(buffered.subarray(0, newline).toString("utf8"), buffered.subarray(newline + 1));
  };
  socket.on("data", onData);
}

function readLines(socket: Socket, initial: Buffer, onLine: (line: string) => void) {
  let buffered = initial;
  const drain = () => {
    let newline: number;
    while ((newline = buffered.indexOf(0x0a)) !== -1 && !socket.destroyed) {
      const line = buffered.subarray(0, newline).toString("utf8");
      buffered = buffered.subarray(newline + 1);
      onLine(line);
    }
    if (buffered.length > RELAY_MESSAGE_BYTES) socket.destroy();
  };
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  });
  drain();
  socket.resume();
}

/** Joins a host connection to its relay data connection; each side half-closes the other when it ends. */
function splice(host: Socket, relay: Socket, early: Buffer) {
  const fail = () => {
    host.destroy();
    relay.destroy();
  };
  host.on("error", fail);
  relay.on("error", fail);
  if (early.length) host.write(early);
  relay.pipe(host);
  host.pipe(relay);
}

function closeServers(servers: readonly Server[]) {
  for (const server of servers) server.close();
}

export default class SandboxRelayBroker {
  private readonly admissions = new Map<string, Admission>();
  private readonly sockets = new Set<Socket>();
  private readonly reportError: (message: string) => void;
  private relay?: Promise<string | null>;
  private listening?: Promise<number | null>;
  private listener?: Server;
  private port: number | null = null;
  private hostPorts: number[] = [];
  private refresh?: Promise<void>;
  private stopPoll: (() => void) | null = null;
  private hostPortFailureReported = false;
  private disposed = false;

  constructor(private readonly options: SandboxRelayBrokerOptions) {
    this.reportError = options.reportError ?? (message => logError("sandbox-relay", message));
  }

  /** Wraps one sandboxed command in the relay, or returns null so it runs unrelayed. */
  async admit(command: readonly string[]): Promise<SandboxRelayAdmission | null> {
    if (this.disposed) return null;
    const [relay, port] = await Promise.all([this.resolveRelay(), this.listen()]);
    if (relay === null || port === null || this.disposed) return null;
    const token = randomBytes(24).toString("base64url");
    this.admissions.set(token, {
      token, control: null, synced: false, reverse: new Map(), pending: new Map(), exposure: Promise.resolve(),
    });
    return {
      argv: [relay, "--", ...command],
      env: { [RELAY_ENV_KEY]: JSON.stringify({ broker: `127.0.0.1:${port}`, token }) },
      release: () => this.release(token),
    };
  }

  async dispose() {
    this.disposed = true;
    for (const token of [...this.admissions.keys()]) this.release(token);
    this.stopPoll?.();
    this.stopPoll = null;
    for (const socket of this.sockets) socket.destroy();
    const listener = this.listener;
    this.listener = undefined;
    if (listener?.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
  }

  private resolveRelay() {
    const resolve = this.options.resolveRelay
      ?? (() => verifyNativeSidecarArtifact(this.options.root, RELAY_SIDECAR_ARTIFACT, this.options.stage));
    this.relay ??= resolve().catch((error: unknown) => {
      this.reportError(`Sandboxed commands run without the loopback relay: ${describe(error)}`);
      return null;
    });
    return this.relay;
  }

  private listen() {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer({ allowHalfOpen: true }, socket => this.accept(socket));
      this.listener = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", error => this.reportError(`Sandbox relay broker failed: ${describe(error)}`));
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    }).catch((error: unknown) => {
      this.reportError(`Sandboxed commands run without the loopback relay; its broker could not listen: ${describe(error)}`);
      return null;
    });
    return this.listening;
  }

  private accept(socket: Socket) {
    if (this.disposed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    // A failed connection ends; whichever owner holds it reacts to its close.
    socket.on("error", () => socket.destroy());
    socket.setTimeout(FIRST_LINE_TIMEOUT_MS, () => socket.destroy());
    readFirstLine(socket, (line, rest) => {
      socket.setTimeout(0);
      const message = this.parse(line);
      if (message?.type === "hello") this.attachControl(socket, message.token, rest);
      else if (message?.type === "accept") this.attachReverse(socket, message.token, message.id, rest);
      else socket.destroy();
    });
  }

  private parse(line: string): RelayMessage | null {
    let json: unknown;
    try { json = JSON.parse(line); } catch { json = undefined; }
    const parsed = RelayMessageSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    this.reportError("A sandbox relay sent an invalid message; its connection was closed.");
    return null;
  }

  private attachControl(socket: Socket, token: string, rest: Buffer) {
    const admission = this.admissions.get(token);
    if (!admission || admission.control) {
      socket.destroy();
      return;
    }
    admission.control = socket;
    socket.once("close", () => {
      if (admission.control !== socket) return;
      admission.control = null;
      admission.synced = false;
      this.closeReverse(admission);
      this.updatePolling();
    });
    readLines(socket, rest, line => {
      const message = this.parse(line);
      if (message?.type !== "sandboxPorts") {
        socket.destroy();
        return;
      }
      admission.exposure = admission.exposure.then(() => this.expose(admission, new Set(message.ports)));
    });
    this.updatePolling();
    void this.refreshHostPorts().then(() => {
      if (admission.control !== socket) return;
      admission.synced = true;
      this.send(admission, { type: "hostPorts", ports: this.hostPorts });
    });
  }

  private attachReverse(socket: Socket, token: string, id: string, rest: Buffer) {
    const admission = this.admissions.get(token);
    const pending = admission?.pending.get(id);
    if (!admission || !pending) {
      socket.destroy();
      return;
    }
    clearTimeout(pending.timer);
    admission.pending.delete(id);
    splice(pending.socket, socket, rest);
  }

  private send(admission: Admission, message: BrokerMessage) {
    admission.control?.write(encodeBrokerMessage(message));
  }

  private updatePolling() {
    const connected = [...this.admissions.values()].some(admission => admission.control);
    if (connected && !this.stopPoll && !this.disposed) {
      this.stopPoll = (this.options.schedulePoll ?? scheduleInterval)(() => void this.refreshHostPorts());
    } else if (!connected && this.stopPoll) {
      this.stopPoll();
      this.stopPoll = null;
    }
  }

  /** Re-reads host listeners and pushes a changed set to every connected relay. */
  private refreshHostPorts() {
    this.refresh ??= (async () => {
      try {
        const read = await (this.options.readHostPorts ?? readListeningLoopbackPorts)();
        this.hostPortFailureReported = false;
        const ports = [...read].filter(port => port !== this.port).sort((left, right) => left - right);
        if (sameNumbers(ports, this.hostPorts)) return;
        this.hostPorts = ports;
        for (const admission of this.admissions.values()) {
          if (admission.synced) this.send(admission, { type: "hostPorts", ports });
        }
      } catch (error) {
        if (!this.hostPortFailureReported) this.reportError(`Reading host loopback listeners failed: ${describe(error)}`);
        this.hostPortFailureReported = true;
      }
    })().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  /** Makes this command's host listeners match the loopback ports it listens on inside its namespace. */
  private async expose(admission: Admission, ports: Set<number>) {
    for (const [port, servers] of admission.reverse) {
      if (ports.has(port)) continue;
      closeServers(servers);
      admission.reverse.delete(port);
    }
    for (const port of ports) {
      if (admission.reverse.has(port)) continue;
      const servers = await this.listenHost(port, socket => this.openReverse(admission, port, socket));
      if (!admission.control) {
        closeServers(servers);
        return;
      }
      if (servers.length) admission.reverse.set(port, servers);
    }
  }

  private async listenHost(port: number, onConnection: (socket: Socket) => void) {
    const servers: Server[] = [];
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, onConnection);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", error => this.reportError(`Sandbox port ${port} host listener failed: ${describe(error)}`));
        servers.push(server);
      } catch (error) {
        server.close();
        if (!EXPECTED_BIND_FAILURES.has((error as NodeJS.ErrnoException).code ?? "")) {
          this.reportError(`Exposing sandbox port ${port} on ${host} failed: ${describe(error)}`);
        }
      }
    }
    return servers;
  }

  /** Asks the relay to carry one host connection; it answers with an `accept` data connection. */
  private openReverse(admission: Admission, port: number, socket: Socket) {
    if (!admission.control) {
      socket.destroy();
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      admission.pending.delete(id);
      socket.destroy();
    }, REVERSE_ACCEPT_TIMEOUT_MS);
    admission.pending.set(id, { socket, timer });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (admission.pending.get(id)?.socket !== socket) return;
      clearTimeout(timer);
      admission.pending.delete(id);
    });
    this.send(admission, { type: "open", id, port });
  }

  private closeReverse(admission: Admission) {
    for (const servers of admission.reverse.values()) closeServers(servers);
    admission.reverse.clear();
    for (const { socket, timer } of admission.pending.values()) {
      clearTimeout(timer);
      socket.destroy();
    }
    admission.pending.clear();
  }

  private release(token: string) {
    const admission = this.admissions.get(token);
    if (!admission) return;
    this.admissions.delete(token);
    const control = admission.control;
    admission.control = null;
    control?.destroy();
    this.closeReverse(admission);
    this.updatePolling();
  }
}
