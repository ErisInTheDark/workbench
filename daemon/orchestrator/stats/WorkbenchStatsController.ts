/*
 * Exports:
 * - WorkbenchStatsControllerOptions: database, harness, and warning ports for the reloadable stats owner. Keywords: stats, controller, lifecycle.
 * - default WorkbenchStatsController: own background import startup, ordered capture, rate refresh, bounded failures, reads, and disposal. Keywords: stats, tokens, claims, rate limits.
 * Local helpers: parse provider-owned rate snapshots at the bridge boundary. Keywords: rate limits, provider, parser.
 */
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../bridge-types.ts";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsReadRequest } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchRateLimitObservation } from "../database/stats/WorkbenchStatsRepository.ts";
import type { WorkbenchGitClaimSnapshot } from "./git-claim-observation.ts";
import WorkbenchStatsImportController, { type WorkbenchStatsImportControllerOptions } from "./WorkbenchStatsImportController.ts";

export interface WorkbenchStatsControllerOptions {
  claims: WorkbenchStatsImportControllerOptions["claims"];
  database: {
    addStatsClaimDiscoveries: WorkbenchStatsImportControllerOptions["database"]["addStatsClaimDiscoveries"];
    beginStatsImport: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["database"]["beginStatsImport"];
    claimStatsClaimImport: WorkbenchStatsImportControllerOptions["database"]["claimStatsClaimImport"];
    claimStatsUsageImport: WorkbenchStatsImportControllerOptions["database"]["claimStatsUsageImport"];
    readStatsImportProgress: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["database"]["readStatsImportProgress"];
    readStats(request: WorkbenchStatsReadRequest): Promise<import("workbench-shared/workbench/stats/workbench-stats-contract").WorkbenchStatsResponse>;
    recordStatsClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot): Promise<void>;
    recordStatsRateLimits(observation: WorkbenchRateLimitObservation): Promise<void>;
    repairStatsAttributions: WorkbenchStatsImportControllerOptions["database"]["repairStatsAttributions"];
    settleStatsClaimImport: WorkbenchStatsImportControllerOptions["database"]["settleStatsClaimImport"];
    settleStatsUsageImport: WorkbenchStatsImportControllerOptions["database"]["settleStatsUsageImport"];
  };
  harnesses: {
    hydrateUsage: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["harnesses"]["hydrateUsage"];
    listHarnesses(): WorkbenchHarness[];
    listUsageHydrationHarnesses: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["harnesses"]["listUsageHydrationHarnesses"];
    request(harness: WorkbenchHarness, request: JsonRpcRequest): Promise<JsonRpcResponse>;
  };
  log?(message: string): void;
}

function record(value: object | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, object | string | number | boolean | null | undefined> : null;
}

function rateWindow(value: object | string | number | boolean | null | undefined) {
  const candidate = record(typeof value === "object" ? value : null);
  if (!candidate || typeof candidate.usedPercent !== "number" || !Number.isFinite(candidate.usedPercent)) return null;
  return {
    durationMinutes: typeof candidate.windowDurationMins === "number" && Number.isFinite(candidate.windowDurationMins)
      ? Math.max(0, candidate.windowDurationMins)
      : null,
    resetsAt: typeof candidate.resetsAt === "number" && Number.isFinite(candidate.resetsAt)
      ? Math.max(0, candidate.resetsAt * 1_000)
      : null,
    usedPercent: Math.min(100, Math.max(0, candidate.usedPercent)),
  };
}

function rateSnapshot(value: object | string | number | boolean | null | undefined, fallbackId = "default") {
  const candidate = record(typeof value === "object" ? value : null);
  if (!candidate) return null;
  return {
    limitId: typeof candidate.limitId === "string" && candidate.limitId.trim() ? candidate.limitId : fallbackId,
    limitName: typeof candidate.limitName === "string" && candidate.limitName.trim() ? candidate.limitName : null,
    primary: rateWindow(candidate.primary),
    secondary: rateWindow(candidate.secondary),
  };
}

