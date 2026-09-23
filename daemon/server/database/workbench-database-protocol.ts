/*
 * WorkbenchDatabaseControllerState: complete database-controller lifecycle state.
 * WorkbenchDatabaseRequestPayload: typed request payloads admitted by the database worker.
 * WorkbenchDatabaseRequest: correlated requests admitted by the database worker.
 * WorkbenchDatabaseResponse: typed responses returned by the database worker.
 * WorkbenchDatabaseInventory: installed schema inventory returned after readiness.
 * WorkbenchDatabaseMutationResult: aggregate result of one atomic mutation batch.
 */
import type { WorkbenchStatsImportProgress, WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchStatsDetailedReadRequest, WorkbenchStatsDetailedResponse } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import type { WorkbenchClaimStatsRequest, WorkbenchClaimStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import type { WorkbenchHarness, WorkbenchProjectOption, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchProjectAlias, WorkbenchProjectDiscovery, WorkbenchProjectIconSettlement, WorkbenchProjectPreparation, WorkbenchProjectStartup } from "./project/workbench-project-persistence";
import type { WorkbenchSubagentReservation } from "../workbench-subagent-record.ts";
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
  WorkbenchTranscriptContextSnapshot,
  WorkbenchTranscriptItemIdentity,
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
} from "./transcript/workbench-transcript-types.ts";
import type {
  WorkbenchStoredThreadDraft,
  WorkbenchThreadRecordQuery, WorkbenchThreadStateCommit,
  WorkbenchSubagentRelationshipRead,
  WorkbenchThreadStateProjectDocument, WorkbenchThreadStateGlobalDocument,
} from "./thread-state/workbench-thread-state-persistence.ts";
import type { WorkbenchThreadStateRecord } from "../workbench-thread-state-record.ts";
import type { WorkbenchStoredThreadTitleHistory } from "../WorkbenchThreadStateStore.ts";
import type { WorkbenchThreadLayoutOwner } from "./thread-state/WorkbenchThreadStateLayoutRepository.ts";
import type { ThreadDisplayLayout } from "workbench-shared/workbench/thread/thread-display-layout";
import type { WorkbenchComposerProfileSelectionState } from "workbench-shared/workbench/thread/thread-state";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type {
  WorkbenchSearchRequest,
  WorkbenchSearchResponse,
} from "workbench-shared/workbench/search/workbench-search";
import type { WorkbenchThreadLaunchLocation, WorkbenchThreadLaunchRequest, WorkbenchThreadLaunchState } from "workbench-shared/workbench/thread/thread-launch";
import type { WorkbenchRateLimitObservation } from "./stats/WorkbenchStatsRepository.ts";
import type { TranscriptQuery, TranscriptQueryPage } from "./transcript/transcript-query-contract";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "../stats/git-claim-observation.ts";
import type {
  WorkbenchGitClaimImportCandidate,
  WorkbenchGitClaimImportDiscovery,
  WorkbenchGitClaimImportSettlement,
  WorkbenchStatsUsageImportCandidate,
  WorkbenchStatsUsageImportSettlement,
} from "./stats/WorkbenchStatsImportRepository.ts";
import type {
  GitArcProposalDiffCacheIdentity,
  GitArcProposalDiffCacheValue,
} from "../lib/workbench/git/GitArcProposalDiffController.ts";
import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { TranscriptAssetContent, TranscriptAssetRead, TranscriptAssetWrite } from "./transcript/WorkbenchTranscriptAssetStore.ts";
import type { LegacyDiffArtifactReference } from "./git/WorkbenchLegacyDiffArtifactStore.ts";
import type { ThreadGitSelectionCommand, ThreadGitSelectionResult } from "./git/WorkbenchThreadGitSelectionStore.ts";

export type WorkbenchDatabaseControllerState = "starting" | "ready" | "suspended" | "failed" | "closed";

export interface WorkbenchDatabaseInventory {
  tableNames: string[];
  schemaVersion: number;
}

export interface WorkbenchDatabaseMutationResult {
  changes: number;
}

