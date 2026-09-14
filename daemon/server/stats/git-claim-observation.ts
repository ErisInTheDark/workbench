/*
 * Exports:
 * - WorkbenchGitClaimSnapshot: atomic live claim paths grouped by workspace root.
 * - WorkbenchGitClaimRename: read-time alias within one project and workspace root.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

export interface WorkbenchGitClaimRename {
  projectId: string;
  rootId: string;
  from: string;
  to: string;
}

export interface WorkbenchGitClaimSnapshot {
  harness: WorkbenchHarness;
  observedAt: number;
  projectId: string;
  roots: Array<{ paths: string[]; rootId: string }>;
  threadId: string;
}
