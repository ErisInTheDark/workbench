/*
 * Exports:
 * - WorkbenchHarness: supported agent harness identity.
 * - OrchestratorReloadScope: reloadable orchestrator subsystem identity.
 * - OrchestratorReloadState: orchestrator reload lifecycle state.
 * - OrchestratorReloadRequest: orchestrator reload request contract.
 * - OrchestratorReloadResponse: orchestrator reload response contract.
 * - WorkbenchReloadDirtScope/WorkbenchReloadDirtSnapshot: shared app and daemon reload dirt.
 * - WorkbenchAppRuntimeStore: browser-facing app reload observation and command port.
 * - WorkbenchOrchestratorRuntimeStore: browser-facing orchestrator reload observation and command port.
 * - WorkbenchLocalCapabilitySettings: local capability settings contract.
 * - WorkbenchLocalCapabilitySettingsResponse: local capability read response.
 * - WorkbenchLocalCapabilitySettingsUpdateRequest: local capability update request.
 * - WorkbenchCodexSandboxNetworkSettings: resolved server-owned Codex sandbox network settings.
 * - WorkbenchCodexSandboxNetworkSettingsResponse: Codex sandbox network settings response.
 * - WorkbenchCodexSandboxNetworkSettingsUpdateRequest: global or project Codex sandbox network mutation.
 * - WorkbenchBrowseCommandRequest: Browse command request contract.
 * - WorkbenchBrowseCommandResponse: Browse command response contract.
 * - WorkbenchBrowseSessionMode: Browse headed/headless mode.
 * - WorkbenchBrowseSessionLifecycleState: Browse session lifecycle state.
 * - WorkbenchBrowseSessionSource: Browse session ownership source.
 * - WorkbenchBrowseSessionSummary: Browse session summary contract.
 * - WorkbenchBrowseSessionListRequest: Browse session list request.
 * - WorkbenchBrowseSessionListResponse: Browse session list response.
 * - WorkbenchBrowseSessionControlRequest: Browse session control request.
 * - WorkbenchBrowseSessionControlResponse: Browse session control response.
 * - WorkbenchBrowseAgentWaitState: Browse navigation wait state.
 * - WorkbenchBrowseAgentWaitSelectorState: Browse selector wait state.
 * - WorkbenchBrowseAgentAction: Browse action union.
 * - WorkbenchBrowseAgentBaseRequest: common Browse agent request fields.
 * - WorkbenchBrowseAgentActionName: Browse action name union.
 * - WorkbenchBrowseAgentSessionRequest: Browse session request fields.
 * - WorkbenchBrowseAgentBrowserRequest: active-browser request fields.
 * - WorkbenchBrowseAgentDoctorRequest: Browse doctor request.
 * - WorkbenchBrowseAgentStatusRequest: Browse status request.
 * - WorkbenchBrowseAgentOpenRequest: Browse open request.
 * - WorkbenchBrowseAgentSnapshotRequest: Browse snapshot request.
 * - WorkbenchBrowseAgentClickRequest: Browse click request.
 * - WorkbenchBrowseAgentFillRequest: Browse fill request.
 * - WorkbenchBrowseAgentEvalRequest: Browse evaluation request.
 * - WorkbenchBrowseAgentGetRequest: Browse property-read request.
 * - WorkbenchBrowseAgentHighlightRequest: Browse highlight request.
 * - WorkbenchBrowseAgentIsRequest: Browse predicate request.
 * - WorkbenchBrowseAgentTypeRequest: Browse type request.
 * - WorkbenchBrowseAgentKeyRequest: Browse key request.
 * - WorkbenchBrowseAgentMouseClickRequest: Browse mouse-click request.
 * - WorkbenchBrowseAgentMouseHoverRequest: Browse mouse-hover request.
 * - WorkbenchBrowseAgentMouseDragRequest: Browse mouse-drag request.
 * - WorkbenchBrowseAgentMouseScrollRequest: Browse mouse-scroll request.
 * - WorkbenchBrowseAgentCursorRequest: Browse cursor request.
 * - WorkbenchBrowseAgentSelectRequest: Browse select request.
 * - WorkbenchBrowseAgentSessionsRequest: Browse sessions request.
 * - WorkbenchBrowseAgentWaitRequest: Browse wait request.
 * - WorkbenchBrowseAgentNavigationRequest: common Browse navigation request.
 * - WorkbenchBrowseAgentBackRequest: Browse back request.
 * - WorkbenchBrowseAgentForwardRequest: Browse forward request.
 * - WorkbenchBrowseAgentForgetRequest: Browse profile-forget request.
 * - WorkbenchBrowseAgentReloadRequest: Browse reload request.
 * - WorkbenchBrowseAgentScreenshotRequest: Browse screenshot request.
 * - WorkbenchBrowseAgentRefsRequest: Browse refs request.
 * - WorkbenchBrowseAgentViewportRequest: Browse viewport request.
 * - WorkbenchBrowseAgentStopRequest: Browse stop request.
 * - WorkbenchBrowseAgentCleanupRequest: Browse cleanup request.
 * - WorkbenchBrowseAgentSequenceRequest: Browse action-sequence request.
 * - WorkbenchBrowseAgentScriptRequest: Browse script request union.
 * - WorkbenchBrowseAgentScriptBaseRequest: common Browse script fields.
 * - WorkbenchBrowseAgentScriptInlineRequest: inline Browse script request.
 * - WorkbenchBrowseAgentScriptFileRequest: file Browse script request.
 * - WorkbenchBrowseAgentResponse: Browse agent response contract.
 * - WorkbenchBrowseAgentSequenceResponse: Browse sequence response.
 * - WorkbenchBrowseAgentSequenceProgressEvent: Browse sequence progress union.
 * - WorkbenchBrowseResultEntryState: Browse result lifecycle state.
 * - WorkbenchBrowseResultEntryDetailKind: Browse result detail kind.
 * - WorkbenchBrowseResultEntry: persisted Browse result contract.
 * - WorkbenchAgentOption: selectable agent option.
 * - WorkbenchAgentDefinition: resolved agent definition.
 * - WorkbenchSkillSummary: selectable skill summary.
 * - WorkbenchSkillDefinition: resolved skill definition.
 * - WorkbenchProjectIcon: selected project icon asset descriptor.
 * - WorkbenchProjectOption: selectable project option.
 * - WorkbenchProjectRoot: project-root contract.
 * - WorkbenchProjectsPayload: project-list payload.
 * - WorkbenchModelOption: selectable model option.
 * - WorkbenchComposerSettings: composer settings contract.
 * - WorkbenchComposerProfileScope: composer profile scope.
 * - WorkbenchComposerProfile: stored composer profile.
 * - WorkbenchComposerProfileMutation: composer profile mutation union.
 * - WorkbenchComposerProfileStorePayload: composer profile store payload.
 * - WorkbenchSubagentRelationship: subagent relationship contract.
 * - WorkbenchSubagentSummary: subagent summary alias.
 * - WorkbenchSubagentPage: paginated subagent response.
 * - WorkbenchComposerProfileSlot: composer profile slot identity.
 * - WorkbenchComposerProfileSelection/WorkbenchComposerProfileTargetSelection: unloaded browser selection and exact durable target selection.
 * - WorkbenchListModelsOptions: model-list options.
 * - ChangeSummary: file-change summary.
 * - ThreadSummary: thread-list summary.
 * - ThreadPayload: full rendered thread payload.
 * - WorkbenchThreadTitleRequest: provider-backed thread title mutation request.
 * - WorkbenchThreadDocumentSnapshot: thread document-store snapshot.
 * - WorkbenchThreadTurnLoadState: turn hydration state.
 * - WorkbenchThreadTurnHistoryEntry: turn history metadata.
 * - WorkbenchThreadContextEntryScope: identifies which turn-owned context entries a thread read returned.
 * - WorkbenchReadThreadOptions: thread-read options.
 * - WorkbenchSendThreadMessageOptions: thread-send options.
 * - WorkbenchThreadComposerAttachmentDraft: draft attachment contract.
 * - WorkbenchComposerInputDraft: ephemeral composer input contract used by rich editors and durable-draft bindings.
 * - WorkbenchQuestionnaireDraft: questionnaire draft state.
 * - WorkbenchUserInputOption: questionnaire answer option.
 * - WorkbenchUserInputQuestion: questionnaire question contract.
 * - WorkbenchApprovalCommandContext: approval command context.
 * - WorkbenchUserInputApprovalContext: approval request context.
 * - WorkbenchUserInputRequest: questionnaire request contract.
 * - WorkbenchUserInputAnswer: questionnaire answer contract.
 * - WorkbenchUserInputResponse: questionnaire response contract.
 * - WorkbenchSubmitUserInputRequestOptions: questionnaire submission options.
 * - WorkbenchPendingUserInputRequest: pending questionnaire state.
 * - WorkbenchQuestionnaireHistoryEntry: questionnaire history entry.
 * - WorkbenchSteerHistoryStatus: steer delivery lifecycle state.
 * - WorkbenchSteerHistoryEntry: correlated steer history entry.
 * - WorkbenchThreadContextReadResponse: context-read response.
 * - WorkbenchThreadContextBundle: thread context projection bundle.
 * - WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS: recall response size limit.
 * - WorkbenchThreadRecallKind: recall record kind.
 * - WorkbenchThreadRecallSearchRequest: recall search request.
 * - WorkbenchThreadRecallExpandRequest: recall expansion request.
 * - WorkbenchThreadRecallRequest: recall request union.
 * - FileNode: project-tree file node.
 * - DirectoryNode: project-tree directory node.
 * - TreeNode: project-tree node union.
 * - ProjectSnapshot: project snapshot contract.
 * - ExplorerSnapshot: explorer snapshot contract.
 * - WorkbenchThreadSidebarStore: read-only live sidebar store contract.
 * - WorkbenchThreadRuntimeSnapshot/WorkbenchThreadRuntimeStore: provider-facing thread state and subscription boundary. Keywords: thread runtime, domain hook, React.
 * - WorkbenchRouteLoadResult: route-load result.
 * - WorkbenchControls: top-level Workbench command surface.
 * - WorkbenchThreadGoalSnapshot: thread goal state.
 * - WorkbenchThreadGoalControls: thread goal command surface.
 * - WorkbenchBindings: Workbench UI bindings contract.
 * - FilePayload: file-read payload.
 * - CreateEntryPayload: project entry creation payload.
 * - DeleteFileRequest: file deletion request.
 * - DeleteFileConfirmationRequired: file deletion confirmation response.
 * - DeleteFilePayload: completed file deletion payload.
 * - DeleteFileResponse: file deletion response union.
 * - SaveFilePayload: saved file payload.
 * - SaveConflictPayload: save conflict payload.
 * - WorkbenchFileOpenTarget: editor-open target.
 * - OpenFileInEditorRequest: editor-open request.
 * - OpenFileInEditorResponse: editor-open response.
 * - RevealProjectEntryRequest: explorer reveal request.
 * - RevealProjectEntryResponse: explorer reveal response.
 * - ResolveExternalFileLinkRootsRequest: external-link root request.
 * - ExternalFileLinkRoot: resolved external-link root.
 * - ResolveExternalFileLinkRootsResponse: external-link root response.
 */

