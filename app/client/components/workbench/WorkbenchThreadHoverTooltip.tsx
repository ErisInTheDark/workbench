/*
 * Exports:
 * - default WorkbenchThreadHoverTooltip: give any thread link the sidebar's thread tooltip, loading the thread only while it shows.
 */
"use client";

import type { ComponentProps } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { describeThreadEntry } from "./thread-entry-presentation";
import { useWorkbenchThread } from "./use-workbench-thread";
import { ThreadTooltipContent } from "./WorkbenchThreadListItem";
import WorkbenchTooltip from "./WorkbenchTooltip";

interface ThreadIdentity { harness: WorkbenchHarness; projectId: ProjectId; threadId: WorkbenchThreadId }

/** Mounted only while the tooltip is open, so hovering is what acquires the thread's summary interest. */
function LoadedThreadTooltip({ harness, projectId, threadId, title }: ThreadIdentity & { title: string }) {
  const thread = useWorkbenchThread(projectId, { harness, kind: "provider", threadId });
  const entry = thread.state.entry;
  if (!entry) return <p className="m-0 text-[0.8rem] text-fg/muted">{thread.state.status === "loading" ? `Loading ${title}…` : title}</p>;
  const shown = describeThreadEntry(entry, { nowMs: Date.now() });
  return (
    <ThreadTooltipContent
      claimedPaths={shown.claimedPaths}
      dateTime={shown.dateTime}
      exactTime={shown.exactTime}
      Icon={shown.Icon}
      identity={{ harness, threadId }}
      projectId={projectId}
      relativeTime={shown.relativeTime}
      snoozed={shown.group === "snoozed"}
      stashed={shown.stashed}
      status={shown.tooltipStatus}
      statusClassName={shown.statusClassName}
      title={entry.title}
    />
  );
}

export default function WorkbenchThreadHoverTooltip({ children, thread, title }: {
  children: ComponentProps<typeof WorkbenchTooltip>["children"];
  /** Null renders the trigger alone, for threads Workbench cannot open. */
  thread: ThreadIdentity | null;
  title: string;
}) {
  if (!thread) return children;
  return (
    <WorkbenchTooltip content={<LoadedThreadTooltip {...thread} title={title} />} interactive>
      {children}
    </WorkbenchTooltip>
  );
}
