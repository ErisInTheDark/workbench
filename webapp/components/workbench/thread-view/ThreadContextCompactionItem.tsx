"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";

type ContextCompactionItem = Extract<ThreadItem, { type: "contextCompaction" }>;

export default function ThreadContextCompactionItem ({
  item,
}: {
  item: ContextCompactionItem;
}) {
  return (
    <section className="py-2">
      <div
        className="italic flex items-center gap-2 text-muted text-[0.9em]"
        title={item.id}
      >
        <div className="h-[1px] grow bg-muted opacity-10" />
        <p className="m-0 text-[0.92em] leading-[1.6]">Context compacted</p>
        <div className="h-[1px] grow bg-muted opacity-10" />
      </div>
    </section>
  );
}
