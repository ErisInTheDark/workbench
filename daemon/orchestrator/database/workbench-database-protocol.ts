/*
 * Keywords: database, worker, requests, responses, context usage.
 * WorkbenchDatabaseControllerState: complete database-controller lifecycle state. Keywords: database, worker, lifecycle.
 * WorkbenchDatabaseRequestPayload: typed request payloads admitted by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseRequest: correlated requests admitted by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseResponse: typed responses returned by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseInventory: installed schema inventory returned after readiness. Keywords: database, schema, inventory.
 * WorkbenchDatabaseMutationResult: aggregate result of one atomic mutation batch. Keywords: database, statement, transaction.
 */
import type { WorkbenchStatsImportProgress, WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchStatsDetailedReadRequest, WorkbenchStatsDetailedResponse } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import type { WorkbenchClaimStatsRequest, WorkbenchClaimStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import type {
  WorkbenchNativeThreadIdentity,
  WorkbenchThreadIdentityLookup,
  WorkbenchThreadIdentityMetadata,
  WorkbenchThreadIdentityRecord,
  WorkbenchTurnIdentityLookup,
  WorkbenchTurnIdentityMetadata,
  WorkbenchTurnIdentityRecord,
} from "./thread-identity/workbench-thread-identity-types.ts";
import type {
  WorkbenchDatabaseMutation,
  WorkbenchDatabaseQuery,
  WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptItemIdentity,
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
} from "./transcript/workbench-transcript-types.ts";
import type {
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./thread-state/workbench-thread-state-shadow-types.ts";
import type {
  WorkbenchSearchRequest,
  WorkbenchSearchResponse,
} from "workbench-shared/workbench/search/workbench-search";
import type { WorkbenchRateLimitObservation } from "./stats/WorkbenchStatsRepository.ts";
import type { TranscriptQuery, TranscriptQueryPage } from "./transcript/transcript-query-contract";
import type { WorkbenchGitClaimSnapshot } from "../stats/git-claim-observation.ts";
import type {
  WorkbenchGitClaimImportCandidate,
  WorkbenchGitClaimImportDiscovery,
  WorkbenchGitClaimImportSettlement,
  WorkbenchStatsUsageImportCandidate,
  WorkbenchStatsUsageImportSettlement,
} from "./stats/WorkbenchStatsImportRepository.ts";

export type WorkbenchDatabaseControllerState = "starting" | "ready" | "suspended" | "failed" | "closed";

export interface WorkbenchDatabaseInventory {
  tableNames: string[];
  schemaVersion: number;
}

export interface WorkbenchDatabaseMutationResult {
  changes: number;
}

export type WorkbenchDatabaseRequestPayload =
  | { type: "initialize"; databasePath: string; acknowledgeMigration?: boolean }
  | { type: "acknowledgeMigration" }
  | { type: "suspend" }
  | { type: "resume"; restoreBackupPath?: string }
  | { type: "getInventory" }
  | { type: "executeTransaction"; statements: readonly WorkbenchDatabaseMutation[] }
  | { type: "query"; statement: WorkbenchDatabaseQuery }
  | { type: "observeThreadIdentities"; inputs: readonly WorkbenchThreadIdentityMetadata[] }
  | { type: "resolveThreadIdentity"; input: WorkbenchThreadIdentityLookup }
  | { type: "resolveNativeThreadIdentity"; input: WorkbenchNativeThreadIdentity }
  | { type: "listThreadIdentities" }
  | { type: "observeTurnIdentities"; inputs: readonly WorkbenchTurnIdentityMetadata[] }
  | { type: "resolveTurnIdentity"; input: WorkbenchTurnIdentityLookup }
  | { type: "admitTranscriptItemIdentities"; inputs: readonly WorkbenchTranscriptItemIdentityAdmission[] }
  | { type: "resolveTranscriptItemIdentity"; input: WorkbenchTranscriptItemIdentityLookup }
  | { type: "rebuildThreadStateShadow"; request: WorkbenchThreadStateShadowRefresh }
  | { type: "readThreadStateShadowStatus" }
  | { type: "settleTranscript"; observations: readonly WorkbenchTranscriptObservation[] }
  | { type: "readTranscript"; request: WorkbenchTranscriptReadRequest }
  | { type: "queryTranscript"; request: TranscriptQuery }
  | { type: "readThreadContextUsage"; threadId: string }
  | { type: "readTranscriptMaterializedTurnIds"; threadId: string; turnIds: readonly string[] }
  | { type: "replaceSearchProjects"; projects: readonly { id: string; name: string; rootPath: string }[] }
  | { type: "replaceSearchProjectFiles"; projectId: string; paths: readonly string[] }
  | { type: "search"; request: WorkbenchSearchRequest }
  | { type: "recordStatsClaimSnapshot"; snapshot: WorkbenchGitClaimSnapshot }
  | { type: "recordStatsRateLimits"; observation: WorkbenchRateLimitObservation }
  | { type: "readStats"; request: WorkbenchStatsReadRequest; now?: number }
  | { type: "readStatsDetailed"; request: WorkbenchStatsDetailedReadRequest; now?: number }
  | { type: "readClaimStats"; request: WorkbenchClaimStatsRequest; now?: number }
  | { type: "beginStatsImport"; runId: string; harnesses: WorkbenchHarness[]; now: number }
  | { type: "addStatsClaimDiscoveries"; runId: string; discoveries: WorkbenchGitClaimImportDiscovery[]; now: number }
  | { type: "claimStatsUsageImport"; runId: string; harnesses: WorkbenchHarness[]; now: number }
  | { type: "claimStatsClaimImport"; runId: string; now: number }
  | { type: "settleStatsUsageImport"; runId: string; candidate: WorkbenchStatsUsageImportCandidate; settlement: WorkbenchStatsUsageImportSettlement; now: number }
  | { type: "settleStatsClaimImport"; runId: string; candidate: WorkbenchGitClaimImportCandidate; settlement: WorkbenchGitClaimImportSettlement; now: number }
  | { type: "repairStatsAttributions"; now: number; threadId: string | null }
  | { type: "readStatsImportProgress"; state: WorkbenchStatsImportProgress["state"]; revision: number; unsupportedClaimCheckpoints: number }
  | { type: "close" };

export type WorkbenchDatabaseRequest = WorkbenchDatabaseRequestPayload & { id: number };

export type WorkbenchDatabaseResponse =
  | { id: number; type: "ready"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "migrationCheckpoint"; backupPath: string }
  | { id: number; type: "suspended" }
  | { id: number; type: "inventory"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "mutationResult"; result: WorkbenchDatabaseMutationResult }
  | { id: number; type: "queryResult"; rows: WorkbenchDatabaseRow[] }
  | { id: number; type: "threadIdentity"; identity: WorkbenchThreadIdentityRecord | null }
  | { id: number; type: "turnIdentities"; identities: WorkbenchTurnIdentityRecord[] }
  | { id: number; type: "threadIdentities"; identities: WorkbenchThreadIdentityRecord[] }
  | { id: number; type: "turnIdentity"; identity: WorkbenchTurnIdentityRecord | null }
  | { id: number; type: "transcriptItemIdentities"; identities: WorkbenchTranscriptItemIdentity[] }
  | { id: number; type: "transcriptItemIdentity"; identity: WorkbenchTranscriptItemIdentity | null }
  | { id: number; type: "threadStateShadowStatus"; status: WorkbenchThreadStateShadowStatus | null }
  | { id: number; type: "transcriptSettlement"; settlement: WorkbenchTranscriptSettlement }
  | { id: number; type: "transcriptSnapshot"; snapshot: WorkbenchTranscriptSnapshot | null }
  | { id: number; type: "transcriptQueryResult"; result: { ok: true; page: TranscriptQueryPage } | { ok: false; error: string } }
  | { id: number; type: "threadContextUsage"; snapshot: ThreadContextUsageSnapshot | null }
  | { id: number; type: "transcriptMaterializedTurnIds"; turnIds: string[] }
  | { id: number; type: "searchResult"; result: WorkbenchSearchResponse }
  | { id: number; type: "statsResult"; result: WorkbenchStatsResponse }
  | { id: number; type: "statsDetailedResult"; result: WorkbenchStatsDetailedResponse }
  | { id: number; type: "claimStatsResult"; result: WorkbenchClaimStatsResponse }
  | { id: number; type: "statsUsageImportCandidate"; candidate: WorkbenchStatsUsageImportCandidate | null }
  | { id: number; type: "statsClaimImportCandidate"; candidate: WorkbenchGitClaimImportCandidate | null }
  | { id: number; type: "statsImportProgress"; progress: WorkbenchStatsImportProgress }
  | { id: number; type: "closed" }
  | { id: number; type: "requestFailure"; message: string }
  | { id: number; type: "fatalFailure"; message: string };
