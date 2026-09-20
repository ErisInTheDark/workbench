/*
 * Exports:
 * - WorkbenchStatsControllerOptions: database, harness, rename, and warning ports.
 * - default WorkbenchStatsController: own imports, capture, rename-aware reads, refresh, failures, and disposal.
 */
import type { WorkbenchAccountLimits, WorkbenchRateLimitSnapshot, WorkbenchRateLimitWindow } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type WorkbenchProviderDispatcher from "../WorkbenchProviderDispatcher";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsReadRequest } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchRateLimitObservation } from "../database/stats/WorkbenchStatsRepository.ts";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "./git-claim-observation.ts";
import WorkbenchStatsImportController, { type WorkbenchStatsImportControllerOptions } from "./WorkbenchStatsImportController.ts";
import type WorkbenchClaimRenameController from "./WorkbenchClaimRenameController.ts";
import type { WorkbenchClaimRenameRead } from "./WorkbenchClaimRenameController.ts";
import type { WorkbenchClaimStatsRequest, WorkbenchClaimStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";

export interface WorkbenchStatsControllerOptions {
  renames?: Pick<WorkbenchClaimRenameController, "read" | "dispose">;
  claims: WorkbenchStatsImportControllerOptions["claims"];
  database: {
    addStatsClaimDiscoveries: WorkbenchStatsImportControllerOptions["database"]["addStatsClaimDiscoveries"];
    beginStatsImport: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["database"]["beginStatsImport"];
    claimStatsClaimImport: WorkbenchStatsImportControllerOptions["database"]["claimStatsClaimImport"];
    claimStatsUsageImport: WorkbenchStatsImportControllerOptions["database"]["claimStatsUsageImport"];
    readStatsImportProgress: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["database"]["readStatsImportProgress"];
    readStats(request: WorkbenchStatsReadRequest, now?: number, renames?: readonly WorkbenchGitClaimRename[]): Promise<import("workbench-shared/workbench/stats/workbench-stats-contract").WorkbenchStatsResponse>;
    readStatsDetailed(request: import("workbench-shared/workbench/stats/workbench-stats-detail-contract").WorkbenchStatsDetailedReadRequest, now?: number, renames?: readonly WorkbenchGitClaimRename[]): Promise<import("workbench-shared/workbench/stats/workbench-stats-detail-contract").WorkbenchStatsDetailedResponse>;
    readClaimStats(request: WorkbenchClaimStatsRequest, now?: number, renames?: readonly WorkbenchGitClaimRename[]): Promise<WorkbenchClaimStatsResponse>;
    recordStatsClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot): Promise<void>;
    recordStatsRateLimits(observation: WorkbenchRateLimitObservation): Promise<void>;
    repairStatsAttributions: WorkbenchStatsImportControllerOptions["database"]["repairStatsAttributions"];
    settleStatsClaimImport: WorkbenchStatsImportControllerOptions["database"]["settleStatsClaimImport"];
    settleStatsUsageImport: WorkbenchStatsImportControllerOptions["database"]["settleStatsUsageImport"];
  };
  harnesses: {
    hydrateUsage: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["harnesses"]["hydrateUsage"];
    listUsageHydrationHarnesses: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["harnesses"]["listUsageHydrationHarnesses"];
  };
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  log?(message: string): void;
}

function rateWindow(candidate: WorkbenchRateLimitWindow | null) {
  if (!candidate || !Number.isFinite(candidate.usedPercent)) return null;
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

function rateSnapshot(candidate: WorkbenchRateLimitSnapshot, fallbackId = "default") {
  return {
    limitId: typeof candidate.limitId === "string" && candidate.limitId.trim() ? candidate.limitId : fallbackId,
    limitName: typeof candidate.limitName === "string" && candidate.limitName.trim() ? candidate.limitName : null,
    primary: rateWindow(candidate.primary),
    secondary: rateWindow(candidate.secondary),
    tertiary: rateWindow(candidate.tertiary ?? null),
  };
}

function responseRateSnapshots(candidate: WorkbenchAccountLimits) {
  const byId = candidate.rateLimitsByLimitId;
  const snapshots = byId
    ? Object.entries(byId).flatMap(([id, value]) => {
      return [rateSnapshot(value, id)];
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

  observeProviderNotification(harness: WorkbenchHarness, observation: WorkbenchProviderObservation) {
    if (observation.accountLimits) this.recordRateLimits({
      harness, observedAt: Date.now(), snapshots: [rateSnapshot(observation.accountLimits)],
    });
  }

  async refreshRateLimits() {
    const harnesses = installedProviderKeys;
    const results = await Promise.allSettled(harnesses.map(async (harness) => {
      const account = this.options.providers.get(harness).account;
      if (!account) return;
      const snapshots = responseRateSnapshots(await account.limits.read());
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
    const history = await this.readRenames(request.projectId);
    const result = await this.options.database.readStats(request, undefined, history.renames);
    return await this.withStatus(result, history);
  }

  async readClaims(request: WorkbenchClaimStatsRequest) {
    await this.queue;
    const history = await this.readRenames(request.projectId);
    if (history.failures.length) throw new Error("Committed rename history is unavailable for this claim report.");
    return await this.options.database.readClaimStats(request, undefined, history.renames);
  }

  async readDetailed(request: import("workbench-shared/workbench/stats/workbench-stats-detail-contract").WorkbenchStatsDetailedReadRequest) {
    await this.queue;
    const history = await this.readRenames(request.projectId);
    return await this.withStatus(await this.options.database.readStatsDetailed(request, undefined, history.renames), history);
  }

  private async readRenames(projectId: string | null): Promise<WorkbenchClaimRenameRead> {
    if (!this.active) throw new Error("Stats controller is disposed.");
    let history: WorkbenchClaimRenameRead;
    try {
      history = await this.options.renames?.read(projectId) ?? { renames: [], failures: [] };
    } catch (error) {
      if (!this.active) throw error;
      history = { renames: [], failures: [{ projectId: projectId ?? "", rootId: "", message: "Committed rename history discovery is unavailable." }] };
    }
    for (const failure of history.failures) {
      this.options.log?.(`Workbench claim rename failure: ${failure.message.replace(/[\r\n]/gu, " ").slice(0, 500)}`);
    }
    return history;
  }

  private async withStatus<T extends import("workbench-shared/workbench/stats/workbench-stats-contract").WorkbenchStatsResponse>(result: T, history: WorkbenchClaimRenameRead) {
    const currentProgress = this.importer.getProgress();
    const historyImport = await this.options.database.readStatsImportProgress(
      currentProgress.state,
      currentProgress.revision,
      currentProgress.unsupportedClaimCheckpoints,
    );
    return {
      ...result,
      failures: [
        ...result.failures,
        ...this.failures,
        ...history.failures.map(({ message }) => ({ harness: null, message, source: "capture" as const })),
      ].slice(-20),
      historyImport,
    };
  }

  async dispose() {
    this.active = false;
    await Promise.all([this.importer.dispose(), this.options.renames?.dispose()]);
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
