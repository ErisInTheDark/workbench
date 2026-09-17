/*
 * Exports:
 * - WorkbenchDaemonMethod/WorkbenchDaemonRequestMap: typed browser-to-daemon request contract.
 * - WorkbenchQuestionnaireRespondRequest/WorkbenchQuestionnaireRespondResult: daemon-owned questionnaire answer contract.
 * - WorkbenchAgentDefinitionResponse/WorkbenchSkillCatalogResponse: agent and skill catalogue results.
 * - WorkbenchGitArcSuccess: exact acknowledgement for browser Git arc mutations.
 * - WORKBENCH_GIT_ARC_ACTION_BY_METHOD/WorkbenchDaemonGitArcMethod: map browser methods to existing Git actions.
 * - WorkbenchInstructionPack: emitted instruction pack metadata and content.
 * - WorkbenchFileWriteResult: successful save or optimistic-write conflict.
 * - WorkbenchDaemonParams/WorkbenchDaemonResult: method-indexed request and response types.
 */
import type {
  FilePayload,
  OpenFileInEditorRequest,
  OpenFileInEditorResponse,
  ResolveExternalFileLinkRootsRequest,
  ResolveExternalFileLinkRootsResponse,
  RevealProjectEntryRequest,
  RevealProjectEntryResponse,
  SaveConflictPayload,
  SaveFilePayload,
  WorkbenchAgentDefinition,
  WorkbenchAgentOption,
  WorkbenchBrowseSessionControlRequest,
  WorkbenchBrowseSessionControlResponse,
  WorkbenchBrowseSessionListRequest,
  WorkbenchBrowseSessionListResponse,
  WorkbenchComposerProfile,
  WorkbenchComposerProfileChanges,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerProfileStorePayload,
  WorkbenchLocalCapabilitySettingsResponse,
  WorkbenchLocalCapabilitySettingsUpdateRequest,
  WorkbenchProjectsPayload,
  WorkbenchModelContextCapability,
  WorkbenchHarness,
  WorkbenchSkillSummary,
  WorkbenchUserInputResponse,
} from "../../types.ts";
import type { WorkbenchUserInput as UserInput } from "../provider/provider-input.ts";
import type { WorkbenchThreadActionMap } from "../thread/thread-actions.ts";
import type { WorkbenchModelOption } from "../provider/provider-model.ts";
import type { WorkbenchAccountLimits } from "../provider/provider-account.ts";
import type {
  GitCheckpointCompareResult,
  GitCheckpointProposal,
  GitCheckpointRequest,
} from "../git/checkpoint-contracts.ts";
import type {
  WorkbenchSearchRequest,
  WorkbenchSearchResponse,
} from "../search/workbench-search.ts";
import type {
  WorkbenchStatsImportProgress,
  WorkbenchStatsReadRequest,
  WorkbenchStatsResponse,
} from "../stats/workbench-stats-contract.ts";
import type {
  WorkbenchThreadIdentityResolution,
  WorkbenchThreadIdentityResolveRequest,
} from "../thread/workbench-thread-identity.ts";

export interface WorkbenchInstructionPack {
  content: string;
  name: string;
  path: string;
}

export interface WorkbenchAgentDefinitionResponse {
  providerGlobalDuplicate: boolean;
  data: WorkbenchAgentDefinition;
}

export interface WorkbenchSkillCatalogResponse {
  data: WorkbenchSkillSummary[];
  instructionPacks: WorkbenchInstructionPack[];
  instructions: string;
}

export type WorkbenchFileWriteResult = SaveFilePayload | SaveConflictPayload;

export interface WorkbenchGitArcSuccess {
  ok: true;
}

export interface WorkbenchQuestionnaireRespondRequest {
  activatedSkillPaths?: string[];
  harness?: WorkbenchHarness;
  insertAfterItemId?: string | null;
  insertAfterItemIndex?: number | null;
  projectId: string;
  requestKey: string;
  response: WorkbenchUserInputResponse;
  supplementalInput?: UserInput[];
  threadId: string;
  turnId?: string | null;
}

export interface WorkbenchQuestionnaireRespondResult {
  ok: true;
  route: "admitted" | "live" | "provider";
  warning?: string;
}