import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";
import type { CommandAction } from "./codex/generated/app-server/v2/CommandAction";
import type { Thread } from "./codex/generated/app-server/v2/Thread";
import type { ThreadGoal } from "./codex/generated/app-server/v2/ThreadGoal";
import type { ThreadTokenUsage } from "./codex/generated/app-server/v2/ThreadTokenUsage";
import type { Turn } from "./codex/generated/app-server/v2/Turn";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import type { WorkbenchRoute } from "./workbench/navigation/workbench-route";
import type WorkbenchDaemonClient from "./workbench/daemon/WorkbenchDaemonClient";
import type { OrchestratorReloadResponse, OrchestratorReloadScope } from "./workbench/orchestrator-reload";
import type { WorkbenchReloadDirtSnapshot as SharedWorkbenchReloadDirtSnapshot, WorkbenchReloadDirtScope as SharedWorkbenchReloadDirtScope, WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";
import type { ProjectTreeFileCandidate } from "./workbench/project/ProjectTreeFileIndex";
import type { WorkbenchThreadItemTimelineEntry } from "./workbench/thread/thread-item-timeline";
import type { WorkbenchHomeThreadDisplayOrderSnapshot, WorkbenchPinnedThreadLayoutSnapshot, WorkbenchProjectThreadSidebars, WorkbenchProjectThreadSummaries, WorkbenchThreadDraft, WorkbenchThreadSidebarSnapshot, WorkbenchThreadStateRequest } from "./workbench/thread/thread-state";
import type { WorkbenchTranscriptProjection } from "./workbench/transcript/workbench-transcript-projection";

export type WorkbenchHarness = "codex" | "copilot" | "opencode";
export type {
  OrchestratorReloadRequest,
  OrchestratorReloadResponse,
  OrchestratorReloadScope,
  OrchestratorReloadState,
} from "./workbench/orchestrator-reload";

export type WorkbenchReloadDirtScope = SharedWorkbenchReloadDirtScope;
export type WorkbenchReloadDirtSnapshot = SharedWorkbenchReloadDirtSnapshot;

export interface WorkbenchAppRuntimeStore {
  getSnapshot(): WorkbenchReloadDirtSnapshot;
  reloadScopes(scopes: readonly WorkbenchReloadScope[]): Promise<WorkbenchReloadResponse>;
  subscribe(listener: () => void): () => void;
}

export interface WorkbenchOrchestratorRuntimeStore {
  getSnapshot(): WorkbenchReloadDirtSnapshot;
  reloadScopes(scopes: readonly OrchestratorReloadScope[]): Promise<OrchestratorReloadResponse>;
  subscribe(listener: () => void): () => void;
}

export interface WorkbenchLocalCapabilitySettings {
  browseRawCommandsEnabled: boolean;
}

export interface WorkbenchLocalCapabilitySettingsResponse {
  localCapabilities: WorkbenchLocalCapabilitySettings;
}

export interface WorkbenchLocalCapabilitySettingsUpdateRequest {
  localCapabilities: Partial<WorkbenchLocalCapabilitySettings>;
}

export interface WorkbenchCodexSandboxNetworkSettings {
  effectiveEnabled: boolean;
  globalEnabled: boolean;
  projectId: string;
  projectOverride: boolean | null;
}

export interface WorkbenchCodexSandboxNetworkSettingsResponse {
  codexSandboxNetwork: WorkbenchCodexSandboxNetworkSettings;
}

export interface WorkbenchCodexSandboxNetworkSettingsUpdateRequest {
  enabled: boolean | null;
  projectId: string;
  scope: "global" | "project";
}

export interface WorkbenchBrowseCommandRequest {
  args: string[];
  cwd?: string | null;
  projectId?: string | null;
  stdin?: string | null;
  threadId: string;
  timeoutMs?: number | null;
}

export interface WorkbenchBrowseCommandResponse {
  assetUrl?: string;
  disabled?: boolean;
  durationMs: number;
  error?: string;
  exitCode: number | null;
  ok: boolean;
  stderr: string;
  steered?: boolean;
  steerTurnId?: string;
  stdout: string;
  timedOut?: boolean;
}

export type WorkbenchBrowseSessionMode = "headed" | "headless";

export type WorkbenchBrowseSessionLifecycleState =
  | "orphan"
  | "running"
  | "stale"
  | "stopped"
  | "unknown";

export type WorkbenchBrowseSessionSource =
  | "registry"
  | "registry-and-runtime"
  | "runtime";

export interface WorkbenchBrowseSessionSummary {
  browserConnected: boolean | null;
  cwd: string | null;
  inactiveSince: string | null;
  initialized: boolean | null;
  lastActionAt: string | null;
  mode: WorkbenchBrowseSessionMode | null;
  name: string;
  pid: number | null;
  projectId: string | null;
  projectRootPath: string | null;
  source: WorkbenchBrowseSessionSource;
  state: WorkbenchBrowseSessionLifecycleState;
  statusError: string | null;
  threadId: string | null;
}

export interface WorkbenchBrowseSessionListRequest {
  cwd?: string | null;
  includeRuntime?: boolean | null;
  projectId?: string | null;
  threadId?: string | null;
  timeoutMs?: number | null;
}

export interface WorkbenchBrowseSessionListResponse {
  generatedAt: string;
  projectId: string | null;
  sessions: WorkbenchBrowseSessionSummary[];
}

export interface WorkbenchBrowseSessionControlRequest {
  action: "forget" | "stop";
  cwd?: string | null;
  force?: boolean | null;
  projectId?: string | null;
  session: string;
  threadId?: string | null;
  timeoutMs?: number | null;
}

export interface WorkbenchBrowseSessionControlResponse {
  result: WorkbenchBrowseCommandResponse | null;
  session: WorkbenchBrowseSessionSummary | null;
  stopped: boolean;
}

export type WorkbenchBrowseAgentWaitState = "commit" | "domcontentloaded" | "load" | "networkidle";

export type WorkbenchBrowseAgentWaitSelectorState = "attached" | "detached" | "hidden" | "visible";

export type WorkbenchBrowseAgentAction =
  | WorkbenchBrowseAgentBackRequest
  | WorkbenchBrowseAgentClickRequest
  | WorkbenchBrowseAgentCleanupRequest
  | WorkbenchBrowseAgentCursorRequest
  | WorkbenchBrowseAgentDoctorRequest
  | WorkbenchBrowseAgentEvalRequest
  | WorkbenchBrowseAgentFillRequest
  | WorkbenchBrowseAgentForgetRequest
  | WorkbenchBrowseAgentForwardRequest
  | WorkbenchBrowseAgentGetRequest
  | WorkbenchBrowseAgentHighlightRequest
  | WorkbenchBrowseAgentIsRequest
  | WorkbenchBrowseAgentKeyRequest
  | WorkbenchBrowseAgentMouseClickRequest
  | WorkbenchBrowseAgentMouseDragRequest
  | WorkbenchBrowseAgentMouseHoverRequest
  | WorkbenchBrowseAgentMouseScrollRequest
  | WorkbenchBrowseAgentOpenRequest
  | WorkbenchBrowseAgentRefsRequest
  | WorkbenchBrowseAgentReloadRequest
  | WorkbenchBrowseAgentScreenshotRequest
  | WorkbenchBrowseAgentSelectRequest
  | WorkbenchBrowseAgentSessionsRequest
  | WorkbenchBrowseAgentSnapshotRequest
  | WorkbenchBrowseAgentStatusRequest
  | WorkbenchBrowseAgentStopRequest
  | WorkbenchBrowseAgentTypeRequest
  | WorkbenchBrowseAgentViewportRequest
  | WorkbenchBrowseAgentWaitRequest;

export interface WorkbenchBrowseAgentBaseRequest {
  action: WorkbenchBrowseAgentActionName;
  cwd?: string | null;
  projectId?: string | null;
  threadId: string;
  timeoutMs?: number | null;
}

export type WorkbenchBrowseAgentActionName =
  | "back"
  | "cleanup"
  | "click"
  | "doctor"
  | "cursor"
  | "eval"
  | "fill"
  | "forget"
  | "forward"
  | "get"
  | "highlight"
  | "is"
  | "key"
  | "mouseClick"
  | "mouseDrag"
  | "mouseHover"
  | "mouseScroll"
  | "open"
  | "refs"
  | "reload"
  | "screenshot"
  | "select"
  | "sessions"
  | "snapshot"
  | "status"
  | "stop"
  | "type"
  | "viewport"
  | "wait";

export interface WorkbenchBrowseAgentSessionRequest extends WorkbenchBrowseAgentBaseRequest {
  session?: string | null;
}

export interface WorkbenchBrowseAgentBrowserRequest extends WorkbenchBrowseAgentSessionRequest {
  local?: boolean | null;
  mode?: WorkbenchBrowseSessionMode | null;
  persistent?: boolean | null;
}

export interface WorkbenchBrowseAgentDoctorRequest extends WorkbenchBrowseAgentSessionRequest {
  action: "doctor";
  json?: boolean | null;
}

export interface WorkbenchBrowseAgentStatusRequest extends WorkbenchBrowseAgentSessionRequest {
  action: "status";
}

export interface WorkbenchBrowseAgentOpenRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "open";
  url: string;
  wait?: WorkbenchBrowseAgentWaitState | null;
}

