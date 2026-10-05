/*
 * Exports:
 * - default ThreadGitArcStackedProposals: sealed proposal titles with inline totals, expanding to descriptions and per-file totals.
 */
"use client";

import type { GitArcStackedProposal } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { createThreadGitArcCompareSummaryRows } from "./ThreadGitArcCollapsedSummary";
import { ThreadFileChangeList, ThreadFileChangeTotals } from "./ThreadFileChangeItem";

const STATUS = { add: "A", delete: "D", update: "M" } as const;

export default function ThreadGitArcStackedProposals({
  expanded,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposals,
  workspaceRoots,
}: {
  expanded: boolean;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  proposals: readonly GitArcStackedProposal[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <div className={expanded ? "space-y-2 py-1.5" : "space-y-0.5 py-1.5"} data-thread-git-arc-stacked-proposals="true">
      {proposals.map(({ changes, description, proposalId, title }) => (
        <div key={proposalId}>
          <div className="flex min-w-0 items-baseline gap-2 text-[0.84em] leading-[1.5]">
            <span className="min-w-0 truncate text-text">{title}</span>
            <ThreadFileChangeTotals
              additions={changes.reduce((total, change) => total + change.additions, 0)}
              deletions={changes.reduce((total, change) => total + change.deletions, 0)}
            />
          </div>
          {expanded ? (
            <>
              {description.trim() ? (
                <p className="m-0 whitespace-pre-wrap text-[0.78em] leading-[1.5] text-fg/muted">{description.trim()}</p>
              ) : null}
              <ThreadFileChangeList
                changes={createThreadGitArcCompareSummaryRows(changes.map(change => ({ ...change, status: STATUS[change.kind] })))
                  .map(row => ({ ...row, detailsAvailable: false }))}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceRoots}
              />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
