/*
 * Exports:
 * - WorkbenchAgentCommandLiveScenarioControllerOptions: inject filesystem, process and retirement boundaries.
 * - default WorkbenchAgentCommandLiveScenarioController: own one allowlisted live scenario run and its bounded diagnostics.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  WORKBENCH_LIVE_SCENARIOS,
  WorkbenchLiveScenarioRequestSchema,
  type WorkbenchLiveScenarioRequest,
} from "./lib/workbench/commands/live-scenario-command-definition";
import { createSpawnOptions, killProcessTreeAsync } from "./process-helpers";
import WorkbenchTestProcessResources from "./WorkbenchTestProcessResources";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const OUTPUT_TRUNCATED = "\n[workbench live scenario output truncated]\n";

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

export default class WorkbenchAgentCommandLiveScenarioController {
  private active = false;
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

  async execute(input: object, signal: AbortSignal) {
    const request = WorkbenchLiveScenarioRequestSchema.parse(input);
    if (this.active) throw new Error("A live scenario is already running.");
    this.active = true;
    const cancellation = new AbortController();
    this.activeAbort = cancellation;
    const activeSignal = AbortSignal.any([signal, cancellation.signal]);
    try {
      const [root, cwd] = await Promise.all([this.readRealpath(this.projectRoot), this.readRealpath(request.cwd)]);
      if (!samePath(root, cwd)) throw new Error("Live scenarios only run from the Workbench repository root.");
      activeSignal.throwIfAborted();
      return await this.run(root, request, activeSignal);
    } finally {
      if (this.activeAbort === cancellation) this.activeAbort = null;
      this.active = false;
    }
  }

  cancel() {
    if (!this.activeAbort || this.activeAbort.signal.aborted) return false;
    this.activeAbort.abort(new Error("Live scenario cancelled."));
    return true;
  }

  private async run(root: string, request: WorkbenchLiveScenarioRequest, signal: AbortSignal) {
    const services = await WorkbenchTestProcessResources.create(false, root);
    try {
      return await this.runOwned(root, request, signal, services.environment);
    } finally {
      await services.dispose();
    }
  }

  private async runOwned(root: string, request: WorkbenchLiveScenarioRequest, signal: AbortSignal, environment: NodeJS.ProcessEnv) {
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
        capture(`\nLive scenario exited with code ${result.exitCode ?? "null"} and signal ${result.signal ?? "none"}.\n`);
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
