/*
 * Exports:
 * - default WorkbenchThreadHoverTooltip: give any thread link the sidebar's thread tooltip, optionally led by an agent name, leasing the thread's summary only while it shows.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { describeThreadEntry } from "./thread-entry-presentation";
import { useThread } from "./use-thread";
import { ThreadTooltipContent } from "./WorkbenchThreadListItem";
import Tooltip from "../ui/Tooltip";

interface ThreadIdentity { harness: WorkbenchHarness; projectId: ProjectId; threadId: WorkbenchThreadId }

/** Mounted only while the tooltip is open, so hovering is what leases the thread's summary. */
function LoadedThreadTooltip({ agentName, harness, projectId, threadId, title }: ThreadIdentity & { agentName?: ReactNode; title: string }) {
  const thread = useThread.summary(threadId);
  if (!thread) return <p className="m-0 text-[0.8rem] text-fg/muted">{`Loading ${title}…`}</p>;
  const entry = thread.summary.row;
  const shown = describeThreadEntry(entry, { facts: thread.summary.facts });
  return (
    <ThreadTooltipContent
      activityAt={shown.activityAt}
      agentName={agentName}
      claimedPaths={shown.claimedPaths}
      Icon={shown.Icon}
      identity={{ harness, threadId }}
      projectId={projectId}
      snoozed={shown.group === "snoozed"}
      stashed={shown.stashed}
      status={shown.tooltipStatus}
      statusClassName={shown.statusClassName}
      title={entry.title}
    />
  );
}

export default function WorkbenchThreadHoverTooltip({ agentName, children, placement, thread, title }: {
  /** Shown before the thread title, e.g. a coloured subagent name. */
  agentName?: ReactNode;
  children: ComponentProps<typeof Tooltip>["children"];
  placement?: ComponentProps<typeof Tooltip>["placement"];
  /** Null renders the trigger alone, for threads Workbench cannot open. */
  thread: ThreadIdentity | null;
  title: string;
}) {
  if (!thread) return children;
  return (
    <Tooltip content={<LoadedThreadTooltip {...thread} agentName={agentName} title={title} />} interactive placement={placement}>
      {children}
    </Tooltip>
  );
}
