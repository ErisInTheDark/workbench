/*
 * Exports:
 * - ThreadTurnLoadingSkeleton: placeholder for an unloaded history turn.
 * - ThreadTurnLoadFailure: retry controls for a failed history read.
 * - ThreadContentLoadingSkeleton: placeholder for a transcript whose turn has not arrived yet.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";

export function ThreadTurnLoadingSkeleton ({
  entry,
  isLoading = false,
}: {
  entry: WorkbenchThreadTurnHistoryEntry;
  isLoading?: boolean;
}) {
  return (
    <section className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3" data-thread-turn-load-state={entry.loadState}>
      <div className="space-y-2" aria-busy={isLoading ? "true" : undefined}>
        <div className="h-3 w-28 animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" />
        <div className="space-y-1.5">
          <div className="h-3 w-[82%] animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_8%,transparent)]" />
          <div className="h-3 w-[64%] animate-pulse rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)]" />
        </div>
      </div>
    </section>
  );
}

export function ThreadTurnLoadFailure({
  entry,
  onRetry,
}: {
  entry: WorkbenchThreadTurnHistoryEntry;
  onRetry: () => void;
}) {
  return (
    <section
      className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-3"
      data-thread-turn-load-state={entry.loadState}
    >
      <div className="flex items-center justify-between gap-3 text-[0.88em] leading-[1.5] text-fg/muted" role="status">
        <span>Could not load this previous turn.</span>
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 font-medium text-text transition-colors hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    </section>
  );
}

export function ThreadContentLoadingSkeleton () {
  return (
    <div aria-label="Loading subagent thread" aria-live="polite" role="status" className="space-y-3 py-1">
      <div className="h-3.5 w-44 max-w-full rounded-full workbench-skeleton" aria-hidden="true" />
      <div className="space-y-2">
        <div className="h-3 w-[92%] rounded-full workbench-skeleton" aria-hidden="true" />
        <div className="h-3 w-[76%] rounded-full workbench-skeleton" aria-hidden="true" />
        <div className="h-3 w-[84%] rounded-full workbench-skeleton" aria-hidden="true" />
      </div>
    </div>
  );
}
