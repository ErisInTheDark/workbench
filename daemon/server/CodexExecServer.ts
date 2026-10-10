/*
 * Exports:
 * - CodexExecServerOptions: inject the owned process launch, retirement and termination-grace boundaries.
 * - CodexExecRootEvent: a command's sandboxed root process appeared, or the command settled.
 * - default CodexExecServer: retain one pinned native sandbox executor, isolate commands, stop them through the
 *   executor (an acknowledged terminate ends a command), terminate live commands before retiring, and report each
 *   command's root process so a later generation can reap what a hard kill left behind.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CodexExecMessageSchema, type CodexExecRequest, type CodexExecResult,
} from "./codex-exec-protocol";
import resolveCodexExecutable from "./codex-executable";
import { readExecRootMarker, withExecRootMarker } from "./exec/exec-root-marker";
import { createSpawnOptions, killProcessTreeAsync, logError, lowerAgentProcessPriority } from "./process-helpers";

const OUTPUT_BYTES = 1024 * 1024;
const FRAME_BYTES = 4 * 1024 * 1024;
/**
 * How long retirement waits for the executor to acknowledge terminating its live commands. Owner: `retire`. Reason:
 * a wedged executor must not block a reload or shutdown forever. Failure: warn and kill the executor tree anyway;
 * the next generation reaps any recorded roots that survive.
 */
const RETIREMENT_TERMINATION_GRACE_MS = 5_000;

export interface CodexExecServerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  retireProcess?: (pid: number | undefined) => Promise<void>;
  reportError?: (message: string) => void;
  /** Resolves when retirement should stop waiting for termination acknowledgements. */
  terminationGrace?: () => Promise<void>;
  platform?: NodeJS.Platform;
}

export type CodexExecRootEvent =
  /** `startedAt` is the root's start time in Windows FILETIME ticks, as text. */
  | { kind: "root"; processId: string; pid: number; startedAt: string }
  | { kind: "settled"; processId: string };

interface Command {
  completion: Promise<CodexExecResult>;
  stdout: Buffer[];
  stderr: Buffer[];
  bytes: number;
  truncated: boolean;
  exitCode?: number;
  /** Leading stderr held until it is known whether it starts with a root marker; null once decided. */
  markerScan: Buffer | null;
  /** Whether `process/start` was sent, so the executor can address this command. */
  addressable: boolean;
  resolve: (result: CodexExecResult) => void;
  reject: (error: Error) => void;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  closed: Promise<void>;
  requests: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  commands: Map<string, Command>;
  failure?: Error;
}

export default class CodexExecServer {
  /** Identifies this executor generation's commands in persisted root records. */
  readonly generation: string = randomUUID();
  private session?: Session;
  private retirement?: Promise<void>;
  private disposed = false;
  private admission = new AbortController();
  private requestId = 0;
  private readonly executions = new Set<Promise<unknown>>();
  private readonly rootListeners = new Set<(event: CodexExecRootEvent) => void>();
  private readonly reportError: (message: string) => void;

  constructor(private readonly options: CodexExecServerOptions) {
    this.reportError = options.reportError ?? (message => logError("codex-exec", message));
  }

  /** Listens for command root processes and settlements; returns a stop function. */
  onRoot(listener: (event: CodexExecRootEvent) => void) {
    this.rootListeners.add(listener);
    return () => { this.rootListeners.delete(listener); };
  }

  private emitRoot(event: CodexExecRootEvent) {
    for (const listener of this.rootListeners) {
      try { listener(event); }
      catch (error) { this.reportError(`Command root listener failed: ${String(error).slice(0, 300)}`); }
    }
  }

