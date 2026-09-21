/*
 * Exports:
 * - WorkbenchServiceOptions: independent host bootstrap and supervisor restart boundary.
 * - default WorkbenchService: own singleton publication, control sessions and daemon supervision.
 */
import { hostname } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import HttpServer from "../../shared/http/HttpServer.ts";
import WorkbenchProcessLease from "../../shared/process/WorkbenchProcessLease.ts";
import WorkbenchLocalDaemon from "../../shared/process/WorkbenchLocalDaemon.ts";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";
import { publishServiceEndpoint, removeServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import {
  WorkbenchServiceRequestSchema, type WorkbenchServiceEndpoint, type WorkbenchServiceRequest,
  type WorkbenchServiceResponse, type WorkbenchServiceSnapshot,
} from "../../shared/http/workbench-service.ts";
import type { WorkbenchDaemonIdentity } from "../../shared/http/workbench-daemon-discovery.ts";
import WorkbenchDaemonHost from "./WorkbenchDaemonHost.ts";
import WorkbenchServiceSessions from "./WorkbenchServiceSessions.ts";
import WorkbenchServiceRuntime from "./runtime/WorkbenchServiceRuntime.ts";

export interface WorkbenchServiceOptions {
  root: string;
  dataRoot?: string;
  session: string;
  warn(message: string): void;
  restart(fatal?: boolean): void;
}

export default class WorkbenchService {
  private readonly dataRoot: string;
  private readonly endpointPath: string;
  private readonly token = randomBytes(32).toString("hex");
  private readonly ingressToken = randomBytes(32).toString("hex");
  private readonly instanceId = randomUUID();
  private readonly sessions: WorkbenchServiceSessions;
  private readonly server: HttpServer;
  private readonly runtime: WorkbenchServiceRuntime;
  private readonly daemon: WorkbenchDaemonHost;
  private readonly standalone: WorkbenchLocalDaemon;
  private readonly controls = new WebSocketServer({ noServer: true, maxPayload: 262144, handleProtocols: protocols => protocols.has("workbench-service") ? "workbench-service" : false });
  private readonly abort = new AbortController();
  private endpoint: WorkbenchServiceEndpoint | null = null;
  private lease: WorkbenchProcessLease | null = null;
  private ready = false;
  private closing: Promise<void> | null = null;
  private readonly subscribers = new Set<() => void>();

  constructor(private readonly options: WorkbenchServiceOptions) {
    this.dataRoot = options.dataRoot ?? resolveWorkbenchDataRoot();
    this.endpointPath = path.join(this.dataRoot, "service", "runtime.json");
    this.sessions = new WorkbenchServiceSessions(() => {
      this.publish();
    });
    this.daemon = new WorkbenchDaemonHost({
      projectRootPath: options.root,
      environment: { ...process.env, WORKBENCH_DATA_ROOT: this.dataRoot, WORKBENCH_SERVICE_MANAGED: "1" },
      onFailure: async (error, beforeReady) => {
        if (beforeReady) await this.runtime.run("database", "record daemon startup failure", async database => database.failStartup(error.message));
        this.publish();
      },
      requestRestart: fatal => options.restart(fatal),
    });
    this.daemon.subscribe(() => this.publish());
    this.standalone = new WorkbenchLocalDaemon({
      endpointPath: path.join(this.dataRoot, "daemon", "runtime.json"), warn: options.warn,
    });
    this.standalone.subscribe(() => this.publish());
    this.runtime = new WorkbenchServiceRuntime({
      root: options.root, dataRoot: this.dataRoot, sessions: this.sessions,
      ingressToken: this.ingressToken, brokerOrigin: () => {
        if (!this.endpoint) throw new Error("Service listener is not bound.");
        return this.endpoint.origin;
      },
      daemonAvailable: () => Boolean(this.daemon.snapshot().endpoint ?? this.standalone.getSnapshot().endpoint),
      identity: () => this.identity(),
      daemonTarget: (signal, remote) => this.daemonTarget(signal, remote),
      publish: () => this.publish(), warn: options.warn,
      reload: scopes => this.runtime.reload(scopes), restart: () => options.restart(),
      control: (request, socket, head) => this.control(request, socket, head),
    });
    this.server = new HttpServer({
      hostname: "127.0.0.1", port: 0, onError: error => this.report(error),
      handleRequest: (request, response) => {
        if (request.url === "/healthz") {
          if (!this.ready || !this.authorised(request.headers.authorization?.replace(/^Bearer /u, ""))) {
            response.writeHead(403); response.end(); return;
          }
          const { token: _private, ...endpoint } = this.endpoint!;
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify(endpoint)); return;
        }
        if (!this.ready) { response.writeHead(503); response.end("Service is not ready."); return; }
        return this.runtime.handle(request, response);
      },
      handleUpgrade: (request, socket, head) => {
        if (!this.ready) { socket.destroy(); return; }
        return this.runtime.upgrade(request, socket, head);
      },
    });
  }

  async start() {
    this.lease = await WorkbenchProcessLease.acquire(path.join(this.dataRoot, "service", "process-lease.sqlite3"));
    if (!this.lease) throw new Error("Another Workbench host owns this installation.");
    try {
      const address = await this.server.start();
      this.endpoint = { version: 1, instanceId: this.instanceId, pid: process.pid, origin: address.url, token: this.token };
      await this.runtime.start();
      await this.standalone.start();
      this.ready = true;
      await publishServiceEndpoint(this.endpointPath, this.endpoint);
      if (this.runtime.get("database").shouldResume(this.options.session)) {
        void this.daemonTarget(this.abort.signal, false).catch(error => this.report(error));
      }
      return this.endpoint;
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Host startup and cleanup failed."); }
      throw error;
    }
  }

  identity(): WorkbenchDaemonIdentity {
    const database = this.runtime.get("database");
    const daemon = this.daemon.snapshot();
    const endpoint = daemon.endpoint ?? this.standalone.getSnapshot().endpoint;
    return {
      protocol: 1, daemonId: database.daemonId, hostname: hostname().slice(0, 253),
      wakeEnabled: database.wakeEnabled,
      state: endpoint ? "ready" : database.startupFailure ? "failed" : daemon.state === "stopped" ? "sleeping" : daemon.state,
    };
  }

  snapshot(): WorkbenchServiceSnapshot {
    return {
      identity: this.identity(), failure: this.runtime.get("database").startupFailure ?? this.daemon.snapshot().failure,
      daemonOrigin: this.daemon.snapshot().endpoint?.origin ?? this.standalone.getSnapshot().endpoint?.origin ?? null,
      network: this.runtime.get("network").snapshot(),
      discovery: this.runtime.get("network").discoverySnapshot(),
      reloadDirt: this.runtime.get("dirt").getSnapshot(),
    };
  }

  close() {
    if (this.closing) return this.closing;
    this.ready = false;
    this.abort.abort(new Error("Service is closing."));
    for (const socket of this.controls.clients) socket.terminate();
    this.closing = (async () => {
      const results = await Promise.allSettled([
        this.daemon.stop(), this.standalone.close(), this.runtime.close(),
        this.server.close({ force: true }),
        new Promise<void>((resolve, reject) => this.controls.close(error => error ? reject(error) : resolve())),
      ]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      try { if (this.endpoint) await removeServiceEndpoint(this.endpointPath, this.instanceId); }
      catch (error) { failures.push(error); }
      try { await this.lease?.dispose(); this.lease = null; }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Service shutdown failed.");
    })();
    return this.closing;
  }

  private async daemonTarget(signal: AbortSignal, remote: boolean) {
    signal.throwIfAborted();
    const existing = this.daemon.snapshot().endpoint ?? this.standalone.getSnapshot().endpoint;
    if (existing) return existing.origin;
    await this.runtime.run("database", "admit daemon wake", async database => {
      if (remote && !database.wakeEnabled) throw new Error("Remote daemon wake is disabled.");
      if (database.startupFailure) throw new Error(database.startupFailure);
      database.requestDaemon(this.options.session);
    });
    const ready = this.daemon.wake();
    // Caller cancellation never cancels the installation's shared startup.
    return new Promise<string>((resolve, reject) => {
      const cancelled = () => reject(signal.reason);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      void ready.then(endpoint => resolve(endpoint.origin), reject).finally(() => signal.removeEventListener("abort", cancelled));
    });
  }

  private control(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map(value => value.trim()) ?? [];
    if (!protocols.includes("workbench-service") || !protocols.some(value => this.authorised(value))) { socket.destroy(); return; }
    this.controls.handleUpgrade(request, socket, head, client => this.attach(client));
  }

  private attach(socket: WebSocket) {
    const session = this.sessions.open();
    const requests = new Map<string, AbortController>();
    const send = (response: WorkbenchServiceResponse) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response), error => { if (error) { this.report(error); socket.terminate(); } });
    };
    const changed = () => { if (this.ready) send({ kind: "snapshot", snapshot: this.snapshot() }); };
    this.subscribers.add(changed);
    changed();
    socket.on("error", error => this.report(error));
    socket.on("close", () => {
      this.subscribers.delete(changed);
      for (const abort of requests.values()) abort.abort(new Error("Control session disconnected."));
      const detached = session.close();
      if (detached && this.ready) void this.runtime.get("network").targetChanged().catch(error => this.report(error));
    });
    socket.on("message", bytes => {
      let request: WorkbenchServiceRequest;
      try { request = WorkbenchServiceRequestSchema.parse(JSON.parse(bytes.toString())); }
      catch { this.options.warn("Service control received an invalid request."); socket.close(1008, "Invalid control request."); return; }
      if (requests.has(request.id)) { socket.close(1008, "Duplicate request."); return; }
      if (request.method === "service/request/cancel") {
        requests.get(request.requestId)?.abort(new Error("Service request cancelled."));
        send({ kind: "ok", id: request.id }); return;
      }
      const abort = new AbortController();
      requests.set(request.id, abort);
      const run = async (): Promise<WorkbenchServiceResponse> => {
        if (request.method === "service/app/register") {
          session.register(request.registration);
          await this.runtime.run("network", "register app target", network => network.targetChanged());
          return { kind: "ok", id: request.id };
        }
        if (request.method === "service/reload") {
          const admitted = this.runtime.get("reload").admit(request.scopes);
          send({ kind: "ok", id: request.id });
          admitted.start();
          return { kind: "ok", id: request.id };
        }
        return this.execute(request, abort.signal);
      };
      void run().then(response => { if (!abort.signal.aborted && request.method !== "service/reload") send(response); }, error => {
        if (!abort.signal.aborted) {
          this.report(error);
          send({ kind: "error", id: request.id, message: error instanceof Error ? error.message.slice(0, 512) : "Service request failed." });
        }
      }).finally(() => requests.delete(request.id));
    });
  }

  private async execute(request: WorkbenchServiceRequest, signal: AbortSignal): Promise<WorkbenchServiceResponse> {
    switch (request.method) {
      case "service/status/read": break;
      case "service/daemon/wake":
        if (request.retry && this.runtime.get("database").startupFailure) {
          await this.runtime.run("database", "retry daemon startup", async database => database.requestDaemon(this.options.session));
          this.options.restart();
          break;
        }
        await this.daemonTarget(signal, false);
        break;
      case "service/wake/enable":
        await this.runtime.run("database", "set remote wake", async database => database.setWakeEnabled(request.enabled));
        await this.runtime.run("network", "reconcile wake publication", network => network.targetChanged());
        break;
      case "service/network/action":
        return { kind: "network-result", id: request.id,
          result: await this.runtime.run("network", "network action", network => network.action(request.action)) };
      case "service/network/settings":
        return { kind: "network-result", id: request.id,
          result: await this.runtime.run("network", "network settings", network => network.settings(request.mode, request.port)) };
      case "service/discovery/refresh":
        await this.runtime.run("network", "refresh daemon discovery", network => network.refreshDiscovery());
        break;
      default: throw new Error("Request requires its control-session owner.");
    }
    this.publish();
    return { kind: "ok", id: request.id };
  }

  private publish() {
    if (!this.ready || this.runtime.isReloading) return;
    for (const listener of this.subscribers) listener();
  }

  private authorised(token?: string) {
    return Boolean(token && /^[a-f0-9]{64}$/u.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(this.token)));
  }

  private report(error: unknown) {
    this.options.warn(error instanceof Error ? error.message.replace(/[\r\n]/gu, " ").slice(0, 512) : "Service operation failed.");
  }
}
