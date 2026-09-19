/*
 * Exports:
 * - CodexExecServerOptions: inject the owned process launch and retirement boundaries.
 * - default CodexExecServer: retain one native sandbox executor, isolate commands and await retirement.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CodexExecMessageSchema, type CodexExecRequest, type CodexExecResult,
} from "./codex-exec-protocol";
import { createSpawnOptions, getSpawnDescriptor, killProcessTreeAsync, logError } from "./process-helpers";

const OUTPUT_BYTES = 1024 * 1024;
const FRAME_BYTES = 4 * 1024 * 1024;

export interface CodexExecServerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  retireProcess?: (pid: number | undefined) => Promise<void>;
  reportError?: (message: string) => void;
}

interface Command {
  completion: Promise<CodexExecResult>;
  stdout: Buffer[];
  stderr: Buffer[];
  bytes: number;
  truncated: boolean;
  exitCode?: number;
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
  private session?: Session;
  private retirement?: Promise<void>;
  private disposed = false;
  private admission = new AbortController();
  private requestId = 0;
  private readonly reportError: (message: string) => void;

  constructor(private readonly options: CodexExecServerOptions) {
    this.reportError = options.reportError ?? (message => logError("codex-exec", message));
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
    const command = session.commands.get(message.params.processId);
    if (!command) return;
    if (message.method === "process/output") {
      const chunk = Buffer.from(message.params.chunk, "base64");
      const accepted = chunk.subarray(0, Math.max(0, OUTPUT_BYTES - command.bytes));
      command.bytes += accepted.byteLength;
      command.truncated ||= accepted.byteLength < chunk.byteLength;
      if (accepted.byteLength) (message.params.stream === "stderr" ? command.stderr : command.stdout).push(accepted);
    } else if (message.method === "process/exited") {
      command.exitCode = message.params.exitCode;
    } else {
      session.commands.delete(message.params.processId);
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
    const descriptor = getSpawnDescriptor({
      command: "codex",
      args: ["exec-server", "--listen", "stdio"],
    });
    const child = this.options.spawnProcess?.() ?? spawn(descriptor.command, descriptor.args, {
      ...createSpawnOptions(this.options.cwd, this.options.env ?? process.env, true),
      stdio: ["pipe", "pipe", "pipe"],
    });
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

  async execute(request: CodexExecRequest, callerSignal: AbortSignal): Promise<CodexExecResult> {
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
    session.commands.set(processId, {
      stdout: [], stderr: [], bytes: 0, truncated: false, completion,
      resolve: resolveCommand, reject: rejectCommand,
    });
    // A transport failure can settle completion before process/start responds.
    const outcome = completion.then(result => ({ result }), error => ({ error }));
    let abortReason: Error | undefined;
    let termination: Promise<void> | undefined;
    let started = false;
    const terminate = () => {
      if (!started || !session.commands.has(processId)) return;
      termination ??= this.request(session, "process/terminate", { processId }).then(() => undefined).catch(error => {
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
    try {
      const response = await this.request(session, "process/start", {
        processId, argv: request.command, cwd: pathToFileURL(request.cwd).href,
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
      });
      const admitted = z.object({ processId: z.literal(processId) }).safeParse(response);
      if (!admitted.success) {
        const error = new Error("Codex executor did not identify the admitted command.");
        this.fail(session, error);
        throw error;
      }
      started = true;
      if (abortReason) terminate();
      const settled = await outcome;
      await termination;
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
    }
  }

  async cancelAll(reason: Error) {
    this.admission.abort(reason);
    await Promise.all([...(this.session?.commands.values() ?? [])].map(command => command.completion));
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
