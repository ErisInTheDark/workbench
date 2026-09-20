/*
 * Exports:
 * - WorkbenchAgentCommandLiveTestControllerOptions: inject filesystem, process and retirement boundaries.
 * - default WorkbenchAgentCommandLiveTestController: own one allowlisted real-provider journey and its bounded diagnostics.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  WorkbenchLiveProviderTestRequestSchema,
  type WorkbenchLiveProviderTestRequest,
} from "./lib/workbench/commands/live-provider-test-command-definition";
import { createSpawnOptions, killProcessTreeAsync } from "./process-helpers";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const OUTPUT_TRUNCATED = "\n[workbench live-provider test output truncated]\n";

export interface WorkbenchAgentCommandLiveTestControllerOptions {
  realpath?: (value: string) => Promise<string>;
  retireProcess?: (pid: number | undefined) => Promise<void>;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

export default class WorkbenchAgentCommandLiveTestController {
  private active = false;
  private activeAbort: AbortController | null = null;
  private readonly readRealpath: NonNullable<WorkbenchAgentCommandLiveTestControllerOptions["realpath"]>;
  private readonly retireProcess: NonNullable<WorkbenchAgentCommandLiveTestControllerOptions["retireProcess"]>;
  private readonly spawnProcess: NonNullable<WorkbenchAgentCommandLiveTestControllerOptions["spawnProcess"]>;

  constructor(
    private readonly projectRoot: string,
    options: WorkbenchAgentCommandLiveTestControllerOptions = {},
  ) {
    this.readRealpath = options.realpath ?? realpath;
    this.retireProcess = options.retireProcess ?? killProcessTreeAsync;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async execute(input: object, signal: AbortSignal) {
    const request = WorkbenchLiveProviderTestRequestSchema.parse(input);
    if (this.active) throw new Error("A live provider test is already running.");
    this.active = true;
    const cancellation = new AbortController();
    this.activeAbort = cancellation;
    const activeSignal = AbortSignal.any([signal, cancellation.signal]);
    try {
      const [root, cwd] = await Promise.all([this.readRealpath(this.projectRoot), this.readRealpath(request.cwd)]);
      if (!samePath(root, cwd)) throw new Error("Live provider tests only run from the Workbench repository root.");
      activeSignal.throwIfAborted();
      return await this.run(root, request, activeSignal);
    } finally {
      if (this.activeAbort === cancellation) this.activeAbort = null;
      this.active = false;
    }
  }

  cancel() {
    if (!this.activeAbort || this.activeAbort.signal.aborted) return false;
    this.activeAbort.abort(new Error("Live provider test cancelled."));
    return true;
  }

  private async run(root: string, request: WorkbenchLiveProviderTestRequest, signal: AbortSignal) {
    const entry = path.join(root, "test", "run-live-provider-test.mjs");
    const child = this.spawnProcess(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      entry,
      request.provider,
      request.file,
    ], {
      ...createSpawnOptions(root, process.env, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0);
    let truncated = false;
    const capture = (chunk: Buffer | string) => {
      if (truncated) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - output.byteLength;
      if (next.byteLength <= remaining) {
        output = Buffer.concat([output, next]);
        return;
      }
      output = Buffer.concat([output, next.subarray(0, Math.max(0, remaining)), Buffer.from(OUTPUT_TRUNCATED)]);
      truncated = true;
    };
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
      const successful = result.exitCode === 0 && result.signal === null;
      if (!successful) {
        capture(`\nLive provider test exited with code ${result.exitCode ?? "null"} and signal ${result.signal ?? "none"}.\n`);
      }
      return new Response(output, {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        status: successful ? 200 : 400,
      });
    } finally {
      signal.removeEventListener("abort", abort);
      child.stdout?.removeListener("data", capture);
      child.stderr?.removeListener("data", capture);
    }
  }
}