function responseRateSnapshots(result: object | null | undefined) {
  const candidate = record(result);
  if (!candidate) return [];
  const byId = record(typeof candidate.rateLimitsByLimitId === "object" ? candidate.rateLimitsByLimitId : null);
  const snapshots = byId
    ? Object.entries(byId).flatMap(([id, value]) => {
      const parsed = rateSnapshot(value, id);
      return parsed ? [parsed] : [];
    })
    : [];
  const primary = rateSnapshot(candidate.rateLimits);
  if (primary && !snapshots.some(({ limitId }) => limitId === primary.limitId)) snapshots.push(primary);
  return snapshots;
}

export default class WorkbenchStatsController {
  private active = true;
  private failures: Array<{ harness: string | null; message: string; source: "capture" | "refresh" }> = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly importer: WorkbenchStatsImportController;

  constructor(private readonly options: WorkbenchStatsControllerOptions) {
    this.importer = new WorkbenchStatsImportController({
      claims: options.claims,
      database: options.database,
      harnesses: options.harnesses,
      reportFailure: (error) => {
        this.reportFailure(
          null,
          `history import stopped: ${error instanceof Error ? error.message : String(error)}`,
          "capture",
        );
      },
    });
  }

  start() {
    void this.importer.start().catch((error) => {
      this.reportCaptureFailure(null, "history import startup", error);
    });
  }

  startImport() { return this.importer.start(); }
  subscribeImportProgress(listener: Parameters<WorkbenchStatsImportController["subscribe"]>[0]) {
    return this.importer.subscribe(listener);
  }

  observeClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot) {
    this.enqueue(snapshot.harness, "claim snapshot", () => this.options.database.recordStatsClaimSnapshot(snapshot));
  }

  observeProviderNotification(harness: WorkbenchHarness, notification: JsonRpcNotification) {
    if (notification.method !== "account/rateLimits/updated") return;
    const params = record(notification.params as object | null);
    const snapshot = rateSnapshot(params?.rateLimits);
    if (snapshot) this.recordRateLimits({ harness, observedAt: Date.now(), snapshots: [snapshot] });
  }

  async refreshRateLimits() {
    const harnesses = this.options.harnesses.listHarnesses();
    const results = await Promise.allSettled(harnesses.map(async (harness) => {
      const response = await this.options.harnesses.request(harness, {
        id: `workbench-stats:${harness}:${Date.now()}`,
        method: "account/rateLimits/read",
        params: undefined,
      });
      if (response.error) throw new Error(response.error.message);
      const snapshots = responseRateSnapshots(response.result as object | null);
      if (snapshots.length) this.recordRateLimits({ harness, observedAt: Date.now(), snapshots });
    }));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const harness = harnesses[index] ?? null;
      this.reportFailure(harness, result.reason instanceof Error ? result.reason.message : "Rate-limit refresh failed.", "refresh");
    });
    await this.queue;
  }

  async read(request: WorkbenchStatsReadRequest) {
    await this.queue;
    const result = await this.options.database.readStats(request);
    const currentProgress = this.importer.getProgress();
    const historyImport = await this.options.database.readStatsImportProgress(
      currentProgress.state,
      currentProgress.revision,
      currentProgress.unsupportedClaimCheckpoints,
    );
    return {
      ...result,
      failures: [...result.failures, ...this.failures].slice(-20),
      historyImport,
    };
  }

  async dispose() {
    this.active = false;
    await this.importer.dispose();
    await this.queue;
  }

  reportCaptureFailure(harness: string | null, label: string, error: unknown) {
    this.reportFailure(harness, `${label} capture failed: ${error instanceof Error ? error.message : String(error)}`, "capture");
  }

  private recordRateLimits(observation: WorkbenchRateLimitObservation) {
    this.enqueue(observation.harness, "rate limits", () => this.options.database.recordStatsRateLimits(observation));
  }

  private enqueue(harness: string | null, label: string, operation: () => Promise<void>) {
    if (!this.active) return;
    this.queue = this.queue.then(operation).catch((error) => {
      this.reportFailure(harness, `${label} capture failed: ${error instanceof Error ? error.message : String(error)}`, "capture");
    });
  }

  private reportFailure(harness: string | null, message: string, source: "capture" | "refresh") {
    const bounded = message.replaceAll(/[\r\n]+/gu, " ").slice(0, 500);
    this.failures = [...this.failures, { harness, message: bounded, source }].slice(-20);
    this.options.log?.(`Workbench stats ${source} failure${harness ? ` for ${harness}` : ""}: ${bounded}`);
  }
}