export type WorkbenchDatabaseRequestPayload =
  | { type: "threadGitSelection"; command: ThreadGitSelectionCommand }
  | { type: "readLegacyDiffArtifact"; input: LegacyDiffArtifactReference }
  | { type: "writeTranscriptAsset"; input: TranscriptAssetWrite }
  | { type: "readTranscriptAsset"; input: TranscriptAssetRead }
  | { type: "initialize"; databasePath: string; acknowledgeMigration?: boolean; projects?: WorkbenchProjectPreparation }
  | { type: "reconcileProjectCatalog"; discovery: WorkbenchProjectDiscovery }
  | { type: "readProjectAliases" }
  | { type: "resolveProjectIdentity"; projectId: string }
  | { type: "settleProjectIcon"; settlement: WorkbenchProjectIconSettlement }
  | { type: "reserveThreadLaunch"; request: WorkbenchThreadLaunchRequest; location: WorkbenchThreadLaunchLocation }
  | { type: "readThreadLaunch"; launchId: string }
  | { type: "advanceThreadLaunch"; launchId: string; from: WorkbenchThreadLaunchState["phase"]; next: WorkbenchThreadLaunchState }
  | { type: "acknowledgeMigration" }
  | { type: "suspend" }
  | { type: "resume"; restoreBackupPath?: string }
  | { type: "getInventory" }
  | { type: "executeTransaction"; statements: readonly WorkbenchDatabaseMutation[] }
  | { type: "query"; statement: WorkbenchDatabaseQuery }
  | { type: "readGitArcProposalDiff"; identity: GitArcProposalDiffCacheIdentity }
  | { type: "writeGitArcProposalDiff"; value: GitArcProposalDiffCacheValue; maxBytes: number }
  | { type: "observeThreadIdentities"; inputs: readonly WorkbenchThreadIdentityMetadata[] }
  | { type: "resolveThreadIdentity"; input: WorkbenchThreadIdentityLookup }
  | { type: "resolveNativeThreadIdentity"; input: WorkbenchNativeThreadIdentity }
  | { type: "listThreadIdentities" }
  | { type: "observeTurnIdentities"; inputs: readonly WorkbenchTurnIdentityMetadata[] }
  | { type: "resolveTurnIdentity"; input: WorkbenchTurnIdentityLookup }
  | { type: "admitTranscriptItemIdentities"; inputs: readonly WorkbenchTranscriptItemIdentityAdmission[] }
  | { type: "resolveTranscriptItemIdentity"; input: WorkbenchTranscriptItemIdentityLookup }
  | { type: "readThreadStateProject"; projectId: ProjectId }
  | { type: "readThreadStateTitleHistories"; projectId: ProjectId }
  | { type: "writeThreadStateProject"; projectId: ProjectId; document: WorkbenchThreadStateProjectDocument; titleHistories?: readonly WorkbenchStoredThreadTitleHistory[] }
  | { type: "readThreadStateGlobal"; documentId: WorkbenchThreadStateGlobalDocument["id"] }
  | { type: "writeThreadStateGlobal"; document: WorkbenchThreadStateGlobalDocument }
  | { type: "readThreadStateRecords"; query: WorkbenchThreadRecordQuery }
  | { type: "readThreadStateDrafts"; projectId: ProjectId }
  | { type: "readThreadStateProfile"; projectId: ProjectId }
  | { type: "readThreadStateLayout"; owner: WorkbenchThreadLayoutOwner }
  | { type: "readThreadStatePinnedImports" }
  | { type: "readThreadStateArchiveDeadline" }
  | { type: "readThreadStateActivity"; projectId: ProjectId }
  | { type: "readThreadStateSnoozeSources"; targetThreadId: WorkbenchThreadId }
  | { type: "readThreadStateArchiveEligible"; activeBefore: number }
  | { type: "commitThreadState"; changes: WorkbenchThreadStateCommit }
  | { type: "readSubagents"; query: WorkbenchSubagentRelationshipRead }
  | { type: "readOwnedSubagents"; parentThreadId: WorkbenchThreadId; projectId: ProjectId; threadIds: readonly WorkbenchThreadId[] }
  | { type: "reserveSubagent"; record: Omit<WorkbenchSubagentReservation, "directSubagentIndex"> }
  | { type: "activateSubagent"; parentThreadId: WorkbenchThreadId; reservationId: string; record: WorkbenchSubagentRelationship }
  | { type: "removeSubagent"; parentThreadId: WorkbenchThreadId; identifier: string }
  | { type: "settleTranscript"; observations: readonly WorkbenchTranscriptObservation[] }
  | { type: "readTranscript"; request: WorkbenchTranscriptReadRequest }
  | { type: "readTranscriptProviderCursor"; threadId: string; turnId: string }
  | { type: "readTranscriptContext"; threadId: string }
  | { type: "queryTranscript"; request: TranscriptQuery }
  | { type: "readThreadContextUsage"; threadId: string }
  | { type: "readTranscriptMaterializedTurnIds"; threadId: string; turnIds: readonly string[] }
  | { type: "replaceSearchProjects"; projects: readonly { id: string; name: string; rootPath: string }[] }
  | { type: "replaceSearchProjectFiles"; projectId: string; paths: readonly string[] }
  | { type: "search"; request: WorkbenchSearchRequest }
  | { type: "recordStatsClaimSnapshot"; snapshot: WorkbenchGitClaimSnapshot }
  | { type: "recordStatsRateLimits"; observation: WorkbenchRateLimitObservation }
  | { type: "readStats"; request: WorkbenchStatsReadRequest; now?: number; renames?: readonly WorkbenchGitClaimRename[] }
  | { type: "readStatsDetailed"; request: WorkbenchStatsDetailedReadRequest; now?: number; renames?: readonly WorkbenchGitClaimRename[] }
  | { type: "readClaimStats"; request: WorkbenchClaimStatsRequest; now?: number; renames?: readonly WorkbenchGitClaimRename[] }
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
  | { id: number; type: "threadGitSelection"; result: ThreadGitSelectionResult }
  | { id: number; type: "legacyDiffArtifact"; diff: string | null }
  | { id: number; type: "transcriptAssetWritten"; asset: Omit<TranscriptAssetContent, "bytes"> }
  | { id: number; type: "transcriptAssetContent"; asset: TranscriptAssetContent | null }
  | { id: number; type: "ready"; inventory: WorkbenchDatabaseInventory; projects?: WorkbenchProjectStartup }
  | { id: number; type: "projectCatalog"; projects: WorkbenchProjectStartup }
  | { id: number; type: "projectAliases"; aliases: WorkbenchProjectAlias[] }
  | { id: number; type: "projectIdentity"; projectId: ProjectId }
  | { id: number; type: "projectIconSettlement"; accepted: boolean }
  | { id: number; type: "threadLaunch"; launch: WorkbenchThreadLaunchState | null;
      request?: WorkbenchThreadLaunchRequest; location?: WorkbenchThreadLaunchLocation }
  | { id: number; type: "migrationCheckpoint"; backupPath: string }
  | { id: number; type: "suspended" }
  | { id: number; type: "inventory"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "mutationResult"; result: WorkbenchDatabaseMutationResult }
  | { id: number; type: "queryResult"; rows: WorkbenchDatabaseRow[] }
  | { id: number; type: "gitArcProposalDiff"; changes: GitCheckpointFileChange[] | null }
  | { id: number; type: "threadIdentity"; identity: WorkbenchThreadIdentityRecord | null }
  | { id: number; type: "turnIdentities"; identities: WorkbenchTurnIdentityRecord[] }
  | { id: number; type: "threadIdentities"; identities: WorkbenchThreadIdentityRecord[] }
  | { id: number; type: "turnIdentity"; identity: WorkbenchTurnIdentityRecord | null }
  | { id: number; type: "transcriptItemIdentities"; identities: WorkbenchTranscriptItemIdentity[] }
  | { id: number; type: "transcriptItemIdentity"; identity: WorkbenchTranscriptItemIdentity | null }
  | { id: number; type: "threadStateProject"; document: WorkbenchThreadStateProjectDocument }
  | { id: number; type: "threadStateTitleHistories"; histories: WorkbenchStoredThreadTitleHistory[] }
  | { id: number; type: "threadStateGlobal"; document: WorkbenchThreadStateGlobalDocument | null }
  | { id: number; type: "threadStateRecords"; records: WorkbenchThreadStateRecord[] }
  | { id: number; type: "threadStateDrafts"; drafts: WorkbenchStoredThreadDraft[] }
  | { id: number; type: "threadStateProfile"; profile: WorkbenchComposerProfileSelectionState | null }
  | { id: number; type: "threadStateLayout"; layout: { revision: number; displayOrder: ThreadDisplayLayout } | null }
  | { id: number; type: "threadStatePinnedImports"; projectIds: ProjectId[] }
  | { id: number; type: "threadStateArchiveDeadline"; activeAt: number | null }
  | { id: number; type: "threadStateActivity"; activityAt: number | null }
  | { id: number; type: "threadStateSnoozeSources"; sources: Array<{ projectId: ProjectId; threadId: WorkbenchThreadId }> }
  | { id: number; type: "threadStateArchiveEligible"; records: Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }> }
  | { id: number; type: "subagents"; records: WorkbenchSubagentRelationship[] | null }
  | { id: number; type: "subagentReservation"; record: WorkbenchSubagentReservation }
  | { id: number; type: "transcriptSettlement"; settlement: WorkbenchTranscriptSettlement }
  | { id: number; type: "transcriptSnapshot"; snapshot: WorkbenchTranscriptSnapshot | null }
  | { id: number; type: "transcriptContext"; snapshot: WorkbenchTranscriptContextSnapshot | null }
  | { id: number; type: "transcriptProviderCursor"; cursor: string | null | undefined }
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
