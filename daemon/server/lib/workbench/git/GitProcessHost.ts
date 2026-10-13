/*
 * Exports:
 * - GitProcessError: a git command that exited unsuccessfully, carrying exit code, signal and output like `execFile`.
 * - GitProcessRunOptions/GitProcessResult: one buffered git command and its output.
 * - GitWorkerProcess: a streaming git process whose spawning and I/O happen off the event loop.
 * - GitProcessWorkerRequest/GitProcessWorkerEvent: the worker message protocol.
 * - default GitProcessHost: run every git subprocess from one worker thread with bounded concurrency; `gitProcesses` is
 *   the daemon's host.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SHARE_ENV, Worker } from "node:worker_threads";

/** Differences from the daemon's environment; `null` removes a variable. Most commands send none. */
export type GitProcessEnvironmentDelta = Record<string, string | null>;

export type GitProcessWorkerRequest =
  | { kind: "run"; id: number; args: string[]; cwd: string; env: GitProcessEnvironmentDelta; input: string | Uint8Array | null; maxBuffer: number }
  | { kind: "open"; id: number; args: string[]; cwd: string; env: GitProcessEnvironmentDelta }
  | { kind: "write"; id: number; data: string | Uint8Array }
  | { kind: "end"; id: number }
  | { kind: "kill"; id: number };

export type GitProcessWorkerEvent =
  | { kind: "result"; id: number; code: number | null; signal: NodeJS.Signals | null; overflow: boolean; stdout: Uint8Array; stderr: string }
  | { kind: "spawnError"; id: number; message: string }
  | { kind: "stdout" | "stderr"; id: number; data: Uint8Array }
  | { kind: "stdinError"; id: number; message: string }
  | { kind: "close"; id: number; code: number | null; signal: NodeJS.Signals | null };

export interface GitProcessRunOptions {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface GitProcessResult {
  stdout: Buffer;
  stderr: string;
}

export class GitProcessError extends Error {
  readonly code: number | string | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, details: { code: number | string | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string }) {
    super(message);
    this.name = "GitProcessError";
    this.code = details.code;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

/** The `ChildProcess` surface streaming callers use; data and lifecycle arrive from the worker. */
export class GitWorkerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(private readonly onKill: () => void) {
    super();
  }

  kill() {
    this.onKill();
    return true;
  }
}

interface Queued {
  options: GitProcessRunOptions;
  resolve: (result: GitProcessResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 8;
/** An idle worker exits, so no process or retired reload generation keeps one alive. */
const IDLE_SHUTDOWN_MS = 30_000;
const WORKER_URL = new URL("./git-process-worker-bootstrap.mjs", import.meta.url);

/** Sends only what differs from the daemon environment instead of cloning the whole environment per command. */
function environmentDelta(env: NodeJS.ProcessEnv | undefined): GitProcessEnvironmentDelta {
  if (!env || env === process.env) return {};
  const delta: GitProcessEnvironmentDelta = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && process.env[key] !== value) delta[key] = value;
  for (const key of Object.keys(process.env)) if (env[key] === undefined) delta[key] = null;
  return delta;
}

/** The same shape `execFile` rejects with: an AbortError whose cause is the abort reason. */
function abortError(signal: AbortSignal) {
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
    code: "ABORT_ERR", name: "AbortError",
  });
}

export default class GitProcessHost {
  readonly #queue: Queued[] = [];
  readonly #runs = new Map<number, { resolve: (event: GitProcessWorkerEvent) => void }>();
  readonly #streams = new Map<number, GitWorkerProcess>();
  readonly #concurrency: number;
  readonly #createWorker: () => Worker;
  #worker: Worker | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #nextId = 0;
  #active = 0;

  // SHARE_ENV keeps the worker's environment the daemon's own, so commands only send their differences.
  constructor({ concurrency = DEFAULT_CONCURRENCY, createWorker = () => new Worker(WORKER_URL, { env: SHARE_ENV }) }: {
    concurrency?: number;
    createWorker?: () => Worker;
  } = {}) {
    this.#concurrency = concurrency;
    this.#createWorker = createWorker;
  }

  /** Runs one git command to completion; rejects like `execFile` when it exits unsuccessfully. */
  run(options: GitProcessRunOptions): Promise<GitProcessResult> {
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    return new Promise((resolve, reject) => {
      this.#queue.push({ options, resolve, reject });
      this.#pump();
    });
  }

  async runText(options: GitProcessRunOptions) {
    return (await this.run(options)).stdout.toString("utf8");
  }

  /** Starts a long-lived streaming git process; it does not take a concurrency slot. */
  open({ args, cwd, env = process.env }: { args: string[]; cwd: string; env?: NodeJS.ProcessEnv }): GitWorkerProcess {
    const worker = this.#ensureWorker();
    const id = ++this.#nextId;
    const child = new GitWorkerProcess(() => worker.postMessage({ kind: "kill", id } satisfies GitProcessWorkerRequest));
    child.stdin.on("data", (data: Buffer | string) => worker.postMessage({
      kind: "write", id, data: typeof data === "string" ? data : new Uint8Array(data),
    } satisfies GitProcessWorkerRequest));
    child.stdin.on("finish", () => worker.postMessage({ kind: "end", id } satisfies GitProcessWorkerRequest));
    this.#streams.set(id, child);
    worker.postMessage({ kind: "open", id, args, cwd, env: environmentDelta(env) } satisfies GitProcessWorkerRequest);
    return child;
  }

