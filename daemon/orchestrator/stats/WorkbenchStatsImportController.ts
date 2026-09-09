/*
 * Keywords: stats, import, reconciliation, cancellation, durable writes.
 * Exports:
 * - WorkbenchStatsImportControllerOptions: SQLite queues, usage hydration, Git hydration, clock, and scheduler ports. Keywords: stats, import, lifecycle.
 * - default WorkbenchStatsImportController: own one resumable background import run. Keywords: stats, import, controller, progress.
 */
import { randomUUID } from "node:crypto";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
  type WorkbenchStatsImportProgress,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import type {
  WorkbenchGitClaimImportCandidate,
  WorkbenchGitClaimImportDiscovery,
  WorkbenchGitClaimImportSettlement,
  WorkbenchStatsUsageImportCandidate,
  WorkbenchStatsUsageImportSettlement,
} from "../database/stats/WorkbenchStatsImportRepository";

export interface WorkbenchStatsImportControllerOptions {
  claims: {
    reconcile?(signal: AbortSignal): Promise<void>;
    discover(): Promise<{ candidates: WorkbenchGitClaimImportDiscovery[]; unsupported: number }>;
    hydrate(candidate: WorkbenchGitClaimImportCandidate): Promise<string[]>;
  };
  database: {
    addStatsClaimDiscoveries(runId: string, discoveries: WorkbenchGitClaimImportDiscovery[], now: number): Promise<WorkbenchStatsImportProgress>;
    beginStatsImport(runId: string, harnesses: WorkbenchHarness[], now: number): Promise<WorkbenchStatsImportProgress>;
    claimStatsClaimImport(runId: string, now: number): Promise<WorkbenchGitClaimImportCandidate | null>;
    claimStatsUsageImport(runId: string, harnesses: WorkbenchHarness[], now: number): Promise<WorkbenchStatsUsageImportCandidate | null>;
    readStatsImportProgress(state: WorkbenchStatsImportProgress["state"], revision: number, unsupported: number): Promise<WorkbenchStatsImportProgress>;
    repairStatsAttributions(now: number, threadId?: string | null): Promise<object>;
    settleStatsClaimImport(runId: string, candidate: WorkbenchGitClaimImportCandidate, settlement: WorkbenchGitClaimImportSettlement, now: number): Promise<WorkbenchStatsImportProgress>;
    settleStatsUsageImport(runId: string, candidate: WorkbenchStatsUsageImportCandidate, settlement: WorkbenchStatsUsageImportSettlement, now: number): Promise<WorkbenchStatsImportProgress>;
  };
  harnesses: {
    hydrateUsage(candidate: WorkbenchStatsUsageImportCandidate): Promise<{ state: "completed" | "unavailable" }>;
    listUsageHydrationHarnesses(): WorkbenchHarness[];
  };
  createRunId?: () => string;
  now?: () => number;
  reportFailure?: (error: unknown) => void;
  yieldToEventLoop?: () => Promise<void>;
}

const PUBLISH_BATCH_SIZE = 25;

export default class WorkbenchStatsImportController {
  private readonly lifetime = new AbortController();
  private pendingWrite: Promise<unknown> | null = null;
  private readonly listeners = new Set<(progress: WorkbenchStatsImportProgress) => void>();
  private progress: WorkbenchStatsImportProgress = EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS;
  private revision = 0;
  private starting: Promise<WorkbenchStatsImportProgress> | null = null;
  private unsupportedClaimCheckpoints = 0;
  private worker: Promise<void> | null = null;

  constructor(private readonly options: WorkbenchStatsImportControllerOptions) {}

  private get active() { return !this.lifetime.signal.aborted; }

  subscribe(listener: (progress: WorkbenchStatsImportProgress) => void) {
    this.listeners.add(listener);
    listener(this.progress);
    return () => this.listeners.delete(listener);
  }

  getProgress() {
    return this.progress;
  }