export interface WorkbenchBrowseAgentSnapshotRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "snapshot";
  compact?: boolean | null;
  filter?: string | null;
  maxDepth?: number | null;
}

export interface WorkbenchBrowseAgentClickRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "click";
  ref?: string | null;
  selector?: string | null;
}

export interface WorkbenchBrowseAgentFillRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "fill";
  pressEnter?: boolean | null;
  ref?: string | null;
  selector?: string | null;
  value: string;
}

export interface WorkbenchBrowseAgentEvalRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "eval";
  expression: string;
}

export interface WorkbenchBrowseAgentGetRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "get";
  ref?: string | null;
  selector?: string | null;
  what: "box" | "checked" | "html" | "markdown" | "text" | "title" | "url" | "value" | "visible";
}

export interface WorkbenchBrowseAgentHighlightRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "highlight";
  durationMs?: number | null;
  ref?: string | null;
  selector?: string | null;
}

export interface WorkbenchBrowseAgentIsRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "is";
  check: "checked" | "visible";
  ref?: string | null;
  selector?: string | null;
}

export interface WorkbenchBrowseAgentTypeRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "type";
  delayMs?: number | null;
  mistakes?: boolean | null;
  text: string;
}

export interface WorkbenchBrowseAgentKeyRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "key";
  key: string;
}

