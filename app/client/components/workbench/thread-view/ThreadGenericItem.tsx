/*
 * Exports:
 * - default ThreadGenericItem: match provider or Workbench item presentation or retain an expandable raw payload.
 */
"use client";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchProjectedGenericItem } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { matchThreadGenericItem } from "../../../workbench/thread/thread-generic-item-matchers";
import { CodeIcon } from "../workbench-icons";
import ThreadSleepItem from "./ThreadSleepItem";
import ThreadStepRow from "./ThreadStepRow";
import { ThreadVisSnapshotRow } from "./ThreadVisCommandItem";

export default function ThreadGenericItem({
  item,
  threadId,
  timeline,
  turnStatus = "completed",
}: {
  item: ThreadItem | WorkbenchProjectedGenericItem;
  threadId: string;
  timeline?: WorkbenchThreadItemTimelineEntry | null;
  turnStatus?: Turn["status"];
}) {
  const source = item.type === "generic"
    ? item
    : { nativeType: item.type, safeValue: item };
  const match = matchThreadGenericItem(source);
  switch (match?.kind) {
    case "sleep":
      return <ThreadSleepItem key={item.id} durationMs={match.durationMs} timeline={timeline} turnStatus={turnStatus} />;
    case "visEnd":
      return <ThreadVisSnapshotRow durationMs={null} path={match.path} sessionId={match.sessionId} snapshotKind="end" threadId={threadId} />;
  }
  return (
    <ThreadStepRow
      icon={<CodeIcon size={16} />}
      label={source.nativeType}
      renderContent={() => (
        <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text">
          {JSON.stringify(source.safeValue, null, 2)}
        </pre>
      )}
    />
  );
}
