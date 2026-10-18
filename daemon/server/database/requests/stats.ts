/*
 * Exports:
 * - statsRequests: database requests for usage and claim statistics, rate limits, agent feedback, and history import runs.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchClaimStatsRequest } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import type { WorkbenchStatsImportProgress, WorkbenchStatsRange, WorkbenchStatsReadRequest } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchFeedbackReadRequest, WorkbenchFeedbackRecord } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "../../stats/git-claim-observation.ts";
import WorkbenchClaimStatsRepository from "../stats/WorkbenchClaimStatsRepository.ts";
import WorkbenchFeedbackRepository from "../stats/WorkbenchFeedbackRepository.ts";
import type {
  WorkbenchGitClaimImportCandidate,
  WorkbenchGitClaimImportDiscovery,
  WorkbenchGitClaimImportSettlement,
  WorkbenchStatsUsageImportCandidate,
  WorkbenchStatsUsageImportSettlement,
} from "../stats/WorkbenchStatsImportRepository.ts";
import type { WorkbenchRateLimitObservation, WorkbenchStoredStatsSection } from "../stats/WorkbenchStatsRepository.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

export const statsRequests = {
  recordStatsClaimSnapshot: defineDatabaseRequest({
    run: ({ stats }, snapshot: WorkbenchGitClaimSnapshot) => { stats.recordClaimSnapshot(snapshot); },
  }),
  recordStatsRateLimits: defineDatabaseRequest({
    run: ({ stats }, observation: WorkbenchRateLimitObservation) => { stats.recordRateLimits(observation); },
  }),
  readStatsSection: defineDatabaseRequest({
    read: "stats",
    run: (
      { stats },
      request: WorkbenchStatsReadRequest & { section: WorkbenchStoredStatsSection },
      now: number | undefined,
      renames: readonly WorkbenchGitClaimRename[],
      workbenchProjectId: string | null,
    ) => stats.read(request, now, renames, workbenchProjectId),
  }),
  readStatsClaimedRoots: defineDatabaseRequest({
    read: "stats",
    run: ({ stats }, projectIds: readonly string[] | null, range: WorkbenchStatsRange | "all", now?: number) => stats.claimedRoots(projectIds, range, now),
  }),
  readClaimStats: defineDatabaseRequest({
    read: "stats",
    run: ({ database }, request: WorkbenchClaimStatsRequest, now?: number, renames: readonly WorkbenchGitClaimRename[] = []) => (
      new WorkbenchClaimStatsRepository(database).read(request, now, renames)
    ),
  }),
  recordFeedback: defineDatabaseRequest({
    run: ({ database }, entry: WorkbenchFeedbackRecord, now: number = Date.now()) => new WorkbenchFeedbackRepository(database).record(entry, now).id,
  }),
  deleteFeedback: defineDatabaseRequest({
    run: ({ database }, ids: readonly number[]) => new WorkbenchFeedbackRepository(database).delete(ids),
  }),
  resolveFeedback: defineDatabaseRequest({
    run: ({ database }, ids: readonly number[], resolved: boolean, now: number = Date.now()) => new WorkbenchFeedbackRepository(database).setResolved(ids, resolved, now),
  }),
  readFeedback: defineDatabaseRequest({
    read: "stats",
    run: ({ database }, request: WorkbenchFeedbackReadRequest, now?: number) => new WorkbenchFeedbackRepository(database).read(request, now),
  }),
  beginStatsImport: defineDatabaseRequest({
    run: ({ statsImports }, runId: string, harnesses: WorkbenchHarness[], now: number) => {
      statsImports.beginUsage(runId, harnesses, now);
      return statsImports.progress("running", 1, 0);
    },
  }),
  addStatsClaimDiscoveries: defineDatabaseRequest({
    run: ({ statsImports }, runId: string, discoveries: WorkbenchGitClaimImportDiscovery[], now: number) => {
      statsImports.addClaimDiscoveries(runId, discoveries, now);
      return statsImports.progress("running", 1, 0);
    },
  }),
  claimStatsUsageImport: defineDatabaseRequest({
    run: ({ statsImports }, runId: string, harnesses: WorkbenchHarness[], now: number): WorkbenchStatsUsageImportCandidate | null => (
      statsImports.claimUsage(runId, harnesses, now)
    ),
  }),
  claimStatsClaimImport: defineDatabaseRequest({
    run: ({ statsImports }, runId: string, now: number): WorkbenchGitClaimImportCandidate | null => statsImports.claimClaims(runId, now),
  }),
  settleStatsUsageImport: defineDatabaseRequest({
    run: ({ statsImports }, runId: string, candidate: WorkbenchStatsUsageImportCandidate, settlement: WorkbenchStatsUsageImportSettlement, now: number) => {
      statsImports.settleUsage(runId, candidate, settlement, now);
      return statsImports.progress("running", 1, 0);
    },
  }),
  settleStatsClaimImport: defineDatabaseRequest({
    run: ({ statsImports }, runId: string, candidate: WorkbenchGitClaimImportCandidate, settlement: WorkbenchGitClaimImportSettlement, now: number) => {
      statsImports.settleClaims(runId, candidate, settlement, now);
      return statsImports.progress("running", 1, 0);
    },
  }),
  repairStatsAttributions: defineDatabaseRequest({
    run: ({ statsAttribution }, now: number, threadId: string | null = null) => ({ changes: statsAttribution.repair(now, threadId) }),
  }),
  readStatsImportProgress: defineDatabaseRequest({
    read: "stats",
    run: ({ statsImports }, state: WorkbenchStatsImportProgress["state"], revision: number, unsupportedClaimCheckpoints: number = 0) => (
      statsImports.progress(state, revision, unsupportedClaimCheckpoints)
    ),
  }),
};
