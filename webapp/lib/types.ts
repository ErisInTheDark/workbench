export interface ChangeSummary {
  additions: number;
  deletions: number;
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
  tree: TreeNode[];
  changes: Record<string, ChangeSummary>;
}

export interface ExplorerSnapshot {
  root: string;
  tree: TreeNode[];
  changes: Record<string, ChangeSummary>;
  currentPath: string;
  expandedDirectories: string[];
  locallyModifiedPaths: string[];
}

export interface WorkbenchControls {
  openFile: (path: string) => Promise<void>;
  toggleDirectory: (path: string) => void;
}

export interface WorkbenchBindings {
  onExplorerStateChange?: (snapshot: ExplorerSnapshot) => void;
  onControlsReady?: (controls: WorkbenchControls) => void;
}

export interface FilePayload {
  path: string;
  content: string;
  headContent: string | null;
  updatedAt: string;
  mtimeMs: number;
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
