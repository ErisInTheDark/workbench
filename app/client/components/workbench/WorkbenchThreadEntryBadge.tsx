/*
 * Exports:
 * - default WorkbenchThreadEntryBadge: show ordered draft, required-todo, feedback, proposal, live-claim, and saved-stash indicators.
 */
"use client";

import { ArchiveIcon, ClipboardListIcon, ComposerDraftIcon, GitArcProposalIcon, MegaphoneIcon, PennantIcon } from "./workbench-icons";
import { FEEDBACK_TEXT_TONE_CLASS_NAME } from "./feedback-presentation";

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
  feedbackCount = 0,
  hasComposerDraft,
  proposalCount = 0,
  stashedCount,
  requiredTodoCount = 0,
}: {
  /** Active claims, including any rolled up from subagents. */
  claimedCount: number;
  /** Addressed feedback shown only when the parent row's lifecycle makes cleanup relevant. */
  feedbackCount?: number;
  hasComposerDraft: boolean;
  /** Lifecycle proposals, including proposals grouped into sealed stack layers. */
  proposalCount?: number;
  stashedCount: number;
  /** Required follow-up todos the thread still holds; optional ones stay in the thread's own panel. */
  requiredTodoCount?: number;
}) {
  if (!hasComposerDraft && !requiredTodoCount && !feedbackCount && !proposalCount && !claimedCount && !stashedCount) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {hasComposerDraft ? (
        <span data-role="thread-composer-draft" className="inline-flex size-4 items-center justify-center" title="Unsent draft">
          <ComposerDraftIcon size={16} />
        </span>
      ) : null}
      {requiredTodoCount ? (
        <span aria-label={`${requiredTodoCount} required ${requiredTodoCount === 1 ? "todo" : "todos"}`} className="inline-flex items-center gap-0.5" data-role="thread-todos">
          <ClipboardListIcon size={16} /><span>{requiredTodoCount}</span>
        </span>
      ) : null}
      {feedbackCount ? (
        <span
          aria-label={`${feedbackCount} addressed feedback ${feedbackCount === 1 ? "report" : "reports"}`}
          className={`inline-flex items-center gap-0.5 ${FEEDBACK_TEXT_TONE_CLASS_NAME}`}
          data-role="thread-feedback"
        >
          <MegaphoneIcon size={16} /><span>{feedbackCount}</span>
        </span>
      ) : null}
      {proposalCount ? <ProposalCount count={proposalCount} /> : null}
      {claimedCount ? <FileCount count={claimedCount} kind="claimed" /> : null}
      {stashedCount ? <FileCount count={stashedCount} kind="stashed" /> : null}
    </span>
  );
}