export interface WorkbenchBrowseAgentMouseClickRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "mouseClick";
  button?: "left" | "middle" | "right" | null;
  clickCount?: number | null;
  returnXPath?: boolean | null;
  x: number;
  y: number;
}

export interface WorkbenchBrowseAgentMouseHoverRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "mouseHover";
  returnXPath?: boolean | null;
  x: number;
  y: number;
}

export interface WorkbenchBrowseAgentMouseDragRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "mouseDrag";
  button?: "left" | "middle" | "right" | null;
  delayMs?: number | null;
  fromX: number;
  fromY: number;
  returnXPath?: boolean | null;
  steps?: number | null;
  toX: number;
  toY: number;
}

export interface WorkbenchBrowseAgentMouseScrollRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "mouseScroll";
  deltaX: number;
  deltaY: number;
  returnXPath?: boolean | null;
  x: number;
  y: number;
}

export interface WorkbenchBrowseAgentCursorRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "cursor";
}

export interface WorkbenchBrowseAgentSelectRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "select";
  ref?: string | null;
  selector?: string | null;
  value: string;
}

export interface WorkbenchBrowseAgentSessionsRequest extends WorkbenchBrowseAgentBaseRequest {
  action: "sessions";
  includeRuntime?: boolean | null;
}

export interface WorkbenchBrowseAgentWaitRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "wait";
  argument?: string | null;
  ms?: number | null;
  state?: WorkbenchBrowseAgentWaitSelectorState | null;
  type: "load" | "selector" | "timeout";
}

