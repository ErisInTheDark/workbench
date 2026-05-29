import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";
import type { CommandAction } from "./codex/generated/app-server/v2/CommandAction";
import type { Turn } from "./codex/generated/app-server/v2/Turn";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import type { WorkbenchRoute } from "./workbench/navigation/workbench-route";

export type WorkbenchHarness = "codex" | "copilot";
export type OrchestratorReloadScope = "codex-bridge" | "next-dev" | "orchestrator-logic";
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

export interface WorkbenchAgentOption {
  name: string;
  description: string;
  path: string;
  source?: "project" | "library";
  sourceLabel?: string;
}

export interface WorkbenchSkillSummary {
  name: string;
  description: string;
  path: string;
  relativePath: string;
}

export interface WorkbenchProjectOption {
  id: string;
  kind: "git" | "workbench-library";
  lastCommitTimeMs: number | null;
  name: string;
  rootPath: string;
  relativePath: string;
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
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  agentPath: string | null;
  isDraft: boolean;
  turns: Turn[];
}

export interface WorkbenchSendThreadMessageOptions {
  onThreadMaterialized?: (thread: ThreadPayload) => void;
  selectThread?: boolean;
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
  customValues: Record<string, string>;
  selectedValues: Record<string, string>;
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

export interface WorkbenchSubmitUserInputRequestOptions {
  turnId?: string | null;
  insertAfterItemId?: string | null;
  insertAfterItemIndex?: number | null;
}

export interface WorkbenchPendingUserInputRequest {
  harness: WorkbenchHarness;
  threadId: string;
  requestKey: string;
  turnId: string | null;
  itemId: string | null;
  request: WorkbenchUserInputRequest;
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
  tree: TreeNode[];
  changes: Record<string, ChangeSummary>;
}

export interface ExplorerSnapshot {
  currentProjectId: string;
  projects: WorkbenchProjectOption[];
  root: string;
  rootPath: string;
  tree: TreeNode[];
  threads: ThreadSummary[];
  changes: Record<string, ChangeSummary>;
  currentPath: string;
  currentThreadId: string;
  expandedDirectories: string[];
  locallyModifiedPaths: string[];
  threadsError: string;
  fontSize: number;
}

export interface WorkbenchRouteLoadResult {
  error?: string;
  ok: boolean;
}

export interface WorkbenchControls {
  applyRoute: (route: WorkbenchRoute) => Promise<WorkbenchRouteLoadResult>;
  createThreadDraft: (harness: WorkbenchHarness) => ThreadPayload;
  readThread: (threadId: string, harness?: WorkbenchHarness) => Promise<ThreadPayload | null>;
  markThreadSeen: (thread: ThreadPayload) => void;
  listModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  sendThreadMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  stopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  submitPendingUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  setCurrentThreadServiceTier: (threadId: string, serviceTier: string | null) => void;
  toggleDirectory: (path: string) => void;
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
}

export interface WorkbenchBindings {
  onExplorerStateChange?: (snapshot: ExplorerSnapshot) => void;
  onCurrentThreadChange?: (thread: ThreadPayload | null) => void;
  onPendingUserInputRequestsChange?: (requestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>) => void;
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
