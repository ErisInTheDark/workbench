import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";
import type { Turn } from "./codex/generated/app-server/v2/Turn";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";

export type WorkbenchHarness = "codex" | "copilot";

export interface WorkbenchAgentOption {
  name: string;
  description: string;
  path: string;
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
}

export interface ThreadPayload {
  id: string;
  harness: WorkbenchHarness;
  model: string | null;
  reasoningEffort: string | null;
  agentPath: string | null;
  isDraft: boolean;
  name: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  cwd: string;
  source: string;
  path: string | null;
  turns: Turn[];
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

export interface WorkbenchUserInputRequest {
  id: string;
  title: string;
  summary: string;
  submitLabel: string;
  questions: WorkbenchUserInputQuestion[];
}

export interface WorkbenchUserInputAnswer {
  answers: string[];
}

export interface WorkbenchUserInputResponse {
  answers: Record<string, WorkbenchUserInputAnswer | undefined>;
}

export interface FileNode {
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
  root: string;
  rootPath: string;
  tree: TreeNode[];
  changes: Record<string, ChangeSummary>;
}

export interface ExplorerSnapshot {
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

export interface WorkbenchControls {
  clearSelection: () => void;
  openFile: (path: string) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  listModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  sendThreadMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  toggleDirectory: (path: string) => void;
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  createThread: (harness: WorkbenchHarness) => void;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
}

export interface WorkbenchBindings {
  onExplorerStateChange?: (snapshot: ExplorerSnapshot) => void;
  onCurrentThreadChange?: (thread: ThreadPayload | null) => void;
  onRateLimitsChange?: (rateLimits: RateLimitSnapshot | null) => void;
  onControlsReady?: (controls: WorkbenchControls) => void;
}

export interface FilePayload {
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
