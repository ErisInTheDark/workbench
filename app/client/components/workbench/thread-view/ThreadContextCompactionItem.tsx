/*
 * Keywords: thread, compaction, label, live duration.
 * Exports:
 * - default ThreadContextCompactionItem: render compaction activity and elapsed duration in one label.
 */
"use client";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

import { formatThreadDuration } from "./thread-view-formatters";
import { useThreadLiveDuration } from "./use-thread-live-duration";

type ContextCompactionItem = Extract<ThreadItem, { type: "contextCompaction" }>;

export default function ThreadContextCompactionItem ({
  isActive,
  item,
  startedAt = null,
  completedAt = null,
}: {
  isActive: boolean;
  item: ContextCompactionItem;
  startedAt?: number | null;
  completedAt?: number | null;
}) {
  const durationMs = startedAt === null ? null
    : completedAt !== null ? Math.max(0, completedAt - startedAt)
    : isActive ? 0 : null;
  const visibleDurationMs = useThreadLiveDuration(durationMs, isActive ? startedAt : null);
  const duration = formatThreadDuration(visibleDurationMs ?? null);
  return (
    <section className="py-2">
      <div
        className={`flex items-center gap-2 text-[0.9em]${isActive ? "" : " italic text-fg/muted"}`}
        title={item.id}
      >
        <div className="h-[1px] grow bg-fg/muted opacity-10" />
        <p className={isActive ? "thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]" : "m-0 text-[0.92em] leading-[1.6]"}>
          {isActive ? "Context compacting" : "Context compacted"}
          {duration ? ` ${duration}` : ""}
        </p>
        <div className="h-[1px] grow bg-fg/muted opacity-10" />
      </div>
    </section>
  );
}
