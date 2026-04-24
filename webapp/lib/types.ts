import type { Turn } from "./codex/generated/app-server/v2/Turn";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";

export interface ChangeSummary {
  additions: number;
  deletions: number;
}

export interface ThreadSummary {
  id: string;
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
  openFile: (path: string) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  sendThreadMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  toggleDirectory: (path: string) => void;
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
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
