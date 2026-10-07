/*
 * Exports:
 * - WorkbenchServiceLauncherOptions: startup, publication, lease and observation boundaries.
 * - WorkbenchServiceLauncher (default): coalesces independent service startup and verified readiness, narrating progress and platform output.
 */
import path from "node:path";
import { watch } from "node:fs";
import WorkbenchProcessLease from "../../shared/process/WorkbenchProcessLease.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";
import WorkbenchServiceStartup from "./WorkbenchServiceStartup.ts";

type LauncherStartup = Pick<WorkbenchServiceStartup, "start" | "status"> & Partial<Pick<WorkbenchServiceStartup, "recentOutput">>;

export interface WorkbenchServiceLauncherOptions {
  root: string;
  endpointPath?: string;
  startup?: LauncherStartup;
  read?: () => Promise<WorkbenchServiceEndpoint | null>;
  verify?: (endpoint: WorkbenchServiceEndpoint, signal: AbortSignal) => Promise<void>;
  acquire?: () => Promise<Pick<WorkbenchProcessLease, "dispose"> | null>;
  waitForChange?: (signal: AbortSignal) => Promise<void>;
  warn: (message: string) => void;
  /** Startup progress, so a slow or stuck launch shows its last reached step; failures still use `warn` or rejection. */
  log?: (message: string) => void;
}

export default class WorkbenchServiceLauncher {
  private readonly endpointPath: string;
  private readonly startup: LauncherStartup;
  private readonly lifetime = new AbortController();
  private task: Promise<WorkbenchServiceEndpoint> | null = null;
  private reportedOutput: string | null = null;

  constructor(private readonly options: WorkbenchServiceLauncherOptions) {
    this.endpointPath = options.endpointPath ?? path.join(resolveWorkbenchDataRoot(), "service", "runtime.json");
    this.startup = options.startup ?? new WorkbenchServiceStartup({ root: options.root });
  }

  ensure(signal?: AbortSignal): Promise<WorkbenchServiceEndpoint> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.lifetime.signal.aborted) return Promise.reject(this.lifetime.signal.reason);
    if (!this.task) {
      this.task = this.ensureOwned().finally(() => { this.task = null; });
    }
    const task = this.task;
    if (!signal) return task;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async ensureOwned() {
    const signal = this.lifetime.signal;
    let lastVerificationFailure: string | null = null;
    const readReady = async () => {
      signal.throwIfAborted();
      const endpoint = await (this.options.read?.() ?? readServiceEndpoint(this.endpointPath));
      if (!endpoint) return null;
      try {
        await (this.options.verify ?? verifyServiceEndpoint)(endpoint, signal);
        return endpoint;
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message.slice(0, 512) : "Service publication could not be verified.";
        if (message !== lastVerificationFailure) this.options.warn(message);
        lastVerificationFailure = message;
        return null;
      }
    };
    const log = (message: string) => this.options.log?.(message);
    const ready = (endpoint: WorkbenchServiceEndpoint, phrase: string) => {
      log(`host ${phrase} at ${endpoint.origin}`);
      return endpoint;
    };
    const existing = await readReady();
    if (existing) return ready(existing, "already running");
    let lease: Pick<WorkbenchProcessLease, "dispose"> | null = null;
    let waitingForLease = false;
    try {
      while (!lease) {
        signal.throwIfAborted();
        lease = await (this.options.acquire?.() ?? WorkbenchProcessLease.acquire(
          path.join(path.dirname(this.endpointPath), "startup-lease.sqlite3"),
        ));
        const appeared = await readReady();
        if (appeared) return ready(appeared, "ready");
        if (!lease) {
          if (!waitingForLease) log("another Workbench process holds the host startup lease; waiting for its publication");
          waitingForLease = true;
          await this.waitForChange(signal);
        }
      }
      log(`no ready host publication at ${this.endpointPath}; starting the Workbench host`);
      let previousGeneration: string;
      try { previousGeneration = await this.startup.start(); }
      catch (error) {
        await this.reportRecentOutput();
        throw error;
      }
      log("host start requested");
      let observed: string | null = null;
      for (;;) {
        signal.throwIfAborted();
        const endpoint = await readReady();
        if (endpoint) return ready(endpoint, "ready");
        const status = await this.startup.status();
        // Each change is logged, so a supervisor restart loop appears as one line per run.
        const key = `${status.generation}\n${status.phase}\n${status.result}`;
        if (key !== observed) {
          observed = key;
          log(`host ${status.phase} (run ${status.generation}, result ${status.result}); waiting for publication at ${this.endpointPath}`);
        }
        if (status.phase === "stopped" && status.generation !== previousGeneration) {
          await this.reportRecentOutput();
          const logs = path.join(path.resolve(this.options.root), ".workbench", "logs", "workbench-host-*.log");
          throw new Error(`Workbench host stopped before readiness: ${status.result}. Inspect ${logs}.`);
        }
        await this.waitForChange(signal);
      }
    } finally {
      await lease?.dispose();
    }
  }

  /** Platform output explains failures the host never lived long enough to log; the startup failure stays primary. */
  private async reportRecentOutput() {
    let output: string | null;
    try { output = await this.startup.recentOutput?.() ?? null; }
    catch (error) {
      this.options.warn(`recent host output unavailable: ${error instanceof Error ? error.message.slice(0, 512) : String(error)}`);
      return;
    }
    // Relaunch backoff repeats the same failure; repeat its context only when it changes.
    if (output === this.reportedOutput) return;
    this.reportedOutput = output;
    for (const line of output?.split("\n") ?? []) {
      if (line.trim()) this.options.warn(`host output: ${line.slice(0, 512)}`);
    }
  }

  private waitForChange(signal: AbortSignal) {
    if (this.options.waitForChange) return this.options.waitForChange(signal);
    // This bounded-frequency observation exists only during startup. OS run state
    // provides failure evidence even when the child never publishes an endpoint.
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const watcher = watch(path.dirname(this.endpointPath));
      const timer = setTimeout(() => finish(), 1_000);
      const abort = () => finish(signal.reason);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        watcher.close();
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      watcher.on("change", (_event, file) => {
        if (!file || file.toString() === path.basename(this.endpointPath)) finish();
      });
      watcher.on("error", finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async close() {
    const cancellation = new Error("Service startup observation closed.");
    this.lifetime.abort(cancellation);
    const task = this.task;
    if (!task) return;
    try { await task; }
    catch (error) {
      // Closing is not the owner of startup readiness: the `ensure` caller already saw and
      // reported this failure. A dying host must never block the app's own clean exit.
      if (error !== cancellation) this.options.warn(error instanceof Error ? error.message : String(error));
    }
  }
}
