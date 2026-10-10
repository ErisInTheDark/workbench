/*
 * Exports:
 * - default WorkbenchThreadEntryBadge: show ordered draft, todo, proposal, live-claim, and saved-stash indicators.
 */
"use client";

import { ArchiveIcon, ClipboardListIcon, ComposerDraftIcon, GitArcProposalIcon, PennantIcon } from "./workbench-icons";

function FileCount({ count, kind }: { count: number; kind: "claimed" | "stashed" }) {
  const Icon = kind === "stashed" ? ArchiveIcon : PennantIcon;
  return (
    <span
      aria-label={`${count} ${kind} ${count === 1 ? "file" : "files"}`}
      className="inline-flex items-center gap-0.5"
      data-role={kind === "stashed" ? "thread-file-stash" : "thread-file-claim"}
    >
      <Icon size={16} /><span>{count}</span>
    </span>
  );
}

function ProposalCount({ count }: { count: number }) {
  return (
    <span aria-label={`${count} ${count === 1 ? "proposal" : "proposals"}`} className="inline-flex items-center gap-0.5" data-role="thread-git-proposal">
      <GitArcProposalIcon size={16} /><span>{count}</span>
    </span>
  );
}

export default function WorkbenchThreadEntryBadge({
  claimedCount,
  hasComposerDraft,
  proposalCount = 0,
  stashedCount,
  todoCount = 0,
}: {
  /** Active claims, including any rolled up from subagents. */
  claimedCount: number;
  hasComposerDraft: boolean;
  /** Lifecycle proposals, including proposals grouped into sealed stack layers. */
  proposalCount?: number;
  stashedCount: number;
  /** Follow-up todos the thread holds. */
  todoCount?: number;
}) {
  if (!hasComposerDraft && !todoCount && !proposalCount && !claimedCount && !stashedCount) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {hasComposerDraft ? (
        <span data-role="thread-composer-draft" className="inline-flex size-4 items-center justify-center" title="Unsent draft">
          <ComposerDraftIcon size={16} />
        </span>
      ) : null}
      {todoCount ? (
        <span aria-label={`${todoCount} ${todoCount === 1 ? "todo" : "todos"}`} className="inline-flex items-center gap-0.5" data-role="thread-todos">
          <ClipboardListIcon size={16} /><span>{todoCount}</span>
        </span>
      ) : null}
      {proposalCount ? <ProposalCount count={proposalCount} /> : null}
      {claimedCount ? <FileCount count={claimedCount} kind="claimed" /> : null}
      {stashedCount ? <FileCount count={stashedCount} kind="stashed" /> : null}
    </span>
  );
}
