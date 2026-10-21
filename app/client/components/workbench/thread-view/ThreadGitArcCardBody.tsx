/*
 * Exports:
 * - default ThreadGitArcCardBody: what a Git arc card opens into, laid flat: edit session details, the caller's operation
 *   details, stacked commits, status facts, member roots, the card's path groups, unstash conflicts and any failure.
 */
"use client";

import type { ReactNode } from "react";

import type { GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { summarizeGitArcChanges } from "workbench-shared/workbench/git/git-arc-change-totals";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadGitArcCollapsedSummary, { createThreadGitArcEditSummaryRows } from "./ThreadGitArcCollapsedSummary";
import ThreadGitArcEditDetails from "./ThreadGitArcEditDetails";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcStatusDetails from "./ThreadGitArcStatusDetails";
import type { GitArcCard } from "./thread-git-arc-card";

const DIVIDER = "border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)]";

export default function ThreadGitArcCardBody({ card, editResult, operationDetails, statusIncomplete, statusOutput }: {
  card: GitArcCard;
  editResult: GitArcEditResult | null;
  /** Operation-specific detail the caller renders, such as a compare's file list; a claim failure's own lists replace it. */
  operationDetails?: ReactNode;
  statusIncomplete: boolean;
  statusOutput: string | undefined;
}) {
  const claimFailure = card.failure?.code === "ignoredPaths" || (card.action === "start" && card.failure?.code === "planDrift");
  return (
    <div className="space-y-1" data-thread-git-arc-body={card.action}>
      {editResult ? <ThreadGitArcEditDetails result={editResult} rows={createThreadGitArcEditSummaryRows(editResult.files)} /> : null}
      {operationDetails && !claimFailure ? <div>{operationDetails}</div> : null}
      {card.stackedProposals.length ? (
        <div className="divide-y divide-[color-mix(in_srgb,var(--text)_8%,transparent)]" data-thread-git-arc-stacked-proposals="true">
          {card.stackedProposals.map(({ changeCount, changes, description, proposalId, title }) => (
            <ThreadCheckpointCommitCard
              key={proposalId}
              sourceItemId={`stacked-proposal:${proposalId}`}
              state={{
                status: "summary",
                summary: {
                  ...(changeCount === undefined ? {} : { changeCount }),
                  ...(changes ? { changes } : {}),
                  description, title, totals: changes ? summarizeGitArcChanges(changes) : null,
                },
              }}
            />
          ))}
        </div>
      ) : null}
      {card.status ? <ThreadGitArcStatusDetails incomplete={statusIncomplete} output={statusOutput ?? ""} status={card.status} /> : null}
      {card.memberRefs.length > 1 ? (
        <div className="space-y-0.5 py-1 text-[0.78em] text-fg/muted" data-thread-git-arc-members="true">
          {card.memberRefs.map((member) => (
            <div className="flex min-w-0 items-baseline gap-2" key={`${member.rootId}:${member.ref}`}>
              <span className="min-w-0 flex-1 truncate">{member.rootId}</span>
              <span className="font-mono">{member.ref.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {card.pathGroups.map(group => (
        <ThreadClaimedFileList
          inset={false}
          key={group.key}
          label={group.label}
          marker={group.marker}
          pathTotals={group.totals}
          paths={[...group.paths]}
          tone={group.danger ? "danger" : "default"}
        />
      ))}
      {!card.pathGroups.length && card.counts.length ? <ThreadGitArcCollapsedSummary content={{ kind: "counts", rows: card.counts }} /> : null}
      {card.conflictedPaths.length ? (
        <div className={`${DIVIDER} pt-1.5`}>
          <ThreadClaimedFileList label="Resolve conflict markers" marker="dirty" paths={[...card.conflictedPaths]} />
          <p className="px-2 pb-1 text-[0.78em] text-fg/muted">Edit the markers directly. No Git continuation or abort command is required.</p>
        </div>
      ) : null}
      {card.failure ? <ThreadGitArcFailure failure={card.failure} /> : null}
    </div>
  );
}