export interface WorkbenchBrowseAgentNavigationRequest extends WorkbenchBrowseAgentBrowserRequest {
  wait?: WorkbenchBrowseAgentWaitState | null;
}

export interface WorkbenchBrowseAgentBackRequest extends WorkbenchBrowseAgentNavigationRequest {
  action: "back";
}

export interface WorkbenchBrowseAgentForwardRequest extends WorkbenchBrowseAgentNavigationRequest {
  action: "forward";
}

export interface WorkbenchBrowseAgentForgetRequest extends WorkbenchBrowseAgentSessionRequest {
  action: "forget";
}

export interface WorkbenchBrowseAgentReloadRequest extends WorkbenchBrowseAgentNavigationRequest {
  action: "reload";
}

export interface WorkbenchBrowseAgentScreenshotRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "screenshot";
  animations?: "allow" | "disabled" | null;
  fullPage?: boolean | null;
  type?: "jpeg" | "png" | null;
}

export interface WorkbenchBrowseAgentRefsRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "refs";
}

export interface WorkbenchBrowseAgentViewportRequest extends WorkbenchBrowseAgentBrowserRequest {
  action: "viewport";
  height: number;
  scale?: number | null;
  width: number;
}

export interface WorkbenchBrowseAgentStopRequest extends WorkbenchBrowseAgentSessionRequest {
  action: "stop";
  force?: boolean | null;
}

export interface WorkbenchBrowseAgentCleanupRequest extends WorkbenchBrowseAgentBaseRequest {
  action: "cleanup";
  force?: boolean | null;
  sessions?: string[] | null;
}

export interface WorkbenchBrowseAgentSequenceRequest {
  actions: WorkbenchBrowseAgentAction[];
  streamProgress?: boolean | null;
  summary?: string | null;
  stopOnError?: boolean | null;
}

export type WorkbenchBrowseAgentScriptRequest =
  | WorkbenchBrowseAgentScriptFileRequest
  | WorkbenchBrowseAgentScriptInlineRequest;

export interface WorkbenchBrowseAgentScriptBaseRequest {
  cwd: string;
  mode?: WorkbenchBrowseSessionMode | null;
  session?: string | null;
  streamProgress?: boolean | null;
  summary?: string | null;
  stopOnError?: boolean | null;
  threadId: string;
  timeoutMs?: number | null;
  vars?: Record<string, string> | null;
}

export interface WorkbenchBrowseAgentScriptInlineRequest extends WorkbenchBrowseAgentScriptBaseRequest {
  script: string;
  scriptPath?: never;
}

export interface WorkbenchBrowseAgentScriptFileRequest extends WorkbenchBrowseAgentScriptBaseRequest {
  script?: never;
  scriptPath: string;
}

export interface WorkbenchBrowseAgentResponse extends WorkbenchBrowseCommandResponse {
  action?: WorkbenchBrowseAgentActionName;
  args?: string[];
  cleanupResults?: WorkbenchBrowseCommandResponse[];
  session?: string;
}

export interface WorkbenchBrowseAgentSequenceResponse {
  durationMs: number;
  error?: string;
  ok: boolean;
  results: WorkbenchBrowseAgentResponse[];
  stoppedAtIndex: number | null;
}

export type WorkbenchBrowseAgentSequenceProgressEvent =
  | {
      durationMs: number;
      ok: boolean;
      results: WorkbenchBrowseAgentResponse[];
      stoppedAtIndex: number | null;
      type: "browse-sequence-complete";
    }
  | {
      startedAt: number;
      summary?: string | null;
      totalActions: number;
      type: "browse-sequence-start";
    }
  | {
      action: WorkbenchBrowseAgentActionName;
      index: number;
      result: WorkbenchBrowseAgentResponse;
      type: "browse-action-complete";
    }
  | {
      action: WorkbenchBrowseAgentActionName;
      index: number;
      session?: string | null;
      startedAt: number;
      type: "browse-action-start";
    };

export type WorkbenchBrowseResultEntryState = "completed" | "failed" | "inProgress" | "queued";

export type WorkbenchBrowseResultEntryDetailKind = "error" | "result" | "text";

export interface WorkbenchBrowseResultEntry {
  action: WorkbenchBrowseAgentActionName | string;
  actionIndex: number;
  assetUrl: string | null;
  commandItemId: string | null;
  detailKind?: WorkbenchBrowseResultEntryDetailKind | null;
  detailLabel?: string | null;
  detailText?: string | null;
  durationMs: number | null;
  entryKey: string;
  recordedAt: number;
  session: string | null;
  state: WorkbenchBrowseResultEntryState;
  threadId: string;
  turnId: string;
}

export interface WorkbenchAgentOption {
  name: string;
  description: string;
  path: string;
  source?: "project" | "library";
  sourceLabel?: string;
}

