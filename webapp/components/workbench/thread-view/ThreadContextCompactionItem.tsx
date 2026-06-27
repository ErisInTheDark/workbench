"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";

type ContextCompactionItem = Extract<ThreadItem, { type: "contextCompaction" }>;

export default function ThreadContextCompactionItem ({
  isActive,
  item,
}: {
  isActive: boolean;
  item: ContextCompactionItem;
}) {
  return (
    <section className="py-2">
      <div
        className={`flex items-center gap-2 text-[0.9em]${isActive ? "" : " italic text-muted"}`}
        title={item.id}
      >
        <div className="h-[1px] grow bg-muted opacity-10" />
        <p className={isActive ? "thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]" : "m-0 text-[0.92em] leading-[1.6]"}>
          {isActive ? "Context compacting" : "Context compacted"}
        </p>
        <div className="h-[1px] grow bg-muted opacity-10" />
      </div>
    </section>
  );
}
