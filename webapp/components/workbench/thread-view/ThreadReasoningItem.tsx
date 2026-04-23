"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import { ThreadTextBlock } from "./thread-view-primitives";

function joinClasses(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadReasoningItem({
  className,
  item,
  showLabel = true,
}: {
  className?: string;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  showLabel?: boolean;
}) {
  const summaryEntries = item.summary
    .map((entry) => entry.trim())
    .filter(Boolean);
  const content = item.content
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n");

  return (
    <section className={joinClasses("space-y-2", className)}>
      {showLabel ? (
        <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">
          Reasoning
        </p>
      ) : null}
      {summaryEntries.length ? (
        <ul className="m-0 space-y-1 pl-5 text-[0.92em] leading-[1.6] text-muted">
          {summaryEntries.map((entry, index) => (
            <li key={`${item.id}:summary:${index}`}>{entry}</li>
          ))}
        </ul>
      ) : null}
      {content ? (
        <ThreadTextBlock>{content}</ThreadTextBlock>
      ) : !summaryEntries.length ? (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">
          No detailed reasoning content captured.
        </p>
      ) : null}
    </section>
  );
}
