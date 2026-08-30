/*
 * Exports:
 * - WorkbenchDaemonMethod/WorkbenchDaemonRequestMap: typed semantic browser-to-daemon request contract. Keywords: daemon, websocket, rpc, contract.
 * - WorkbenchAgentDefinitionResponse/WorkbenchSkillCatalogResponse: agent and skill catalog result contracts. Keywords: agent, skill, catalog.
 * - WorkbenchGitArcSuccess: exact acknowledgement for browser Git arc mutations. Keywords: git, arc, acknowledgement.
 * - WORKBENCH_GIT_ARC_ACTION_BY_METHOD/WorkbenchDaemonGitArcMethod: map semantic browser methods to existing Git actions. Keywords: git, arc, method, registry.
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
  WorkbenchComposerProfileStorePayload,
  WorkbenchLocalCapabilitySettingsResponse,
  WorkbenchLocalCapabilitySettingsUpdateRequest,
  WorkbenchProjectsPayload,
  WorkbenchSkillSummary,
} from "../../types";
import type {
  GitCheckpointCompareResult,
  GitCheckpointProposal,
  GitCheckpointRequest,
} from "../git/checkpoint-contracts";

export interface WorkbenchInstructionPack {
  content: string;
  name: string;
  path: string;
}

export interface WorkbenchAgentDefinitionResponse {
  codexGlobalDuplicate: boolean;
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

type GitArcParams<TAction extends GitCheckpointRequest["action"]> = Omit<
  Extract<GitCheckpointRequest, { action: TAction }>,
  "action"
>;

export const WORKBENCH_GIT_ARC_ACTION_BY_METHOD = {
  "git/arc/compare": "compare",
  "git/arc/diff-artifact/read": "readDiffArtifact",
  "git/arc/proposal/commit": "proposalCommit",
  "git/arc/proposal/read": "proposalState",
  "git/arc/remove": "arcRemove",
  "git/arc/restore": "restore",
} as const satisfies Record<string, GitCheckpointRequest["action"]>;

export type WorkbenchDaemonGitArcMethod = keyof typeof WORKBENCH_GIT_ARC_ACTION_BY_METHOD;

export interface WorkbenchDaemonRequestMap {
  "agents/list": { params: { projectId: string }; result: { data: WorkbenchAgentOption[] } };
  "agents/read": { params: { agentPath: string; projectId: string }; result: WorkbenchAgentDefinitionResponse };
  "browse/sessions/forget": { params: BrowseSessionParams; result: WorkbenchBrowseSessionControlResponse };
  "browse/sessions/read": { params: WorkbenchBrowseSessionListRequest; result: WorkbenchBrowseSessionListResponse };
  "browse/sessions/stop": { params: BrowseSessionParams; result: WorkbenchBrowseSessionControlResponse };
  "git/arc/compare": { params: GitArcParams<"compare">; result: GitCheckpointCompareResult };
  "git/arc/diff-artifact/read": { params: GitArcParams<"readDiffArtifact">; result: string };
  "git/arc/proposal/commit": { params: GitArcParams<"proposalCommit">; result: GitCheckpointProposal };
  "git/arc/proposal/read": { params: GitArcParams<"proposalState">; result: GitCheckpointProposal };
  "git/arc/remove": { params: GitArcParams<"arcRemove">; result: WorkbenchGitArcSuccess };
  "git/arc/restore": { params: GitArcParams<"restore">; result: WorkbenchGitArcSuccess };
  "local-capabilities/read": { params: object; result: WorkbenchLocalCapabilitySettingsResponse };
  "local-capabilities/update": { params: WorkbenchLocalCapabilitySettingsUpdateRequest; result: WorkbenchLocalCapabilitySettingsResponse };
  "native/file/link-roots": { params: ResolveExternalFileLinkRootsRequest; result: ResolveExternalFileLinkRootsResponse };
  "native/file/open": { params: OpenFileInEditorRequest; result: OpenFileInEditorResponse };
  "native/file/reveal": { params: RevealProjectEntryRequest; result: RevealProjectEntryResponse };
  "profiles/delete": { params: { profileId: string }; result: WorkbenchComposerProfileStorePayload };
  "profiles/read": { params: object; result: WorkbenchComposerProfileStorePayload };
  "profiles/upsert": { params: { profile: WorkbenchComposerProfile }; result: WorkbenchComposerProfileStorePayload };
  "project/catalog/read": { params: object; result: WorkbenchProjectsPayload };
  "project/file/read": { params: { path: string; projectId: string }; result: FilePayload };
  "project/file/reset": { params: { expectedMtimeMs: number; force?: boolean; path: string; projectId: string }; result: WorkbenchFileWriteResult };
  "project/file/save": { params: { content: string; expectedMtimeMs: number; force?: boolean; path: string; projectId: string }; result: WorkbenchFileWriteResult };
  "skills/read": { params: { projectId: string | null }; result: WorkbenchSkillCatalogResponse };
}

type BrowseSessionParams = Omit<WorkbenchBrowseSessionControlRequest, "action">;

export type WorkbenchDaemonMethod = keyof WorkbenchDaemonRequestMap;
export type WorkbenchDaemonParams<TMethod extends WorkbenchDaemonMethod> = WorkbenchDaemonRequestMap[TMethod]["params"];
export type WorkbenchDaemonResult<TMethod extends WorkbenchDaemonMethod> = WorkbenchDaemonRequestMap[TMethod]["result"];
