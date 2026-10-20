/*
 * Exports:
 * - default ThreadGitArcCollapsedSummary: compose established result rows beneath a closed Git arc card.
 * - ThreadGitArcCollapsedSummaryContent: typed file, claim, count or status-count preview content.
 * - createThreadGitArcStatusCounts: a status read compressed to one count per non-empty group.
 * - createThreadGitArcCompareSummaryRows/createThreadGitArcDiffSummaryRows/createThreadGitArcEditSummaryRows: normalise parsed operation changes for file-row presentation.
 */
import type { ReactNode } from "react";
import type { GitArcEditFile } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcStatusPresentation } from "workbench-shared/workbench/git/git-arc-status";
import { ArchiveIcon, CheckCheckIcon, GitArcProposalIcon, GitArcStackIcon } from "../workbench-icons";
import type { FileUpdateChange } from "workbench-shared/workbench/thread/workbench-thread-items";

import { parseUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import ThreadClaimedFileList, { ThreadClaimMarkerIcon, type ThreadClaimMarker } from "./ThreadClaimedFileList";
import { DisclosureStaticRow } from "../../ui/Disclosure";
import {
  ThreadFileChangePreviewList,
  type ThreadFileChangeListChange,
} from "./ThreadFileChangeItem";
import ThreadSummaryText from "./ThreadSummaryText";

export type ThreadGitArcCollapsedSummaryContent =
  | { changes: ThreadFileChangeListChange[]; kind: "files" }
  | { kind: "claims"; label: string; marker: ThreadClaimMarker; paths: string[]; totalCount: number }
  | { kind: "counts"; rows: Array<{ label: string; marker: ThreadClaimMarker }> }
  /** Everything a status read knows, compressed to one line of counts whatever the agent asked to expand. */
  | { kind: "status"; counts: Array<{ count: number; icon: ReactNode; label: string }> };

const count = (value: number | readonly unknown[] | undefined) => typeof value === "number" ? value : value?.length ?? 0;

/** One count per non-empty status group, in the order the status details list them. */
export function createThreadGitArcStatusCounts(facts: Partial<GitArcStatusPresentation>) {
  const stashedPaths = count(facts.stashedClaims);
  const lost = (facts.recovery ?? []).filter(entry => entry.kind !== "restored").reduce((total, entry) => total + count(entry.paths), 0);
  return [
    { count: facts.stacked?.length ?? 0, icon: <GitArcStackIcon size={14} />, label: "stacked" },
    { count: facts.pending?.length ?? 0, icon: <GitArcProposalIcon size={14} />, label: "pending" },
    { count: facts.accepted?.length ?? 0, icon: <CheckCheckIcon size={14} />, label: "accepted" },
    { count: count(facts.dirtyClaims), icon: <ThreadClaimMarkerIcon marker="dirty" />, label: "dirty" },
    { count: count(facts.cleanClaims), icon: <ThreadClaimMarkerIcon marker="clean" />, label: "clean" },
    { count: stashedPaths, icon: <ArchiveIcon size={14} />, label: "stashed" },
    { count: count(facts.unclaimedDirt), icon: <ThreadClaimMarkerIcon marker="unclaimed" />, label: "unclaimed dirt" },
    { count: lost, icon: <ThreadClaimMarkerIcon marker="unclaimed" />, label: "lost claims" },
  ].filter(entry => entry.count > 0);
}

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
}: {
  content: ThreadGitArcCollapsedSummaryContent;
}) {
  if (content.kind === "status") {
    return (
      <div
        className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] py-2 text-[0.86em] text-fg/muted"
        data-thread-git-arc-collapsed-summary="true"
      >
        {content.counts.length ? content.counts.map(entry => (
          <span className="inline-flex items-center gap-1" key={entry.label}>
            <span aria-hidden="true" className="inline-flex [&_svg]:size-3.5">{entry.icon}</span>
            <b className="font-semibold text-text">{entry.count}</b>{entry.label}
          </span>
        )) : <span>Nothing claimed, pending or dirty</span>}
      </div>
    );
  }
  const totalCount = content.kind === "files" ? content.changes.length
    : content.kind === "claims" ? content.totalCount : content.rows.length;
  const remainingCount = totalCount - Math.min(totalCount, 2);

  return (
    <div
      className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]"
      data-thread-git-arc-collapsed-summary="true"
    >
      {content.kind === "files" ? (
        <ThreadFileChangePreviewList
          changes={content.changes.slice(0, 2)}
        />
      ) : content.kind === "claims" ? (
        <ThreadClaimedFileList
          inset={false}
          label={content.label}
          marker={content.marker}
          paths={content.paths.slice(0, 2)}
        />
      ) : (
        <div className="space-y-1 py-2">
          {content.rows.slice(0, 2).map((row) => (
            <DisclosureStaticRow
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