export interface WorkbenchAgentDefinition extends WorkbenchAgentOption {
  prompt: string;
}

export interface WorkbenchSkillSummary {
  name: string;
  description: string;
  path: string;
  relativePath: string;
}

export interface WorkbenchSkillDefinition extends WorkbenchSkillSummary {
  content: string;
}

export interface WorkbenchProjectIcon {
  path: string;
  rootId: string;
}

export interface WorkbenchProjectOption {
  id: string;
  icon?: WorkbenchProjectIcon;
  kind: "git" | "workspace" | "workbench-library";
  lastCommitTimeMs: number | null;
  name: string;
  rootPath: string;
  roots: WorkbenchProjectRoot[];
  relativePath: string;
  workspacePath?: string;
}

export interface WorkbenchProjectRoot {
  id: string;
  isPrimary: boolean;
  name: string;
  relativePath: string;
  rootPath: string;
}

export interface WorkbenchProjectsPayload {
  data: WorkbenchProjectOption[];
  rootPath: string;
}

export interface WorkbenchModelOption {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportsPersonality: boolean;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  supportsVision: boolean;
  supportsFastMode: boolean;
  inputModalities: string[];
  maxContextWindowTokens: number | null;
  additionalSpeedTiers: string[];
  policyState: string | null;
  billingMultiplier: number | null;
}

export interface WorkbenchComposerSettings {
  agentPath: string | null;
  agentSource: "library" | "project" | null;
  harness: WorkbenchHarness;
  model: string;
  reasoningEffort: string | null;
  serviceTier: "fast" | null;
}

export type WorkbenchComposerProfileScope =
  | { kind: "global" }
  | { kind: "project"; projectId: string };

export interface WorkbenchComposerProfile extends WorkbenchComposerSettings {
  createdAt: number;
  description?: string;
  id: string;
  name: string;
  scope: WorkbenchComposerProfileScope;
  updatedAt: number;
}

export type WorkbenchComposerProfileMutation =
  | { kind: "delete"; profileId: string }
  | { kind: "upsert"; profile: WorkbenchComposerProfile };

export interface WorkbenchComposerProfileStorePayload {
  profiles: WorkbenchComposerProfile[];
}

export interface WorkbenchSubagentRelationship {
  createdAt: number;
  cwd: string;
  directSubagentIndex: number;
  harness: WorkbenchHarness;
  name: string;
  parentThreadId: string;
  profileId: string;
  profileName: string;
  projectId: string;
  threadId: string;
  title: string;
  updatedAt: number;
}

export interface WorkbenchSubagentSummary extends WorkbenchSubagentRelationship {
  activityStatus: "active" | "inactive" | "unknown";
  lastActivityAt: number;
  lifecycle?: import("./workbench/thread/thread-state").WorkbenchThreadLifecycle;
  pinned?: boolean;
}

export interface WorkbenchSubagentPage {
  nextCursor: string | null;
  subagents: WorkbenchSubagentSummary[];
}

export type WorkbenchComposerProfileSlot =
  | { draftId: string; harness: WorkbenchHarness; kind: "draft"; projectId: string }
  | { kind: "new-thread"; projectId: string }
  | { harness: WorkbenchHarness; kind: "thread"; projectId: string; threadId: string };

export type WorkbenchComposerProfileSelection =
  | { kind: "custom"; settings?: WorkbenchComposerSettings }
  | { kind: "profile"; profileId: string; settings: WorkbenchComposerSettings };

export type WorkbenchComposerProfileTargetSelection =
  | { kind: "custom"; settings: WorkbenchComposerSettings }
  | { kind: "profile"; profileId: string; settings: WorkbenchComposerSettings };

export interface WorkbenchListModelsOptions {
  forceRefresh?: boolean;
}

export interface ChangeSummary {
  additions: number;
  deletions: number;
}

export interface ThreadSummary {
  id: string;
  harness: WorkbenchHarness;
  name: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  cwd: string;
  source: string;
  path: string | null;
  forkedFromId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
}

export interface ThreadPayload extends ThreadSummary {
  browseResultEntries?: WorkbenchBrowseResultEntry[];
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  agentPath: string | null;
  isDraft: boolean;
  nextPageCursor?: string | null;
  tokenUsage: ThreadTokenUsage | null;
  turnHistory: WorkbenchThreadTurnHistoryEntry[];
  turns: Turn[];
}

export interface WorkbenchThreadTitleRequest {
  harness: WorkbenchHarness;
  threadId: string;
  title: string;
}

export interface WorkbenchThreadDocumentSnapshot {
  documentsByKey: Record<string, ThreadPayload | undefined>;
  keysByThreadId: Record<string, string | undefined>;
  selectedThreadKey: string;
}

export type WorkbenchThreadTurnLoadState = "loaded" | "missing" | "unloaded";

export interface WorkbenchThreadTurnHistoryEntry {
  completedAt: number | null;
  durationMs: number | null;
  itemCount: number;
  itemIds?: string[];
  itemTimeline?: WorkbenchThreadItemTimelineEntry[];
  loadState: WorkbenchThreadTurnLoadState;
  startedAt: number | null;
  status: Turn["status"] | null;
  turnId: string;
}

export interface WorkbenchReadThreadOptions {
  cursor?: string | null;
  cwd?: string;
  readScope?: "subagentBackground";
}

export interface WorkbenchSendThreadMessageOptions {
  activatedSkillPaths?: string[];
  additionalWritableRoots?: string[];
  composerProfileSlot?: WorkbenchComposerProfileSlot;
  instructionInjections?: Record<string, string>;
  onThreadCreated?: (thread: ThreadPayload) => void;
  onThreadMaterialized?: (thread: ThreadPayload) => void;
  onTurnAdmitted?: (turnId: string) => void;
  selectThread?: boolean;
  startNewTurn?: boolean;
  workflowIds?: string[];
}