  private request(session: Session, method: string, params: object): Promise<unknown> {
    if (session.failure) return Promise.reject(session.failure);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      session.requests.set(id, { resolve, reject });
      session.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
        if (error) this.fail(session, error);
      });
    });
  }

  private fail(session: Session, error: Error) {
    if (session.failure) return;
    session.failure = error;
    for (const request of session.requests.values()) request.reject(error);
    session.requests.clear();
    for (const command of session.commands.values()) command.reject(error);
    session.commands.clear();
    this.reportError(error.message.slice(0, 500));
    void this.dispose().catch(retirementError => {
      this.reportError(`Codex executor retirement failed: ${String(retirementError).slice(0, 400)}`);
    });
  }

  /** Leading stderr may carry the shell's root marker; it is held until complete, then stripped and reported. */
  private acceptStderr(processId: string, command: Command, chunk: Buffer) {
    if (!command.markerScan) return chunk;
    const pending = Buffer.concat([command.markerScan, chunk]);
    const marker = readExecRootMarker(pending.toString("utf8"));
    if (marker.kind === "incomplete") {
      command.markerScan = pending;
      return Buffer.alloc(0);
    }
    command.markerScan = null;
    if (marker.kind === "absent") return pending;
    this.emitRoot({ kind: "root", processId, pid: marker.pid, startedAt: marker.startedAt });
    return Buffer.from(marker.rest, "utf8");
  }

  private capture(command: Command, stream: "stdout" | "stderr", chunk: Buffer) {
    const accepted = chunk.subarray(0, Math.max(0, OUTPUT_BYTES - command.bytes));
    command.bytes += accepted.byteLength;
    command.truncated ||= accepted.byteLength < chunk.byteLength;
    if (accepted.byteLength) (stream === "stderr" ? command.stderr : command.stdout).push(accepted);
  }

  private receive(session: Session, line: string) {
    const message = CodexExecMessageSchema.parse(JSON.parse(line));
    if ("id" in message) {
      const request = session.requests.get(message.id);
      if (!request) return;
      session.requests.delete(message.id);
      if ("error" in message) request.reject(new Error(`Codex executor: ${message.error.message.slice(0, 500)}`));
      else request.resolve(message.result);
      return;
    }
    const processId = message.params.processId;
    const command = session.commands.get(processId);
    if (!command) return;
    if (message.method === "process/output") {
      const chunk = Buffer.from(message.params.chunk, "base64");
      if (message.params.stream === "stderr") this.capture(command, "stderr", this.acceptStderr(processId, command, chunk));
      else this.capture(command, "stdout", chunk);
    } else if (message.method === "process/exited") {
      command.exitCode = message.params.exitCode;
    } else {
      session.commands.delete(processId);
      // A marker-shaped prefix that never completed is ordinary output.
      if (command.markerScan?.byteLength) this.capture(command, "stderr", command.markerScan);
      command.markerScan = null;
      if (command.exitCode === undefined) {
        command.reject(new Error("Codex executor closed a command without its exit status."));
      } else {
        command.resolve({
          exitCode: command.exitCode,
          stdout: Buffer.concat(command.stdout).toString("utf8"),
          stderr: Buffer.concat(command.stderr).toString("utf8") + (command.truncated ? "\n[command output truncated]\n" : ""),
        });
      }
    }
  }

  private start(): Session {
    if (this.disposed) throw new Error("Codex executor has been disposed.");
    if (this.session) return this.session;
    const child = this.options.spawnProcess?.() ?? spawn(resolveCodexExecutable(), ["exec-server", "--listen", "stdio"], {
      ...createSpawnOptions(this.options.cwd, this.options.env ?? process.env, true),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Sandboxed agent commands (builds, tests) descend from this executor.
    lowerAgentProcessPriority(child);
    const session: Session = {
      child, ready: Promise.resolve(), closed: Promise.resolve(),
      requests: new Map(), commands: new Map(),
    };
    this.session = session;
    session.closed = new Promise(resolve => {
      child.once("close", () => {
        if (!this.disposed) {
          this.fail(session, new Error("Codex executor connection closed; commands were not replayed."));
        }
        resolve();
      });
    });
    child.on("error", error => this.fail(session, error));
    child.stdin.on("error", error => this.fail(session, error));
    child.stdout.on("error", error => this.fail(session, error));
    child.stderr.on("error", error => this.fail(session, error));
    child.stderr.on("data", (chunk: Buffer) => this.reportError(chunk.toString("utf8").slice(0, 500)));
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (session.failure) return;
      pending += decoder.write(chunk);
      try {
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (Buffer.byteLength(line) > FRAME_BYTES) throw new Error("Codex executor exceeded its message size limit.");
          if (line.trim()) this.receive(session, line);
        }
        if (Buffer.byteLength(pending) > FRAME_BYTES) throw new Error("Codex executor exceeded its message size limit.");
      } catch (error) {
        this.fail(session, new Error("Invalid Codex executor message.", { cause: error }));
      }
    });
    session.ready = this.request(session, "initialize", { clientName: "workbench" }).then(result => {
      z.object({ sessionId: z.string() }).parse(result);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    }).catch(error => {
      this.fail(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return session;
  }

  execute(request: CodexExecRequest, callerSignal: AbortSignal): Promise<CodexExecResult> {
    const execution = this.run(request, callerSignal);
    const tracked = execution.then(() => undefined, () => undefined);
    this.executions.add(tracked);
    void tracked.finally(() => this.executions.delete(tracked));
    return execution;
  }

  private async run(request: CodexExecRequest, callerSignal: AbortSignal): Promise<CodexExecResult> {
    const signal = AbortSignal.any([callerSignal, this.admission.signal]);
    signal.throwIfAborted();
    const session = this.start();
    const cancelled = () => { rejectReadiness(signal.reason); };
    let rejectReadiness!: (reason: unknown) => void;
    const readiness = new Promise<never>((_resolve, reject) => { rejectReadiness = reject; });
    signal.addEventListener("abort", cancelled, { once: true });
    try { await Promise.race([session.ready, readiness]); }
    finally { signal.removeEventListener("abort", cancelled); }
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Codex executor has been disposed.");
    const processId = randomUUID();
    let resolveCommand!: Command["resolve"];
    let rejectCommand!: Command["reject"];
    const completion = new Promise<CodexExecResult>((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    const command: Command = {
      stdout: [], stderr: [], bytes: 0, truncated: false, completion, markerScan: Buffer.alloc(0), addressable: false,
      resolve: resolveCommand, reject: rejectCommand,
    };
    session.commands.set(processId, command);
    // A transport failure can settle completion before process/start responds.
    const outcome = completion.then(result => ({ result }), (error: unknown) => ({ error }));
    let abortReason: Error | undefined;
    let termination: Promise<void> | undefined;
    let acknowledgeStop!: () => void;
    // Resolves once the executor acknowledged terminating this command: the command is over, whatever follows.
    const stopped = new Promise<void>(resolve => { acknowledgeStop = resolve; });
    const terminate = () => {
      if (!command.addressable || !session.commands.has(processId)) return;
      termination ??= this.request(session, "process/terminate", { processId }).then(acknowledgeStop, error => {
        this.fail(session, new Error("Codex executor could not terminate an owned command.", { cause: error }));
      });
    };
    const abort = () => {
      abortReason = signal.reason instanceof Error ? signal.reason : new Error("Command cancelled.");
      terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    // This is the caller's requested command deadline, not executor readiness or idle expiry.
    const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
      abortReason = new Error(`Command exceeded its requested ${request.timeoutMs}ms deadline.`);
      terminate();
    }, request.timeoutMs);
    const stop = stopped.then((): never => { throw abortReason ?? new Error("Command cancelled."); });
    stop.catch(() => undefined);
    try {
      // Start and terminate share one ordered stream, so a sent start is already addressable.
      command.addressable = true;
      const started = this.request(session, "process/start", {
        processId, argv: withExecRootMarker(request.command, this.options.platform ?? process.platform), cwd: pathToFileURL(request.cwd).href,
        env: request.env ?? {}, tty: false, arg0: null,
        envPolicy: request.envPolicy ?? {
          inherit: "all", ignoreDefaultExcludes: true, exclude: [], set: {}, includeOnly: [],
        },
        sandbox: {
          permissions: request.permissions,
          cwd: pathToFileURL(request.cwd).href,
          workspaceRoots: request.workspaceRoots.map(root => pathToFileURL(root).href),
          windowsSandboxLevel: request.windowsSandboxLevel,
          windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
          useLegacyLandlock: request.useLegacyLandlock ?? false,
        },
      }).then(response => {
        if (!z.object({ processId: z.literal(processId) }).safeParse(response).success) {
          const error = new Error("Codex executor did not identify the admitted command.");
          this.fail(session, error);
          throw error;
        }
      });
      started.catch(() => undefined);
      if (abortReason) terminate();
      await Promise.race([started, stop]);
      const settled = await Promise.race([outcome, stop]);
      if (abortReason) throw abortReason;
      if ("error" in settled) throw settled.error;
      return settled.result;
    } catch (error) {
      session.commands.get(processId)?.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      session.commands.delete(processId);
      this.emitRoot({ kind: "settled", processId });
    }
  }

  /** Stops admitting commands and terminates every running one; resolves once each call has settled. */
  async cancelAll(reason: Error) {
    this.admission.abort(reason);
    await Promise.all([...this.executions]);
  }

  resume() {
    if (!this.disposed) this.admission = new AbortController();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.retirement ??= Promise.resolve().then(() => this.retire());
    return this.retirement;
  }

  private async retire() {
    const session = this.session;
    if (!session) return;
    // The sandbox runner owns each command's job; only it can end the command's tree, so ask before killing.
    const live = [...session.commands].filter(([, command]) => command.addressable).map(([processId]) => processId);
    if (live.length && !session.failure) {
      const acknowledged = Promise.allSettled(live.map(processId => this.request(session, "process/terminate", { processId })));
      const grace = (this.options.terminationGrace ?? (() => new Promise<void>(resolve => {
        setTimeout(resolve, RETIREMENT_TERMINATION_GRACE_MS).unref?.();
      })))().then(() => "grace" as const);
      if (await Promise.race([acknowledged.then(() => "acknowledged" as const), grace]) === "grace") {
        this.reportError(`Codex executor did not acknowledge terminating ${live.length} command(s) before retiring; killing its tree.`);
      }
    }
    const error = new Error("Codex executor is retiring.");
    for (const command of session.commands.values()) command.reject(error);
    session.commands.clear();
    for (const request of session.requests.values()) request.reject(error);
    session.requests.clear();
    session.failure ??= error;
    // Retire the complete owned tree, including commands still starting.
    if (session.child.exitCode === null && session.child.signalCode === null) {
      await (this.options.retireProcess ?? killProcessTreeAsync)(session.child.pid);
    }
    session.child.stdin.destroy();
    await session.closed;
  }
}
