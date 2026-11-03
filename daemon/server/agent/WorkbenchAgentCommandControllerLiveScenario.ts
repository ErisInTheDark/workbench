/*
 * Exports:
 * - WorkbenchAgentCommandLiveScenarioControllerOptions: inject filesystem, process and retirement boundaries.
 * - default WorkbenchAgentCommandLiveScenarioController: run allowlisted live scenarios one at a time in arrival order, streaming
 *   each run's output (saying at once when it must wait) and ending it with its exit line.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { LiveScenarioExit } from "workbench-shared/workbench/commands/live-scenario-exit";
import {
  WORKBENCH_LIVE_SCENARIOS,
  WorkbenchLiveScenarioRequestSchema,
  type WorkbenchLiveScenarioRequest,
} from "../lib/workbench/commands/live-scenario-command-definition";
import { createSpawnOptions, killProcessTreeAsync } from "../process-helpers";
import WorkbenchTestProcessResources from "../runtime/WorkbenchTestProcessResources";

type Write = (chunk: Buffer | string) => void;

export interface WorkbenchAgentCommandLiveScenarioControllerOptions {
  realpath?: (value: string) => Promise<string>;
  retireProcess?: (pid: number | undefined) => Promise<void>;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

/** Settles with `operation`, or rejects as soon as `signal` aborts. */
function untilAborted(operation: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export default class WorkbenchAgentCommandLiveScenarioController {
  /** Settles once every run admitted so far has finished, including its service cleanup. */
  private tail: Promise<void> = Promise.resolve();
  /** Runs admitted and not yet finished, running or waiting. */
  private admitted = 0;
  private activeAbort: AbortController | null = null;
  private readonly readRealpath: NonNullable<WorkbenchAgentCommandLiveScenarioControllerOptions["realpath"]>;
  private readonly retireProcess: NonNullable<WorkbenchAgentCommandLiveScenarioControllerOptions["retireProcess"]>;
  private readonly spawnProcess: NonNullable<WorkbenchAgentCommandLiveScenarioControllerOptions["spawnProcess"]>;

  constructor(
    private readonly projectRoot: string,
    options: WorkbenchAgentCommandLiveScenarioControllerOptions = {},
  ) {
    this.readRealpath = options.realpath ?? realpath;
    this.retireProcess = options.retireProcess ?? killProcessTreeAsync;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  /**
   * Streams one run; its HTTP status is sent before the scenario runs, so the final exit line carries the result. A caller that
   * disconnects while queued leaves the queue without spawning.
   */
  execute(input: object, signal: AbortSignal) {
    const request = WorkbenchLiveScenarioRequestSchema.parse(input);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start: async stream => {
        const write: Write = chunk => {
          try { stream.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk)); }
          catch { /* The caller disconnected; its signal owns stopping the run. */ }
        };
        let exitCode = 1;
        try {
          exitCode = await this.queued(request, signal, write);
        } catch (error) {
          write(`\nLive scenario failed: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          write(LiveScenarioExit.format(exitCode));
          try { stream.close(); } catch { /* Already cancelled downstream. */ }
        }
      },
    }), { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }

  private async queued(request: WorkbenchLiveScenarioRequest, signal: AbortSignal, write: Write) {
    const [root, cwd] = await Promise.all([this.readRealpath(this.projectRoot), this.readRealpath(request.cwd)]);
    if (!samePath(root, cwd)) throw new Error("Live scenarios only run from the Workbench repository root.");
    const previous = this.tail;
    const turn = Promise.withResolvers<void>();
    this.tail = previous.then(() => turn.promise);
    try {
      if (this.admitted++ > 0) write("Another live scenario is running; this one waits for it to finish.\n");
      await untilAborted(previous, signal);
      const cancellation = new AbortController();
      this.activeAbort = cancellation;
      try {
        return await this.run(root, request, AbortSignal.any([signal, cancellation.signal]), write);
      } finally {
        if (this.activeAbort === cancellation) this.activeAbort = null;
      }
    } finally {
      this.admitted -= 1;
      turn.resolve();
    }
  }

  /** Cancels only the running scenario; queued ones still run after it. */
  cancel() {
    if (!this.activeAbort || this.activeAbort.signal.aborted) return false;
    this.activeAbort.abort(new Error("Live scenario cancelled."));
    return true;
  }

  private async run(root: string, request: WorkbenchLiveScenarioRequest, signal: AbortSignal, write: Write) {
    const services = await WorkbenchTestProcessResources.create(false, root);
    try {
      return await this.runOwned(root, request, signal, services.environment, write);
    } finally {
      await services.dispose();
    }
  }

  private async runOwned(
    root: string, request: WorkbenchLiveScenarioRequest, signal: AbortSignal, environment: NodeJS.ProcessEnv, write: Write,
  ) {
    const entry = path.join(root, WORKBENCH_LIVE_SCENARIOS[request.file].entry);
    const providers = "providers" in request
      ? Object.entries(request.providers).map(([provider, mode]) => `--${provider}=${mode}`)
      : [];
    const child = this.spawnProcess(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      entry,
      ...providers,
      request.file,
    ], {
      ...createSpawnOptions(root, { ...process.env, ...environment }, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: Buffer | string) => write(chunk);
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let retirement: Promise<void> | null = null;
    const abort = () => {
      retirement ??= this.retireProcess(child.pid);
      void retirement.catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, childSignal) => resolve({ exitCode, signal: childSignal }));
      });
      if (retirement) await retirement;
      signal.throwIfAborted();
      if (result.exitCode === 0 && result.signal === null) return 0;
      write(`\nLive scenario exited with code ${result.exitCode ?? "null"} and signal ${result.signal ?? "none"}.\n`);
      return result.exitCode || 1;
    } finally {
      signal.removeEventListener("abort", abort);
      child.stdout?.removeListener("data", capture);
      child.stderr?.removeListener("data", capture);
    }
  }
}
