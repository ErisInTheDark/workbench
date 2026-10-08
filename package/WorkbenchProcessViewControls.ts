/*
 * Exports:
 * - ProcessViewControlsSnapshot/ProcessViewControls: live host, daemon and app availability plus lifecycle intent.
 * - ProcessViewHostClient/ProcessViewAppClient: minimal seams each owner must satisfy.
 * - WorkbenchProcessViewControlsOptions: data, launch and test seams.
 * - default createWorkbenchProcessViewControls: compose host service, app control, desktop start and browser-open owners.
 */
import path from "node:path";
import WorkbenchDesktopLauncher from "../app/server/WorkbenchDesktopLauncher.ts";
import type { WorkbenchServiceResponse } from "../shared/http/workbench-service.ts";
import WorkbenchServiceClient from "../shared/process/WorkbenchServiceClient.ts";
import { openUrl } from "../shared/process/spawn-detached.ts";
import WorkbenchAppControlClient from "./WorkbenchAppControlClient.ts";

export interface ProcessViewControlsSnapshot {
  host: boolean;
  daemon: boolean;
  app: boolean;
}

export type ProcessViewHostIntent =
  | { method: "service/process/read" }
  | { method: "service/daemon/restart"; instanceId: string }
  | { method: "service/stop"; instanceId: string }
  | { method: "service/emergency/stop"; instanceId: string };

type ProcessViewHostResponse = Exclude<WorkbenchServiceResponse, { kind: "snapshot" }>;

export interface ProcessViewHostClient {
  start(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    phase: "idle" | "connecting" | "ready" | "failed" | "closed";
    snapshot: { identity: { state: "sleeping" | "starting" | "ready" | "failed" } } | null;
  };
  request(intent: ProcessViewHostIntent, signal?: AbortSignal): Promise<ProcessViewHostResponse>;
}

export interface ProcessViewAppClient {
  start(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { ready: boolean; instanceId: string | null };
  origin(): Promise<string>;
  quit(): Promise<void>;
}

export interface ProcessViewControls {
  snapshot(): ProcessViewControlsSnapshot;
  subscribe(listener: () => void): () => void;
  killDaemon(signal?: AbortSignal): Promise<void>;
  killHost(): Promise<void>;
  forceStopHost(): Promise<void>;
  killApp(): Promise<void>;
  startApp(): Promise<void>;
  openApp(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkbenchProcessViewControlsOptions {
  dataRoot: string;
  repositoryRoot: string;
  warn(message: string): void;
  createHostClient?: (options: { endpointPath: string; warn(message: string): void }) => ProcessViewHostClient;
  createAppClient?: (options: { endpointPath: string; warn(message: string): void }) => ProcessViewAppClient;
  startApp?: () => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
}

export default async function createWorkbenchProcessViewControls(
  options: WorkbenchProcessViewControlsOptions,
): Promise<ProcessViewControls> {
  const host = (options.createHostClient ?? (configuration => new WorkbenchServiceClient(configuration)))({
    endpointPath: path.join(options.dataRoot, "service", "runtime.json"),
    warn: options.warn,
  });
  const app = (options.createAppClient ?? (configuration => new WorkbenchAppControlClient(configuration)))({
    endpointPath: path.join(options.dataRoot, "app", "runtime.json"),
    warn: options.warn,
  });
  const startApp = options.startApp
    ?? (() => new WorkbenchDesktopLauncher({ repositoryRootPath: options.repositoryRoot }).start());
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const unsubscribeHost = host.subscribe(notify);
  const unsubscribeApp = app.subscribe(notify);
  let closed = false;

  const snapshot = (): ProcessViewControlsSnapshot => {
    const current = host.getSnapshot();
    return {
      host: current.phase === "ready",
      daemon: current.phase === "ready" && current.snapshot?.identity.state === "ready",
      app: app.getSnapshot().ready,
    };
  };

  const requireHost = async () => {
    if (host.getSnapshot().phase !== "ready") throw new Error("The Workbench host is not running, so that control is unavailable.");
    const info = await host.request({ method: "service/process/read" });
    if (info.kind !== "process") throw new Error("The Workbench host did not report its process identity.");
    return info.instanceId;
  };

  // A missing publication is an expected startup state that the host client already reported.
  const [, appStart] = await Promise.allSettled([host.start(), app.start()]);
  if (appStart.status === "rejected" && !closed) {
    options.warn(appStart.reason instanceof Error ? appStart.reason.message : String(appStart.reason));
  }

  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async killDaemon(signal) {
      await host.request({ method: "service/daemon/restart", instanceId: await requireHost() }, signal);
    },
    async killHost() {
      await host.request({ method: "service/stop", instanceId: await requireHost() });
    },
    async forceStopHost() {
      await host.request({ method: "service/emergency/stop", instanceId: await requireHost() });
    },
    async killApp() {
      if (!app.getSnapshot().ready) throw new Error("The Workbench app is not running, so that control is unavailable.");
      await app.quit();
    },
    async startApp() {
      if (app.getSnapshot().ready) throw new Error("The Workbench app is already running.");
      await startApp();
    },
    async openApp() {
      if (!app.getSnapshot().ready) throw new Error("The Workbench app is not running, so that control is unavailable.");
      await (options.openUrl ?? openUrl)(await app.origin());
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribeHost();
      unsubscribeApp();
      listeners.clear();
      const results = await Promise.allSettled([host.close(), app.close()]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Process view controls cleanup failed.");
    },
  };
}
