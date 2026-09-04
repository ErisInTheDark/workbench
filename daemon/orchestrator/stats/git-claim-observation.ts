/*
 * Exports:
 * - WorkbenchGitClaimSnapshot: one atomic post-mutation snapshot of exact live claim paths grouped by workspace root. Keywords: git, claims, stats, snapshot.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

export interface WorkbenchGitClaimSnapshot {
  harness: WorkbenchHarness;
  observedAt: number;
  projectId: string;
  roots: Array<{ paths: string[]; rootId: string }>;
  threadId: string;
}
