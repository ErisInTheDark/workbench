/*
 * Exports:
 * - default ThreadGitArcCollapsedSummary: compose established result rows beneath a closed Git arc card.
 * - ThreadGitArcCollapsedSummaryContent: typed commit, file, claim, or count preview content.
 * - createThreadGitArcCompareSummaryRows/createThreadGitArcDiffSummaryRows/createThreadGitArcEditSummaryRows: normalise parsed operation changes for file-row presentation.
 */
import type { GitArcEditFile } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { FileUpdateChange } from "workbench-shared/workbench/thread/workbench-thread-items";

import { parseUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { ThreadCommitRow, type ThreadCommitSummary } from "./ThreadCheckpointCommitCard";
import ThreadClaimedFileList, { ThreadClaimMarkerIcon, type ThreadClaimMarker } from "./ThreadClaimedFileList";
import { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import {
  ThreadFileChangePreviewList,
  type ThreadFileChangeListChange,
} from "./ThreadFileChangeItem";
import ThreadSummaryText from "./ThreadSummaryText";

export type ThreadGitArcCollapsedSummaryContent =
  /** Every commit is listed: a stack card's commits are its whole message, never a preview. Null summaries load. */
  | { commits: Array<{ key: string; summary: ThreadCommitSummary | null }>; kind: "commits" }
  | { changes: ThreadFileChangeListChange[]; kind: "files" }
  | { kind: "claims"; label: string; marker: ThreadClaimMarker; paths: string[]; totalCount: number }
  | { kind: "counts"; rows: Array<{ label: string; marker: ThreadClaimMarker }> };

/** Edit session rows; moved files render at their new path with their source as the move origin. */
export function createThreadGitArcEditSummaryRows (files: readonly GitArcEditFile[]): ThreadFileChangeListChange[] {
  return files.map((file, sourceChangeIndex) => ({
    change: {
      diff: "",
      kind: { move_path: file.movedFrom ?? null, type: "update" },
      path: file.path,
    },
    sourceChangeIndex,
    sourceItemId: "git-arc-edit-preview",
    summaryTotals: { additions: file.additions, deletions: file.deletions },
  }));
}

export function createThreadGitArcCompareSummaryRows (changes: readonly {
  additions: number;
  deletions: number;
  path: string;
  status: "A" | "D" | "M" | "U";
}[]): ThreadFileChangeListChange[] {
  return changes.map((change, sourceChangeIndex) => ({
    change: {
      diff: "",
      kind: change.status === "A"
        ? { type: "add" }
        : change.status === "D"
          ? { type: "delete" }
          : { move_path: null, type: "update" },
      path: change.path,
    },
    sourceChangeIndex,
    sourceItemId: "git-arc-compare-preview",
    summaryTotals: {
      additions: change.additions,
      deletions: change.deletions,
    },
  }));
}

export function createThreadGitArcDiffSummaryRows (changes: readonly FileUpdateChange[]): ThreadFileChangeListChange[] {
  return changes.map((change, sourceChangeIndex) => {
    const totals = parseUnifiedDiff(change.diff);
    return {
      change,
      sourceChangeIndex,
      sourceItemId: "git-arc-diff-preview",
      summaryTotals: {
        additions: totals.additions,
        deletions: totals.deletions,
      },
    };
  });
}

export default function ThreadGitArcCollapsedSummary ({
  content,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  content: ThreadGitArcCollapsedSummaryContent;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const visibleCount = content.kind === "commits"
    ? content.commits.length
    : content.kind === "files"
      ? Math.min(content.changes.length, 2)
      : content.kind === "claims"
        ? Math.min(content.paths.length, 2)
        : Math.min(content.rows.length, 2);
  const totalCount = content.kind === "commits"
    ? content.commits.length
    : content.kind === "files"
      ? content.changes.length
      : content.kind === "claims" ? content.totalCount : content.rows.length;
  const remainingCount = totalCount - visibleCount;

  return (
    <div
      className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]"
      data-thread-git-arc-collapsed-summary="true"
    >
      {content.kind === "commits" ? (
        <div className="py-1.5">
          {content.commits.map(({ key, summary }) => <ThreadCommitRow key={key} summary={summary} />)}
        </div>
      ) : content.kind === "files" ? (
        <ThreadFileChangePreviewList
          changes={content.changes.slice(0, 2)}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ) : content.kind === "claims" ? (
        <ThreadClaimedFileList
          inset={false}
          label={content.label}
          marker={content.marker}
          paths={content.paths.slice(0, 2)}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ) : (
        <div className="space-y-1 py-2">
          {content.rows.slice(0, 2).map((row) => (
            <ThreadDisclosureStaticRow
              className="!py-0.5"
              key={`${row.marker}:${row.label}`}
              marker={<ThreadClaimMarkerIcon marker={row.marker} />}
              summary={<ThreadSummaryText text={row.label} />}
              summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
            />
          ))}
        </div>
      )}
      {remainingCount > 0 ? (
        <div className="pb-2 text-[0.78em] leading-[1.6] text-fg/muted">...and {remainingCount} more</div>
      ) : null}
    </div>
  );
}