  /** Stops the worker; queued and running commands fail, and the next use starts a fresh worker. */
  async dispose() {
    const worker = this.#worker;
    this.#worker = null;
    this.#clearIdle();
    const failure = new Error("The git process host was disposed.");
    for (const queued of this.#queue.splice(0)) queued.reject(failure);
    for (const [id, run] of this.#runs) run.resolve({ kind: "spawnError", id, message: failure.message });
    for (const [id, stream] of this.#streams) this.#closeStream(id, stream, null, null, failure);
    await worker?.terminate();
  }

  #pump() {
    while (this.#active < this.#concurrency && this.#queue.length) {
      const queued = this.#queue.shift()!;
      const { signal } = queued.options;
      if (signal?.aborted) {
        queued.reject(abortError(signal));
        continue;
      }
      this.#active += 1;
      void this.#start(queued).finally(() => {
        this.#active -= 1;
        this.#pump();
        this.#scheduleIdle();
      });
    }
  }

  async #start({ options, resolve, reject }: Queued) {
    const worker = this.#ensureWorker();
    const id = ++this.#nextId;
    const onAbort = () => worker.postMessage({ kind: "kill", id } satisfies GitProcessWorkerRequest);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const event = await new Promise<GitProcessWorkerEvent>(settle => {
      this.#runs.set(id, { resolve: settle });
      worker.postMessage({
        kind: "run", id, args: options.args, cwd: options.cwd, env: environmentDelta(options.env),
        input: options.input ?? null, maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      } satisfies GitProcessWorkerRequest);
    });
    this.#runs.delete(id);
    options.signal?.removeEventListener("abort", onAbort);
    const command = `git ${options.args.join(" ")}`.slice(0, 300);
    if (options.signal?.aborted) {
      reject(abortError(options.signal));
      return;
    }
    if (event.kind === "spawnError") {
      reject(new GitProcessError(`Failed to run ${command}: ${event.message}`, { code: null }));
      return;
    }
    if (event.kind !== "result") throw new Error(`Unexpected git worker event ${event.kind}.`);
    const stdout = Buffer.from(event.stdout.buffer, event.stdout.byteOffset, event.stdout.byteLength);
    if (event.overflow) {
      reject(new GitProcessError(`${command} exceeded its output buffer.`, {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: event.stderr,
      }));
      return;
    }
    if (event.code !== 0) {
      reject(new GitProcessError(`Command failed: ${command}\n${event.stderr}`, {
        code: event.code, signal: event.signal, stdout: stdout.toString("utf8"), stderr: event.stderr,
      }));
      return;
    }
    resolve({ stdout, stderr: event.stderr });
  }

  #ensureWorker() {
    this.#clearIdle();
    if (this.#worker) return this.#worker;
    const worker = this.#createWorker();
    worker.unref();
    worker.on("message", (event: GitProcessWorkerEvent) => this.#receive(event));
    const lost = (error: Error) => {
      if (this.#worker !== worker) return;
      this.#worker = null;
      console.error(`[git-process-host] worker stopped: ${error.message.slice(0, 300)}`);
      for (const [id, run] of this.#runs) run.resolve({ kind: "spawnError", id, message: error.message });
      for (const [id, stream] of this.#streams) this.#closeStream(id, stream, null, null, error);
    };
    worker.on("error", lost);
    worker.on("exit", code => lost(new Error(`Git process worker exited with code ${code}.`)));
    this.#worker = worker;
    return worker;
  }

  #receive(event: GitProcessWorkerEvent) {
    const run = this.#runs.get(event.id);
    if (run && (event.kind === "result" || event.kind === "spawnError")) {
      run.resolve(event);
      return;
    }
    const stream = this.#streams.get(event.id);
    if (!stream) return;
    if (event.kind === "stdout" || event.kind === "stderr") {
      stream[event.kind].write(Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength));
    } else if (event.kind === "stdinError") {
      stream.stdin.emit("error", new Error(event.message));
    } else if (event.kind === "spawnError") {
      this.#closeStream(event.id, stream, null, null, new Error(event.message));
    } else if (event.kind === "close") {
      this.#closeStream(event.id, stream, event.code, event.signal);
    }
  }

  #closeStream(id: number, stream: GitWorkerProcess, code: number | null, signal: NodeJS.Signals | null, error?: Error) {
    if (!this.#streams.delete(id)) return;
    if (error) stream.emit("error", error);
    stream.stdout.end();
    stream.stderr.end();
    stream.emit("exit", code, signal);
    stream.emit("close", code, signal);
    this.#scheduleIdle();
  }

  #scheduleIdle() {
    if (this.#active || this.#queue.length || this.#streams.size || !this.#worker || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#active || this.#queue.length || this.#streams.size) return;
      const worker = this.#worker;
      this.#worker = null;
      void worker?.terminate();
    }, IDLE_SHUTDOWN_MS);
    this.#idleTimer.unref();
  }

  #clearIdle() {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}

export const gitProcesses = new GitProcessHost();