export interface WorkbenchThreadComposerAttachmentDraft {
  id: string;
  url: string;
}

export interface WorkbenchComposerInputDraft {
  attachments: WorkbenchThreadComposerAttachmentDraft[];
  text: string;
  updatedAt: number;
}

export interface WorkbenchQuestionnaireDraft {
  attachments: WorkbenchThreadComposerAttachmentDraft[];
  customValues: Record<string, string>;
  selectedValues: Record<string, string[]>;
  updatedAt: number;
}

export interface WorkbenchUserInputOption {
  label: string;
  description: string;
}

export interface WorkbenchUserInputQuestion {
  id: string;
  header: string;
  question: string;
  allowOther: boolean;
  isSecret: boolean;
  options: WorkbenchUserInputOption[];
}

export interface WorkbenchApprovalCommandContext {
  command: string;
  commandActions: CommandAction[];
  cwd: string;
}

export interface WorkbenchUserInputApprovalContext {
  command?: WorkbenchApprovalCommandContext;
}

export interface WorkbenchUserInputRequest {
  id: string;
  title: string;
  summary: string;
  submitLabel: string;
  approval?: WorkbenchUserInputApprovalContext;
  questions: WorkbenchUserInputQuestion[];
}

export interface WorkbenchUserInputAnswer {
  answers: string[];
}

export interface WorkbenchUserInputResponse {
  answers: Record<string, WorkbenchUserInputAnswer | undefined>;
}

export interface WorkbenchSubmitUserInputRequestOptions {
  activatedSkillPaths?: string[];
  turnId?: string | null;
  insertAfterItemId?: string | null;
  insertAfterItemIndex?: number | null;
  supplementalInput?: UserInput[];
}

export interface WorkbenchPendingUserInputRequest {
  harness: WorkbenchHarness;
  threadId: string;
  requestKey: string;
  turnId: string | null;
  itemId: string | null;
  request: WorkbenchUserInputRequest;
  responseMode?: "native" | "newTurn";
}

export interface WorkbenchQuestionnaireHistoryEntry {
  requestKey: string;
  threadId: string;
  turnId: string;
  itemId: string | null;
  insertAfterItemId: string | null;
  insertAfterItemIndex: number | null;
  request: WorkbenchUserInputRequest;
  response: WorkbenchUserInputResponse;
  resolvedAt: number;
}

export type WorkbenchSteerHistoryStatus = "pending" | "sent" | "interrupted" | "failed";

export interface WorkbenchSteerHistoryEntry {
  entryKey: string;
  threadId: string;
  turnId: string;
  input: UserInput[];
  status: WorkbenchSteerHistoryStatus;
  attemptedAt: number;
  resolvedAt: number | null;
  requestId: string | null;
  canonicalItemId: string | null;
  clientUserMessageId?: string | null;
  dispatchSequence?: number | null;
  error: string | null;
}

export interface WorkbenchThreadContextReadResponse {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  entryScope?: WorkbenchThreadContextEntryScope;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: Thread;
}

export interface WorkbenchThreadContextEntryScope {
  mode: "turns";
  turnIds: string[];
}

export interface WorkbenchThreadContextBundle {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: ThreadPayload;
}

export const WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS = 20_000;

export type WorkbenchThreadRecallKind =
  | "agent-message"
  | "commentary"
  | "final-answer"
  | "plan"
  | "questionnaire"
  | "user-message"
  | "user-steer";

export interface WorkbenchThreadRecallSearchRequest {
  action: "search";
  query: string;
  kinds?: WorkbenchThreadRecallKind[];
  limit?: number;
  before?: string;
}

export interface WorkbenchThreadRecallExpandRequest {
  action: "expand";
  ref: string;
  cursor?: string;
}

export type WorkbenchThreadRecallRequest = WorkbenchThreadRecallExpandRequest | WorkbenchThreadRecallSearchRequest;

export interface FileNode {
  isIgnored?: boolean;
  type: "file";
  name: string;
  path: string;
}

export interface DirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: TreeNode[];
}

export type TreeNode = DirectoryNode | FileNode;

export interface ProjectSnapshot {
  projectId: string;
  root: string;
  rootPath: string;
  roots: WorkbenchProjectRoot[];
  tree: TreeNode[];
  changes: Record<string, ChangeSummary>;
  workbenchStorageRootPath: string;
}

export interface ExplorerSnapshot {
  currentProjectId: string;
  projects: WorkbenchProjectOption[];
  root: string;
  rootPath: string;
  roots: WorkbenchProjectRoot[];
  tree: TreeNode[];
  projectFileCandidates: readonly ProjectTreeFileCandidate[];
  projectFileIndexId: string;
  projectFileIndexKey: string;
  projectFilePaths: readonly string[];
  subagents: WorkbenchSubagentSummary[];
  threads: ThreadSummary[];
  isProjectLoading: boolean;
  isThreadsLoading: boolean;
  changes: Record<string, ChangeSummary>;
  currentPath: string;
  currentThreadId: string;
  expandedDirectories: string[];
  locallyModifiedPaths: string[];
  threadsError: string;
  fontSize: number;
  workbenchStorageRootPath: string;
}

