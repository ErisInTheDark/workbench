/*
 * Exports:
 * - default WorkbenchThreadEntryBadge: show independent live-claim and saved-stash counts, or an unsent-draft icon.
 */
"use client";

import { ArchiveIcon, ComposerDraftIcon, FlagIcon } from "./workbench-icons";

function FileCount({ count, kind }: { count: number; kind: "claimed" | "stashed" }) {
  const Icon = kind === "stashed" ? ArchiveIcon : FlagIcon;
  return (
    <span
      aria-label={`${count} ${kind} ${count === 1 ? "file" : "files"}`}
      className="inline-flex items-center gap-0.5"
      data-role={kind === "stashed" ? "thread-file-stash" : "thread-file-claim"}
    >
      <Icon size={14} /><span>{count}</span>
    </span>
  );
}

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
    return (
      <span className="inline-flex items-center gap-1.5">
        {claimedCount ? <FileCount count={claimedCount} kind="claimed" /> : null}
        {stashedCount ? <FileCount count={stashedCount} kind="stashed" /> : null}
      </span>
    );
  }
  return hasComposerDraft ? (
    <span data-role="thread-composer-draft" className="inline-flex size-4 items-center justify-center" title="Unsent draft">
      <ComposerDraftIcon size={14} />
    </span>
  ) : null;
}
