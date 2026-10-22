/*
 * Exports:
 * - GitChangesetFile: one changed file a diff view shows; working-tree files add line selection and claim owners.
 * - GitChangesetSnapshot: the focused file's content state every diff view reads.
 * - GitChangeset: a reviewable set of file changes (the working tree, a commit or a stash) shared by the diff views.
 */
import type { GitObjectFile } from "workbench-shared/workbench/git/git-object-contracts";
import type { WorkingTreeDiff, WorkingTreePreview, WorkingTreeSelection } from "workbench-shared/workbench/git/working-tree-contracts";

export type GitChangesetFile = GitObjectFile & {
  /** Lines can be picked one by one. */
  partial?: boolean;
  /** Threads claiming the file; claimed files are inspect-only. */
  ownerIds?: readonly string[];
};

export interface GitChangesetSnapshot {
  /** What the content belongs to (repository root or object), so per-file views remount when it changes. */
  rootId: string;
  path: string;
  diff: WorkingTreeDiff | null;
  preview: WorkingTreePreview | null;
  contentStatus: "idle" | "loading" | "ready" | "error";
  contentError: string;
  /** Line picks for the next operation; always empty for read-only changesets. */
  selections: readonly WorkingTreeSelection[];
  busy: boolean;
}

export interface GitChangeset {
  readonly file: GitChangesetFile | null;
  getSnapshot(): GitChangesetSnapshot;
  subscribe(listener: () => void): () => void;
  loadContent(): Promise<void>;
  loadPreview(): Promise<void>;
  /** Present only where the focused file's lines can be picked. */
  setLines?(ids: readonly string[], included: boolean): void;
}
