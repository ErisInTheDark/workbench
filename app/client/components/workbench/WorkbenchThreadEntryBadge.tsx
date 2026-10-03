/*
 * Exports:
 * - default WorkbenchThreadEntryBadge: the thread row's single metadata slot: claimed-file flag, stash count, or unsent-draft icon.
 */
"use client";

import { ArchiveIcon, ComposerDraftIcon, FlagIcon } from "./workbench-icons";

export default function WorkbenchThreadEntryBadge({
  claimedCount,
  hasComposerDraft,
  stashedCount,
}: {
  /** Active claims, including any rolled up from subagents. */
  claimedCount: number;
  hasComposerDraft: boolean;
  stashedCount: number;
}) {
  if (claimedCount || stashedCount) {
    const stashed = !claimedCount;
    const count = claimedCount || stashedCount;
    return (
      <span
        aria-label={`${count} ${stashed ? "stashed" : "claimed"} ${count === 1 ? "file" : "files"}`}
        className="inline-flex items-center gap-0.5"
        data-role={stashed ? "thread-file-stash" : "thread-file-claim"}
      >
        {stashed ? <ArchiveIcon size={14} /> : <FlagIcon size={14} />}<span>{count}</span>
      </span>
    );
  }
  return hasComposerDraft ? (
    <span data-role="thread-composer-draft" className="inline-flex size-4 items-center justify-center" title="Unsent draft">
      <ComposerDraftIcon size={14} />
    </span>
  ) : null;
}