  start(): Promise<WorkbenchStatsImportProgress> {
    if (!this.active) return Promise.reject(new Error("Workbench stats importer is disposed."));
    if (this.worker) return Promise.resolve(this.progress);
    if (this.starting) return this.starting;
    const starting = this.begin().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  async dispose() {
    this.lifetime.abort();
    this.listeners.clear();
    // The worker includes expendable reads. Only an issued mutation is a durability barrier.
    await this.pendingWrite;
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.pendingWrite = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingWrite === pending) this.pendingWrite = null;
    }
  }

  private async begin() {
    const runId = (this.options.createRunId ?? randomUUID)();
    const harnesses = this.options.harnesses.listUsageHydrationHarnesses();
    const progress = await this.write(() => this.options.database.beginStatsImport(runId, harnesses, this.now()));
    if (!this.active) return this.progress;
    this.install(progress, "running");
    if (!this.active) return this.progress;
    this.worker = this.run(runId, harnesses)
      .catch((error) => {
        this.options.reportFailure?.(error);
        if (this.active) this.install(this.progress, "complete");
      })
      .finally(() => { this.worker = null; });
    return this.progress;
  }

  private async run(runId: string, harnesses: WorkbenchHarness[]) {
    try {
      await this.options.claims.reconcile?.(this.lifetime.signal);
    } catch (error) {
      if (error !== this.lifetime.signal.reason) this.options.reportFailure?.(error);
    }
    if (!this.active) return;
    await this.write(() => this.options.database.repairStatsAttributions(this.now()));
    if (!this.active) return;
    try {
      const discovery = await this.options.claims.discover();
      if (!this.active) return;
      this.unsupportedClaimCheckpoints = discovery.unsupported;
      await this.write(() => this.options.database.addStatsClaimDiscoveries(runId, discovery.candidates, this.now()));
    } catch (error) {
      this.options.reportFailure?.(new Error(`claim history discovery failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    let preferClaims = true;
    let settled = 0;
    while (this.active) {
      const claimCandidate = preferClaims ? await this.write(() => this.options.database.claimStatsClaimImport(runId, this.now())) : null;
      if (!this.active) return;
      const usageCandidate = claimCandidate ? null : await this.write(() => this.options.database.claimStatsUsageImport(runId, harnesses, this.now()));
      if (!this.active) return;
      const fallbackClaim = claimCandidate || usageCandidate ? null : await this.write(() => this.options.database.claimStatsClaimImport(runId, this.now()));
      if (!this.active) return;
      const candidate = claimCandidate ?? usageCandidate ?? fallbackClaim;
      if (!candidate) break;
      let progress: WorkbenchStatsImportProgress;
      if (candidate.kind === "claims") {
        let settlement: WorkbenchGitClaimImportSettlement;
        try {
          settlement = { paths: await this.options.claims.hydrate(candidate), state: "completed" };
        } catch (error) {
          if (!this.active) {
            this.options.reportFailure?.(error);
            return;
          }
          settlement = { error: error instanceof Error ? error.message : String(error), state: "failed" };
        }
        if (!this.active) return;
        progress = await this.write(() => this.options.database.settleStatsClaimImport(runId, candidate, settlement, this.now()));
      } else {
        let settlement: WorkbenchStatsUsageImportSettlement;
        try {
          settlement = await this.options.harnesses.hydrateUsage(candidate);
        } catch (error) {
          if (!this.active) {
            this.options.reportFailure?.(error);
            return;
          }
          settlement = { error: error instanceof Error ? error.message : String(error), state: "failed" };
        }
        if (!this.active) return;
        progress = await this.write(() => this.options.database.settleStatsUsageImport(runId, candidate, settlement, this.now()));
        if (!this.active) return;
        if (settlement.state !== "failed") await this.write(() => this.options.database.repairStatsAttributions(this.now(), candidate.threadId));
      }
      if (!this.active) return;
      settled += 1;
      preferClaims = !preferClaims;
      if (settled % PUBLISH_BATCH_SIZE === 0 || progress.recentFailures.length > this.progress.recentFailures.length) {
        this.install(progress, "running");
      }
      await (this.options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve))))();
    }
    if (this.active) {
      this.install(await this.options.database.readStatsImportProgress(
        "complete",
        ++this.revision,
        this.unsupportedClaimCheckpoints,
      ), "complete");
    }
  }

  private install(progress: WorkbenchStatsImportProgress, state: WorkbenchStatsImportProgress["state"]) {
    if (!this.active) return;
    this.revision += 1;
    this.progress = {
      ...progress,
      revision: this.revision,
      state,
      unsupportedClaimCheckpoints: this.unsupportedClaimCheckpoints,
    };
    for (const listener of this.listeners) listener(this.progress);
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }
}