type GitArcParams<TAction extends GitCheckpointRequest["action"]> = Omit<
  Extract<GitCheckpointRequest, { action: TAction }>,
  "action"
>;

export const WORKBENCH_GIT_ARC_ACTION_BY_METHOD = {
  "git/arc/compare": "compare",
  "git/arc/diff-artifact/read": "readDiffArtifact",
  "git/arc/proposal/commit": "proposalCommit",
  "git/arc/proposal/read": "proposalState",
  "git/arc/release": "arcRelease",
  "git/arc/remove": "arcRemove",
  "git/arc/restore": "restore",
} as const satisfies Record<string, GitCheckpointRequest["action"]>;

export type WorkbenchDaemonGitArcMethod = keyof typeof WORKBENCH_GIT_ARC_ACTION_BY_METHOD;

export interface WorkbenchDaemonRequestMap extends WorkbenchThreadActionMap {
  "voice/configuration/read": { params: object; result: import("../voice/voice-session-contract").VoiceConfiguration };
  "voice/configuration/write": { params: import("../voice/voice-session-contract").VoiceConfiguration; result: { ok: true } };
  "voice/agents": { params: object; result: { data: import("../../types").WorkbenchAgentOption[] } };
  "voice/prepare": { params: object; result: { ok: true } };
  "voice/start": { params: import("../voice/voice-session-contract").VoiceStart; result: { ok: true } };
  "voice/audio": { params: import("../voice/voice-session-contract").VoiceAudio; result: { ok: true } };
  "voice/finish": { params: { sessionId: string }; result: { ok: true } };
  "voice/cancel": { params: { sessionId: string }; result: { ok: true } };
  "git/working-tree/read": { params: { projectId: string; preferCached?: boolean }; result: import("../git/working-tree-contracts").WorkingTreeRead };
  "git/working-tree/diff": { params: import("../git/working-tree-contracts").WorkingTreeFileRequest; result: import("../git/working-tree-contracts").WorkingTreeDiff };
  "git/working-tree/preview": { params: import("../git/working-tree-contracts").WorkingTreeFileRequest; result: import("../git/working-tree-contracts").WorkingTreePreview };
  "git/working-tree/mutate": { params: import("../git/working-tree-contracts").WorkingTreeMutation; result: import("../git/working-tree-contracts").WorkingTreeResult };
  "models/context/read": { params: { provider: string }; result: { data: WorkbenchModelContextCapability[] } };
  "models/list": { params: { provider: string }; result: { data: WorkbenchModelOption[] } };
  "account/limits/read": { params: { provider: string }; result: WorkbenchAccountLimits };
  "agents/list": { params: { projectId: string }; result: { data: WorkbenchAgentOption[] } };
  "agents/read": { params: { agentPath: string; projectId: string; provider: string }; result: WorkbenchAgentDefinitionResponse };
  "browse/sessions/forget": { params: BrowseSessionParams; result: WorkbenchBrowseSessionControlResponse };
  "browse/sessions/read": { params: WorkbenchBrowseSessionListRequest; result: WorkbenchBrowseSessionListResponse };
  "browse/sessions/stop": { params: BrowseSessionParams; result: WorkbenchBrowseSessionControlResponse };
  "sandbox-network/read": { params: { projectId: string }; result: import("../provider/provider-settings").WorkbenchSandboxNetworkSettingsResponse };
  "sandbox-network/update": { params: import("../provider/provider-settings").WorkbenchSandboxNetworkUpdate; result: import("../provider/provider-settings").WorkbenchSandboxNetworkSettingsResponse };
  "git/arc/compare": { params: GitArcParams<"compare">; result: GitCheckpointCompareResult };
  "git/arc/diff-artifact/read": { params: GitArcParams<"readDiffArtifact">; result: string };
  "git/arc/proposal/commit": { params: GitArcParams<"proposalCommit">; result: GitCheckpointProposal };
  "git/arc/proposal/read": { params: GitArcParams<"proposalState">; result: GitCheckpointProposal };
  "git/arc/release": { params: GitArcParams<"arcRelease">; result: WorkbenchGitArcSuccess };
  "git/arc/remove": { params: GitArcParams<"arcRemove">; result: WorkbenchGitArcSuccess };
  "git/arc/restore": { params: GitArcParams<"restore">; result: WorkbenchGitArcSuccess };
  "local-capabilities/read": { params: object; result: WorkbenchLocalCapabilitySettingsResponse };
  "local-capabilities/update": { params: WorkbenchLocalCapabilitySettingsUpdateRequest; result: WorkbenchLocalCapabilitySettingsResponse };
  "native/file/link-roots": { params: ResolveExternalFileLinkRootsRequest; result: ResolveExternalFileLinkRootsResponse };
  "native/file/open": { params: OpenFileInEditorRequest; result: OpenFileInEditorResponse };
  "native/file/reveal": { params: RevealProjectEntryRequest; result: RevealProjectEntryResponse };
  "profiles/delete": { params: { profileId: string }; result: WorkbenchComposerProfileStorePayload };
  "profiles/read": { params: object; result: WorkbenchComposerProfileStorePayload };
  "profiles/target/read": { params: { slot: WorkbenchComposerProfileSlot }; result: { selection: WorkbenchComposerProfileTargetSelection | null } };
  "profiles/target/set": { params: { selection: WorkbenchComposerProfileTargetSelection; slot: WorkbenchComposerProfileSlot }; result: { ok: true } };
  "profiles/upsert": { params: { profile: WorkbenchComposerProfile; changes?: WorkbenchComposerProfileChanges }; result: WorkbenchComposerProfileStorePayload };
  "project/catalog/read": { params: object; result: WorkbenchProjectsPayload };
  "project/file/read": { params: { path: string; projectId: string }; result: FilePayload };
  "project/file/reset": { params: { expectedMtimeMs: number; force?: boolean; path: string; projectId: string }; result: WorkbenchFileWriteResult };
  "project/file/save": { params: { content: string; expectedMtimeMs: number; force?: boolean; path: string; projectId: string }; result: WorkbenchFileWriteResult };
  "search/query": { params: WorkbenchSearchRequest; result: WorkbenchSearchResponse };
  "questionnaire/respond": { params: WorkbenchQuestionnaireRespondRequest; result: WorkbenchQuestionnaireRespondResult };
  "stats/import/start": { params: object; result: WorkbenchStatsImportProgress };
  "stats/rate-limits/refresh": { params: object; result: { ok: true } };
  "stats/read": { params: WorkbenchStatsReadRequest; result: WorkbenchStatsResponse };
  "stats/read/detailed": {
    params: import("../stats/workbench-stats-detail-contract.ts").WorkbenchStatsDetailedReadRequest;
    result: import("../stats/workbench-stats-detail-contract.ts").WorkbenchStatsDetailedResponse;
  };
  "stats/read/efficiency": {
    params: import("../stats/workbench-stats-detail-contract.ts").WorkbenchStatsDetailedReadRequest;
    result: import("../stats/workbench-stats-detail-contract.ts").WorkbenchStatsDetailedResponse;
  };
  "stats/read/efficiency/v2": {
    params: import("../stats/workbench-stats-detail-contract.ts").WorkbenchStatsDetailedReadRequest;
    result: import("../stats/workbench-stats-detail-contract.ts").WorkbenchStatsDetailedResponse;
  };
  "skills/read": { params: { projectId: string | null; provider: string }; result: WorkbenchSkillCatalogResponse };
  "thread/identity/resolve": { params: WorkbenchThreadIdentityResolveRequest; result: { data: WorkbenchThreadIdentityResolution | null } };
}

type BrowseSessionParams = Omit<WorkbenchBrowseSessionControlRequest, "action">;

export type WorkbenchDaemonMethod = keyof WorkbenchDaemonRequestMap;
export type WorkbenchDaemonParams<TMethod extends WorkbenchDaemonMethod> = WorkbenchDaemonRequestMap[TMethod]["params"];
export type WorkbenchDaemonResult<TMethod extends WorkbenchDaemonMethod> = WorkbenchDaemonRequestMap[TMethod]["result"];