export interface WorkbenchThreadSidebarStore {
  getHomeThreadDisplayOrder?: () => WorkbenchHomeThreadDisplayOrderSnapshot;
  getHomeThreadDisplayOrderSupported?: () => boolean;
  getPinnedThreadLayout?: () => WorkbenchPinnedThreadLayoutSnapshot;
  getProjectThreadSidebars?: () => WorkbenchProjectThreadSidebars;
  getProjectThreadSummaries?: () => WorkbenchProjectThreadSummaries;
  getSnapshot: () => WorkbenchThreadSidebarSnapshot | null;
  subscribe: (listener: () => void) => () => void;
}

export interface WorkbenchThreadRuntimeSnapshot {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  isLoading: boolean;
  pendingUserInputRequestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>;
  rateLimits: RateLimitSnapshot | null;
  subagents: WorkbenchSubagentSummary[];
  threadDocuments: WorkbenchThreadDocumentSnapshot;
  threads: ThreadSummary[];
  threadsError: string;
}

export interface WorkbenchThreadRuntimeStore {
  getSnapshot: () => WorkbenchThreadRuntimeSnapshot;
  subscribe: (listener: () => void) => () => void;
}

export interface WorkbenchRouteLoadResult {
  error?: string;
  ok: boolean;
}


export interface WorkbenchControls {
  daemon: WorkbenchDaemonClient;
  applyRoute: (route: WorkbenchRoute) => Promise<WorkbenchRouteLoadResult>;
  createThreadDraft: (harness: WorkbenchHarness, options?: { select?: boolean; threadId?: string }) => ThreadPayload;
  getSelectedThreadDraft: () => WorkbenchThreadDraft | null;
  readThread: (threadId: string, harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => Promise<ThreadPayload | null>;
  orchestratorRuntime: WorkbenchOrchestratorRuntimeStore;
  refreshRateLimits: () => Promise<void>;
  listModels: (harness: WorkbenchHarness, options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  moveThreadDraft: (sourceProjectId: string, destinationProjectId: string, draftId: string) => Promise<void>;
  sendThreadMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  compactThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  stopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  setThreadTitle: (request: WorkbenchThreadTitleRequest) => Promise<string>;
  threadGoals: WorkbenchThreadGoalControls;
  submitPendingUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  setEditorFontSize: (fontSize: number) => void;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  setCurrentThreadServiceTier: (threadId: string, serviceTier: string | null) => void;
  setCurrentThreadComposerSettings: (threadId: string, settings: WorkbenchComposerSettings) => void;
  toggleDirectory: (path: string) => void;
  updateThreadState: (request: WorkbenchThreadStateRequest) => Promise<void>;
  updateThreadStateWithAcceptance: (request: WorkbenchThreadStateRequest) => Promise<boolean>;
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  deleteFile: (filePath: string, options?: { confirmUntracked?: boolean }) => Promise<DeleteFileResponse>;
  deleteThreadDraft: (draftId: string) => Promise<void>;
  editThreadDraft: (draft: WorkbenchThreadDraft, options?: { folderId?: string }) => void;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
}

export interface WorkbenchThreadGoalSnapshot {
  error: string | null;
  goal: ThreadGoal | null;
  isLoaded: boolean;
  isLoading: boolean;
  pendingAction: "clear" | "update" | null;
}

export interface WorkbenchThreadGoalControls {
  clear: (threadId: string) => Promise<void>;
  getSnapshot: (threadId: string) => WorkbenchThreadGoalSnapshot;
  load: (threadId: string) => Promise<void>;
  refresh: (threadId: string) => Promise<void>;
  subscribe: (threadId: string, listener: () => void) => () => void;
  updateObjective: (threadId: string, objective: string) => Promise<void>;
}

export interface WorkbenchBindings {
  initialRoute?: WorkbenchRoute;
  onExplorerStateChange?: (snapshot: ExplorerSnapshot) => void;
  onTranscriptComparisonChange?: (available: boolean, projection: WorkbenchTranscriptProjection | null) => void;
}

export interface FilePayload {
  projectId: string;
  path: string;
  content: string;
  headContent: string | null;
  updatedAt: string;
  mtimeMs: number;
}

export interface CreateEntryPayload {
  path: string;
  type: "directory" | "file";
}

export interface DeleteFileRequest {
  confirmUntracked?: boolean;
  path: string;
  projectId: string;
}

export interface DeleteFileConfirmationRequired {
  confirmationRequired: true;
  path: string;
  projectId: string;
  tracked: false;
}

export interface DeleteFilePayload {
  confirmationRequired?: false;
  path: string;
  tracked: boolean;
}

export type DeleteFileResponse = DeleteFileConfirmationRequired | DeleteFilePayload;

export interface SaveFilePayload {
  projectId: string;
  path: string;
  updatedAt: string;
  mtimeMs: number;
  changes: Record<string, ChangeSummary>;
}

export interface SaveConflictPayload {
  error: string;
  path: string;
  expectedUpdatedAt: string;
  expectedMtimeMs: number;
  actualUpdatedAt: string;
  actualMtimeMs: number;
}

export interface WorkbenchFileOpenTarget {
  absolutePath?: string | null;
  columnNumber?: number | null;
  lineNumber?: number | null;
  path: string;
  projectId?: string | null;
}

export interface OpenFileInEditorRequest extends WorkbenchFileOpenTarget {}

export interface OpenFileInEditorResponse {
  ok: true;
  path: string;
  projectId: string | null;
  target: string;
}

export interface RevealProjectEntryRequest {
  path: string;
  projectId: string;
}

export interface RevealProjectEntryResponse {
  ok: true;
  path: string;
  projectId: string;
}

export interface ResolveExternalFileLinkRootsRequest {
  paths: string[];
}

export interface ExternalFileLinkRoot {
  id: string;
  openPathMode: "absolute";
  rootPath: string;
}

export interface ResolveExternalFileLinkRootsResponse {
  roots: ExternalFileLinkRoot[];
}
