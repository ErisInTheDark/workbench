/*
 * Exports:
 * - WorkbenchServiceLauncherOptions: startup, publication, lease and observation boundaries.
 * - WorkbenchServiceLauncher (default): coalesces independent service startup and verified readiness.
 */
import path from "node:path";
import { watch } from "node:fs";
import WorkbenchProcessLease from "../../shared/process/WorkbenchProcessLease.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";
import WorkbenchServiceStartup from "./WorkbenchServiceStartup.ts";

export interface WorkbenchServiceLauncherOptions {
  root: string;
  endpointPath?: string;
  startup?: Pick<WorkbenchServiceStartup, "start" | "status">;
  read?: () => Promise<WorkbenchServiceEndpoint | null>;
  verify?: (endpoint: WorkbenchServiceEndpoint, signal: AbortSignal) => Promise<void>;
  acquire?: () => Promise<Pick<WorkbenchProcessLease, "dispose"> | null>;
  waitForChange?: (signal: AbortSignal) => Promise<void>;
  warn: (message: string) => void;
}

export default class WorkbenchServiceLauncher {
  private readonly endpointPath: string;
  private readonly startup: Pick<WorkbenchServiceStartup, "start" | "status">;
  private readonly lifetime = new AbortController();
  private task: Promise<WorkbenchServiceEndpoint> | null = null;

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
    const existing = await readReady();
    if (existing) return existing;
    let lease: Pick<WorkbenchProcessLease, "dispose"> | null = null;
    try {
      while (!lease) {
        signal.throwIfAborted();
        lease = await (this.options.acquire?.() ?? WorkbenchProcessLease.acquire(
          path.join(path.dirname(this.endpointPath), "startup-lease.sqlite3"),
        ));
        const appeared = await readReady();
        if (appeared) return appeared;
        if (!lease) await this.waitForChange(signal);
      }
      const previousGeneration = await this.startup.start();
      for (;;) {
        signal.throwIfAborted();
        const endpoint = await readReady();
        if (endpoint) return endpoint;
        const status = await this.startup.status();
        if (status.phase === "stopped" && status.generation !== previousGeneration) {
          throw new Error(`Workbench host stopped before readiness: ${status.result}. Inspect .workbench/logs/workbench-host-*.log.`);
        }
        await this.waitForChange(signal);
      }
    } finally {
      await lease?.dispose();
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
    if (this.task) {
      try { await this.task; }
      catch (error) { if (error !== cancellation) throw error; }
    }
  }
}
