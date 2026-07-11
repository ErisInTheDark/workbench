import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";
import type { CommandAction } from "./codex/generated/app-server/v2/CommandAction";
import type { Thread } from "./codex/generated/app-server/v2/Thread";
import type { ThreadTokenUsage } from "./codex/generated/app-server/v2/ThreadTokenUsage";
import type { Turn } from "./codex/generated/app-server/v2/Turn";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import type { WorkbenchRoute } from "./workbench/navigation/workbench-route";
import type { ProjectTreeFileCandidate } from "./workbench/project/ProjectTreeFileIndex";
import type { WorkbenchThreadItemTimelineEntry } from "./workbench/thread/thread-item-timeline";

export type WorkbenchHarness = "codex" | "copilot" | "opencode";
export type OrchestratorReloadScope = "codex-bridge" | "next-dev" | "opencode-bridge" | "opencode-server" | "orchestrator-logic";
export type OrchestratorReloadState = "idle" | "running" | "succeeded" | "failed";

export interface OrchestratorReloadRequest {
  scopes: OrchestratorReloadScope[];
}

export interface OrchestratorReloadResponse {
  ok: true;
  state: OrchestratorReloadState;
  requestedScopes: OrchestratorReloadScope[];
  appliedScopes: OrchestratorReloadScope[];
  queuedScopes: OrchestratorReloadScope[];
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
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

export interface WorkbenchProjectOption {
  id: string;
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
  unreadBadge: ThreadUnreadBadge | null;
}

export interface ThreadUnreadBadge {
  unreadCount: number;
  hasActiveTurn: boolean;
}

export interface ThreadPayload extends ThreadSummary {
  browseResultEntries?: WorkbenchBrowseResultEntry[];
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  agentPath: string | null;
  isDraft: boolean;
  tokenUsage: ThreadTokenUsage | null;
  turnHistory: WorkbenchThreadTurnHistoryEntry[];
  turns: Turn[];
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

export type WorkbenchThreadHydrationRequest =
  | { mode: "latest" }
  | { beforeTurnId: string; mode: "previous" }
  | { mode: "legacyFull" };

export interface WorkbenchReadThreadOptions {
  hydration?: WorkbenchThreadHydrationRequest;
}

export interface WorkbenchSendThreadMessageOptions {
  additionalWritableRoots?: string[];
  instructionInjections?: Record<string, string>;
  onThreadMaterialized?: (thread: ThreadPayload) => void;
  selectThread?: boolean;
  workflowIds?: string[];
}

export interface WorkbenchThreadComposerAttachmentDraft {
  id: string;
  url: string;
}

export interface WorkbenchThreadComposerDraft {
  attachments: WorkbenchThreadComposerAttachmentDraft[];
  text: string;
  updatedAt: number;
}

export interface WorkbenchThreadSavedComposerDraft extends WorkbenchThreadComposerDraft {
  createdAt: number;
  id: string;
}

export interface WorkbenchQuestionnaireDraft {
  attachments: WorkbenchThreadComposerAttachmentDraft[];
  customValues: Record<string, string>;
  selectedValues: Record<string, string[]>;
  updatedAt: number;
}

export interface WorkbenchStoredThreadUnreadState {
  lastObservedStatus: string;
  lastObservedUpdatedAt: number;
  lastSeenItemId: string | null;
  observedItemIds: string[];
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

export type WorkbenchUserInputControlKind = "pause";

export interface WorkbenchSubmitUserInputRequestOptions {
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
  hidden?: boolean;
  controlKind?: WorkbenchUserInputControlKind | null;
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
  hidden?: boolean;
  controlKind?: WorkbenchUserInputControlKind | null;
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
  error: string | null;
}

export interface WorkbenchThreadContextReadResponse {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: Thread;
}

export interface WorkbenchThreadContextBundle {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: ThreadPayload;
}

export const WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS = 20_000;

export type WorkbenchThreadRecallKind = "agent" | "plan" | "questionnaire" | "steer" | "user";

export interface WorkbenchThreadRecallSearchRequest {
  action: "search";
  query: string;
  kinds?: WorkbenchThreadRecallKind[];
  limit?: number;
}

export interface WorkbenchThreadRecallExpandRequest {
  action: "expand";
  ref: string;
  before?: number;
  after?: number;
  maxChars?: number;
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

export interface WorkbenchRouteLoadResult {
  error?: string;
  ok: boolean;
}

export interface WorkbenchCollaborationSuggestion {
  id: string;
  materializedThreadId?: string;
  prompt: string;
  rationale?: string;
  scratchpadImageIds?: string[];
  title: string;
  updatedAt: number;
}

export interface WorkbenchCollaborationThreadRegistry {
  autoWakeEnabled: boolean;
  currentThreadId: string;
  dismissedSuggestionIds: string[];
  lastAppliedSuggestionPatchSignature: string;
  lastAutoWakeAt: number;
  lastRunSummary: string;
  suggestions: Record<string, WorkbenchCollaborationSuggestion>;
  threadIds: string[];
}

export type WorkbenchCollaborationPostAuthor = "agent" | "user";

export type WorkbenchCollaborationPostRevisionSource = "agent" | "restore" | "user";

export interface WorkbenchCollaborationPostRevision {
  attachments?: WorkbenchThreadComposerAttachmentDraft[];
  body: string;
  createdAt: number;
  id: string;
  prompt?: string;
  source: WorkbenchCollaborationPostRevisionSource;
}

export interface WorkbenchCollaborationPost {
  attachments?: WorkbenchThreadComposerAttachmentDraft[];
  author: WorkbenchCollaborationPostAuthor;
  body: string;
  childIds: string[];
  createdAt: number;
  id: string;
  isCollapsed?: boolean;
  parentId: string | null;
  prompt?: string;
  promptThreadId?: string;
  revisions: WorkbenchCollaborationPostRevision[];
  tags: string[];
  updatedAt: number;
}

export interface WorkbenchCollaborationState {
  autoWakeEnabled: boolean;
  lastAppliedPostPatchSignature: string;
  lastAppliedRunMemorySignature: string;
  lastAutoWakeAt: number;
  lastRunMemory: string;
  posts: Record<string, WorkbenchCollaborationPost>;
  rootPostIds: string[];
  runThreadIds: string[];
  tags: string[];
  updatedAt: number;
  version: 2;
}

export type WorkbenchCollaborationSurfacePost = Omit<WorkbenchCollaborationPost, "revisions">;

export type WorkbenchCollaborationSurfaceState = Omit<WorkbenchCollaborationState, "posts"> & {
  posts: Record<string, WorkbenchCollaborationSurfacePost>;
};

export type WorkbenchCollaborationPostMutationAction = "create" | "delete" | "update";

export interface WorkbenchCollaborationPostCreateRequest {
  action: "create";
  body: string;
  parentId: string;
  postId?: string;
  prompt?: string;
}

export interface WorkbenchCollaborationPostUpdateRequest {
  action: "update";
  body: string;
  postId: string;
  prompt?: string | null;
}

export interface WorkbenchCollaborationPostDeleteRequest {
  action: "delete";
  postId: string;
}

export type WorkbenchCollaborationPostMutationRequest =
  | WorkbenchCollaborationPostCreateRequest
  | WorkbenchCollaborationPostDeleteRequest
  | WorkbenchCollaborationPostUpdateRequest;

export type WorkbenchCollaborationPostEndpointMutationRequest = WorkbenchCollaborationPostMutationRequest & {
  cwd: string;
  projectId?: string | null;
};

export interface WorkbenchCollaborationPostEndpointUsage {
  endpoint: string;
  rules: string[];
}

export interface WorkbenchCollaborationPostEndpointStateResponse {
  projectId: string;
  state: WorkbenchCollaborationSurfaceState;
  usage: WorkbenchCollaborationPostEndpointUsage;
}

export interface WorkbenchCollaborationPostMutationResponse extends WorkbenchCollaborationPostEndpointStateResponse {
  action: WorkbenchCollaborationPostMutationAction;
  message: string;
  ok: true;
  post?: WorkbenchCollaborationSurfacePost;
  postId?: string;
}

export interface WorkbenchCollaborationMemoryEndpointUsage {
  endpoint: string;
  rules: string[];
}

export interface WorkbenchCollaborationMemorySetRequest {
  cwd: string;
  memory?: string | null;
  projectId?: string | null;
}

export interface WorkbenchCollaborationMemoryStateResponse {
  memory: string;
  projectId: string;
  state: WorkbenchCollaborationSurfaceState;
  usage: WorkbenchCollaborationMemoryEndpointUsage;
}

export interface WorkbenchCollaborationMemoryMutationResponse extends WorkbenchCollaborationMemoryStateResponse {
  message: string;
  ok: true;
  preserved: boolean;
}

export type WorkbenchCollaborationAdminPostMoveIntent =
  | { type: "after"; targetPostId: string }
  | { type: "before"; targetPostId: string }
  | { type: "inside"; targetPostId: string };

export type WorkbenchCollaborationAdminPostMutation =
  | {
    action: "createPost";
    attachments?: WorkbenchThreadComposerAttachmentDraft[];
    body: string;
    parentId: string | null;
    postId: string;
    prompt?: string;
  }
  | {
    action: "createTag";
    tag: string;
  }
  | {
    action: "deletePost";
    postId: string;
  }
  | {
    action: "materializePromptThread";
    postId: string;
    prompt: string;
    promptThreadId: string;
  }
  | {
    action: "movePost";
    intent: WorkbenchCollaborationAdminPostMoveIntent;
    postId: string;
  }
  | {
    action: "removePostTag";
    postId: string;
    tag: string;
  }
  | {
    action: "restorePostRevision";
    postId: string;
    revisionId: string;
  }
  | {
    action: "setPostCollapsed";
    isCollapsed: boolean;
    postId: string;
  }
  | {
    action: "tagPost";
    postId: string;
    tag: string;
  }
  | {
    action: "updatePostPrompt";
    basePostUpdatedAt?: number;
    basePrompt?: string;
    postId: string;
    prompt: string;
  }
  | {
    action: "updatePost";
    attachments?: WorkbenchThreadComposerAttachmentDraft[];
    body: string;
    postId: string;
    prompt?: string;
  };

export interface WorkbenchCollaborationAdminPostMutationRequest {
  mutation: WorkbenchCollaborationAdminPostMutation;
  projectId: string;
}

export interface WorkbenchCollaborationAdminPostMutationResponse {
  mutation: WorkbenchCollaborationAdminPostMutation;
  ok: true;
  projectId: string;
  state: WorkbenchCollaborationState;
}

export interface WorkbenchControls {
  applyRoute: (route: WorkbenchRoute) => Promise<WorkbenchRouteLoadResult>;
  createThreadDraft: (harness: WorkbenchHarness, options?: { select?: boolean; threadId?: string }) => ThreadPayload;
  readThread: (threadId: string, harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => Promise<ThreadPayload | null>;
  refreshRateLimits: () => Promise<void>;
  markThreadSeen: (thread: ThreadPayload) => void;
  listModels: (harness: WorkbenchHarness, options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  sendThreadMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  compactThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  pauseThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  resumeThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  stopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
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
  toggleDirectory: (path: string) => void;
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
}

export interface WorkbenchBindings {
  initialRoute?: WorkbenchRoute;
  onExplorerStateChange?: (snapshot: ExplorerSnapshot) => void;
  onCurrentThreadChange?: (thread: ThreadPayload | null) => void;
  onThreadDocumentsChange?: (snapshot: WorkbenchThreadDocumentSnapshot) => void;
  onPendingUserInputRequestsChange?: (requestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>) => void;
  onCollaborationStateUpdated?: (projectId: string, state: WorkbenchCollaborationState) => void;
  onRateLimitsChange?: (rateLimits: RateLimitSnapshot | null) => void;
  onControlsReady?: (controls: WorkbenchControls) => void;
}

export interface FilePayload {
  projectId: string;
  path: string;
  content: string;
  headContent: string | null;
  updatedAt: string;
  mtimeMs: number;
}

export interface CreateEntryPayload extends ProjectSnapshot {
  path: string;
  type: "directory" | "file";
}

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
