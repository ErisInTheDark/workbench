/*
 * Exports:
 * - WorkbenchStatsControllerOptions: database, harness, rename, tool catalogue, and warning ports.
 * - default WorkbenchStatsController: own imports, capture, agent feedback, streamed per-section stats observations (rename-aware claims, tool prompt cost, import status), one-shot tool reads for the CLI, account-limit history, refresh, failures, and disposal.
 */
import type { WorkbenchAccountLimits, WorkbenchRateLimitSnapshot, WorkbenchRateLimitWindow } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type WorkbenchProviderDispatcher from "../WorkbenchProviderDispatcher";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchHarness } from "workbench-shared/types";
import type {
  WorkbenchStatsRange, WorkbenchStatsReadRequest, WorkbenchStatsResponse, WorkbenchStatsSectionData,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchRateLimitObservation, WorkbenchStoredStatsSection } from "../database/stats/WorkbenchStatsRepository.ts";
import type WorkbenchToolCatalogueTokens from "./WorkbenchToolCatalogueTokens.ts";
import type { WorkbenchToolPromptCost } from "./WorkbenchToolCatalogueTokens.ts";
import type { WorkbenchClaimedRoot } from "../database/stats/WorkbenchClaimStatsRepository.ts";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "./git-claim-observation.ts";
import WorkbenchStatsImportController, { type WorkbenchStatsImportControllerOptions } from "./WorkbenchStatsImportController.ts";
import type WorkbenchClaimRenameController from "./WorkbenchClaimRenameController.ts";
import type { WorkbenchClaimRenameRead } from "./WorkbenchClaimRenameController.ts";
import WorkbenchStatsObservation, { type WorkbenchStatsInvalidation, type WorkbenchStatsObservationState } from "./WorkbenchStatsObservation.ts";
import type { WorkbenchClaimStatsRequest, WorkbenchClaimStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import type {
  WorkbenchFeedbackReadRequest, WorkbenchFeedbackReadResponse, WorkbenchFeedbackRecord,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";

export interface WorkbenchStatsControllerOptions {
  renames?: Pick<WorkbenchClaimRenameController, "read" | "dispose">;
  claims: WorkbenchStatsImportControllerOptions["claims"];
  database: {
    addStatsClaimDiscoveries: WorkbenchStatsImportControllerOptions["database"]["addStatsClaimDiscoveries"];
    beginStatsImport: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["database"]["beginStatsImport"];
    claimStatsClaimImport: WorkbenchStatsImportControllerOptions["database"]["claimStatsClaimImport"];
    claimStatsUsageImport: WorkbenchStatsImportControllerOptions["database"]["claimStatsUsageImport"];
    readStatsImportProgress: import("./WorkbenchStatsImportController").WorkbenchStatsImportControllerOptions["database"]["readStatsImportProgress"];
    readStats(
      request: WorkbenchStatsReadRequest & { section: WorkbenchStoredStatsSection }, now?: number, renames?: readonly WorkbenchGitClaimRename[], workbenchProjectId?: string | null,
      /** Abandons the read while it still waits for a database reader. */
      signal?: AbortSignal,
    ): Promise<WorkbenchStatsResponse>;
    readStatsClaimedRoots(projectIds: readonly string[] | null, range: WorkbenchStatsRange | "all", now?: number): Promise<WorkbenchClaimedRoot[]>;
    readClaimStats(request: WorkbenchClaimStatsRequest, now?: number, renames?: readonly WorkbenchGitClaimRename[]): Promise<WorkbenchClaimStatsResponse>;
    readFeedback(request: WorkbenchFeedbackReadRequest): Promise<WorkbenchFeedbackReadResponse>;
    deleteFeedback(ids: readonly number[]): Promise<number>;
    recordFeedback(entry: WorkbenchFeedbackRecord): Promise<number>;
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
  /** The project that owns wb feedback; null means the catalogue lost the Workbench checkout. */
  resolveWorkbenchProjectId?(): Promise<string | null>;
  /** Always-on prompt cost per wb tool; absent leaves the tools section with calls only. */
  toolCatalogue?: Pick<WorkbenchToolCatalogueTokens, "read">;
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
  private toolCatalogueFailure: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly importer: WorkbenchStatsImportController;
  private readonly observations = new Set<WorkbenchStatsObservation>();
  private readonly stopImportInvalidation: () => void;

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
    // Imported usage refreshes cheaply as it lands; claim history is re-walked once the import settles.
    let importState = this.importer.getProgress().state;
    this.stopImportInvalidation = this.importer.subscribe((progress) => {
      const settled = importState === "running" && progress.state !== "running";
      importState = progress.state;
      this.invalidate(settled ? "claims" : "usage");
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
    this.enqueue(snapshot.harness, "claim snapshot", () => this.options.database.recordStatsClaimSnapshot(snapshot), "claims");
  }

  observeProviderNotification(harness: WorkbenchHarness, observation: WorkbenchProviderObservation) {
    if (observation.accountLimits) this.recordRateLimits({
      harness, observedAt: Date.now(), snapshots: [rateSnapshot(observation.accountLimits)],
    });
  }

  /** Providers without limit notifications (such as Claude) report limits only when read. */
  observeAccountLimits(harness: WorkbenchHarness, limits: WorkbenchAccountLimits) {
    const snapshots = responseRateSnapshots(limits);
    if (snapshots.length) this.recordRateLimits({ harness, observedAt: Date.now(), snapshots });
  }

  async refreshRateLimits() {
    const harnesses = installedProviderKeys;
    const results = await Promise.allSettled(harnesses.map(async (harness) => {
      const account = this.options.providers.get(harness).account;
      if (account) this.observeAccountLimits(harness, await account.limits.read());
    }));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const harness = harnesses[index] ?? null;
      this.reportFailure(harness, result.reason instanceof Error ? result.reason.message : "Rate-limit refresh failed.", "refresh");
    });
    await this.queue;
  }

  /**
   * Stream one scope's statistics. Reads never wait for queued capture writes; those writes
   * invalidate the observation when they land, so it re-reads and publishes again.
   */
  observe(request: WorkbenchStatsReadRequest, publish: (state: WorkbenchStatsObservationState) => void) {
    if (!this.active) throw new Error("Stats controller is disposed.");
    const observation = new WorkbenchStatsObservation(request, {
      read: (scope, history, signal) => this.readSection(scope, history, signal),
      readRenames: (scope) => this.readRenames(scope.projectIds, scope.range),
      warn: (message) => this.options.log?.(message),
    }, publish);
    this.observations.add(observation);
    observation.start();
    return {
      invalidate: (kind: WorkbenchStatsInvalidation) => observation.invalidate(kind),
      release: () => {
        observation.release();
        this.observations.delete(observation);
      },
    };
  }

  private async readSection(request: WorkbenchStatsReadRequest, history: WorkbenchClaimRenameRead, signal?: AbortSignal): Promise<WorkbenchStatsResponse> {
    switch (request.section) {
      case "status": return await this.readStatus();
      case "usage":
      case "limits": return await this.readStored({ ...request, section: request.section }, [], null, signal);
      case "feedback": {
        const workbenchProjectId = this.options.resolveWorkbenchProjectId ? await this.options.resolveWorkbenchProjectId() : null;
        if (this.options.resolveWorkbenchProjectId && !workbenchProjectId) {
          this.options.log?.("The Workbench checkout is missing from the project catalogue, so wb agent feedback is hidden.");
        }
        return await this.readStored({ ...request, section: "feedback" }, [], workbenchProjectId, signal);
      }
      case "claims": return {
        ...await this.readStored({ ...request, section: "claims" }, history.renames, null, signal),
        historyFailures: history.failures.map(({ message }) => message.replaceAll(/[\r\n]+/gu, " ").slice(0, 500)).slice(-20),
      };
      case "tools": return await this.withToolCosts(await this.readStored({ ...request, section: "tools" }, [], null, signal));
    }
  }

  private async readStored<Section extends WorkbenchStoredStatsSection>(
    request: WorkbenchStatsReadRequest & { section: Section },
    renames: readonly WorkbenchGitClaimRename[] = [],
    workbenchProjectId: string | null = null,
    signal?: AbortSignal,
  ): Promise<WorkbenchStatsSectionData<Section>> {
    const result = await this.options.database.readStats(request, undefined, renames, workbenchProjectId, signal);
    if (result.section !== request.section) throw new Error(`Statistics answered ${result.section} for a ${request.section} read.`);
    return result as WorkbenchStatsSectionData<Section>;
  }

  private async readStatus(): Promise<WorkbenchStatsSectionData<"status">> {
    const progress = this.importer.getProgress();
    const historyImport = await this.options.database.readStatsImportProgress(progress.state, progress.revision, progress.unsupportedClaimCheckpoints);
    return { failures: this.failures.slice(-20), generatedAt: Date.now(), historyImport, section: "status" };
  }

  /** Calls come from SQLite; prompt cost is daemon-owned. Without a catalogue the calls still show. */
  private async withToolCosts(section: WorkbenchStatsSectionData<"tools">): Promise<WorkbenchStatsSectionData<"tools">> {
    let cost: WorkbenchToolPromptCost | null = null;
    if (this.options.toolCatalogue) {
      try {
        cost = await this.options.toolCatalogue.read();
        this.toolCatalogueFailure = null;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n]+/gu, " ").slice(0, 500);
        // Every activity tick re-reads tools; one warning per distinct failure is enough.
        if (message !== this.toolCatalogueFailure) this.options.log?.(`Tool prompt cost is unavailable: ${message}`);
        this.toolCatalogueFailure = message;
      }
    }
    const { bucketStarts, workbench } = section.tools;
    const calls = new Map(workbench.map((row) => [row.tool, row]));
    const tools = [...new Set([...calls.keys(), ...(cost?.tools.keys() ?? [])])].map((tool) => {
      const row = calls.get(tool);
      const tokens = cost?.tools.get(tool);
      return {
        buckets: row?.buckets ?? bucketStarts.map(() => 0),
        bucketThreads: row?.bucketThreads ?? [],
        calls: row?.calls ?? 0,
        docsTokens: tokens?.docsTokens ?? 0,
        failed: row?.failed ?? 0,
        // Docs can still name a tool no provider serves any more; only a served spec has a spec cost.
        specTokens: tokens?.specTokens ? tokens.specTokens : null,
        threads: row?.threads ?? 0,
        tool,
      };
    }).sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool)).slice(0, 300);
    return {
      ...section,
      tools: {
        ...section.tools,
        catalogue: cost ? {
          docsTokens: cost.docsTokens,
          specTokens: cost.specTokens,
          tools: [...cost.tools.values()].filter(({ specTokens }) => specTokens > 0).length,
        } : null,
        workbench: tools,
      },
    };
  }

  private invalidate(kind: WorkbenchStatsInvalidation) {
    for (const observation of this.observations) observation.invalidate(kind);
  }

  /** One tools section for the CLI, through the same path observations use, so both report the same figures. */
  async readTools(request: Omit<WorkbenchStatsReadRequest, "section">) {
    if (!this.active) throw new Error("Stats controller is disposed.");
    return await this.withToolCosts(await this.readStored({ ...request, section: "tools" }));
  }

  async readClaims(request: WorkbenchClaimStatsRequest) {
    await this.queue;
    const history = await this.readRenames([request.projectId], request.range);
    if (history.failures.length) throw new Error("Committed rename history is unavailable for this claim report.");
    return await this.options.database.readClaimStats(request, undefined, history.renames);
  }

  /** Agents wait for the write so a failed submission reaches them; open stats views refresh once it lands. */
  async recordFeedback(entry: WorkbenchFeedbackRecord) {
    if (!this.active) throw new Error("Stats controller is disposed.");
    const id = await this.options.database.recordFeedback(entry);
    this.invalidate("usage");
    return id;
  }

  async deleteFeedback(ids: readonly number[]) {
    if (!this.active) throw new Error("Stats controller is disposed.");
    const deleted = await this.options.database.deleteFeedback(ids);
    this.invalidate("usage");
    return deleted;
  }

  async readFeedback(request: WorkbenchFeedbackReadRequest) {
    if (!this.active) throw new Error("Stats controller is disposed.");
    return await this.options.database.readFeedback(request);
  }

  /** Only roots with claims in the window need history, and only after their earliest claim. */
  private async readRenames(projectIds: readonly string[] | null, range: WorkbenchStatsRange | "all"): Promise<WorkbenchClaimRenameRead> {
    if (!this.active) throw new Error("Stats controller is disposed.");
    if (!this.options.renames) return { renames: [], failures: [] };
    let history: WorkbenchClaimRenameRead;
    try {
      const claimed = await this.options.database.readStatsClaimedRoots(projectIds, range);
      history = await this.options.renames.read(claimed.map(({ projectId, rootId, earliestClaimedDay }) => ({
        projectId, rootId, since: earliestClaimedDay,
      })));
    } catch (error) {
      if (!this.active) throw error;
      history = { renames: [], failures: [{ projectId: "", rootId: "", message: "Committed rename history discovery is unavailable." }] };
    }
    for (const failure of history.failures) {
      this.options.log?.(`Workbench claim rename failure: ${failure.message.replace(/[\r\n]/gu, " ").slice(0, 500)}`);
    }
    return history;
  }

  async dispose() {
    this.active = false;
    this.stopImportInvalidation();
    for (const observation of this.observations) observation.release();
    this.observations.clear();
    await Promise.all([this.importer.dispose(), this.options.renames?.dispose()]);
    await this.queue;
  }

  hasPendingWork() { return this.importer.hasPendingWork(); }

  reportCaptureFailure(harness: string | null, label: string, error: unknown) {
    this.reportFailure(harness, `${label} capture failed: ${error instanceof Error ? error.message : String(error)}`, "capture");
  }

  private recordRateLimits(observation: WorkbenchRateLimitObservation) {
    this.enqueue(observation.harness, "rate limits", () => this.options.database.recordStatsRateLimits(observation), "usage");
  }

  private enqueue(harness: string | null, label: string, operation: () => Promise<void>, changes: WorkbenchStatsInvalidation) {
    if (!this.active) return;
    this.queue = this.queue.then(operation).then(() => this.invalidate(changes)).catch((error) => {
      this.reportFailure(harness, `${label} capture failed: ${error instanceof Error ? error.message : String(error)}`, "capture");
    });
  }

  private reportFailure(harness: string | null, message: string, source: "capture" | "refresh") {
    const bounded = message.replaceAll(/[\r\n]+/gu, " ").slice(0, 500);
    this.failures = [...this.failures, { harness, message: bounded, source }].slice(-20);
    this.options.log?.(`Workbench stats ${source} failure${harness ? ` for ${harness}` : ""}: ${bounded}`);
    this.invalidate("usage");
  }
}
