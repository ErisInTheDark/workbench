/*
 * Keywords: generic item, presentation, matcher, fallback.
 * Exports:
 * - default ThreadGenericItem: match provider presentation or retain an expandable raw payload.
 */
"use client";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchProjectedGenericItem } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { matchThreadGenericItem } from "../../../workbench/thread/thread-generic-item-matchers";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSleepItem from "./ThreadSleepItem";
import ThreadSummaryText from "./ThreadSummaryText";

export default function ThreadGenericItem({
  item,
  timeline,
  turnStatus = "completed",
}: {
  item: ThreadItem | WorkbenchProjectedGenericItem;
  timeline?: WorkbenchThreadItemTimelineEntry | null;
  turnStatus?: Turn["status"];
}) {
  const source = item.type === "generic"
    ? item
    : { nativeType: item.type, safeValue: item };
  const match = matchThreadGenericItem(source);
  if (match) {
    return <ThreadSleepItem key={item.id} durationMs={match.durationMs} timeline={timeline} turnStatus={turnStatus} />;
  }
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text="generic thread item" />}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
        {JSON.stringify(source.safeValue, null, 2)}
      </pre>
    </ThreadDisclosure>
  );
}
