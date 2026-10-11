/*
 * Exports:
 * - ThreadTooltipSection: one flush tooltip section under a hairline; `bleed` spans the tooltip surface's padding for edge-to-edge notices.
 * - default ThreadTooltipContent: render thread title (optionally after an agent name), title history and status, then caller sections and active claim paths grouped per coloured, titled subagent, without exposing stashed paths.
 */
"use client";

import type { ComponentProps, ComponentType, ReactNode } from "react";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import ClaimedPathsPanel from "./ClaimedPathsPanel";
import ThreadAgentName from "./thread-view/ThreadAgentName";
import type { WorkbenchSubagentClaims } from "./use-workbench-subagent-claims";
import { SnoozedThreadIcon, type IconProps } from "./workbench-icons";
import WorkbenchRelativeTime from "./WorkbenchRelativeTime";
import WorkbenchThreadTitleHistory from "./WorkbenchThreadTitleHistory";

/** Sections sit flush between hairlines; only a questionnaire keeps its own card above them. */
export function ThreadTooltipSection({ bleed = false, className = "", ...section }: ComponentProps<"section"> & {
  /** Spans the tooltip surface's `px-3`, so a notice's bar sits on the tooltip edge. */
  bleed?: boolean;
}) {
  return <section {...section} className={`min-w-0 border-t border-fg/10 pt-2 ${bleed ? "-mx-3" : ""} ${className}`} />;
}

export default function ThreadTooltipContent({
  activityAt,
  agentName,
  claimedPaths,
  extraDetails,
  Icon,
  projectId,
  snoozed,
  status,
  statusClassName,
  stashed,
  subagentClaims = [],
  title,
  identity,
}: {
  activityAt: number;
  /** Shown before the title, e.g. a coloured subagent name. */
  agentName?: ReactNode;
  claimedPaths: readonly string[];
  /** Caller sections between the status line and claims, as a questionnaire card and `ThreadTooltipSection`s. */
  extraDetails?: ReactNode;
  Icon: ComponentType<IconProps>;
  projectId: ProjectId;
  snoozed: boolean;
  status: string;
  statusClassName: string;
  stashed: boolean;
  /** Direct children's active claims, listed per subagent below the thread's own. */
  subagentClaims?: readonly WorkbenchSubagentClaims[];
  title: string;
  identity?: { harness: WorkbenchHarness; threadId: WorkbenchThreadId };
}) {
  const ownClaims = stashed ? [] : claimedPaths;
  return (
    <div data-thread-project-file-link-boundary="true" className="flex max-h-full min-w-0 max-w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
      <p className="m-0 truncate text-[0.9rem] font-medium leading-[1.45] text-text">
        {agentName ? <>{agentName}{" "}</> : null}
        {title}
      </p>
      {identity ? <WorkbenchThreadTitleHistory key={`${projectId}:${identity.harness}:${identity.threadId}`} projectId={projectId} harness={identity.harness} threadId={identity.threadId} /> : null}
      <div className="flex min-w-0 items-center gap-1.5 text-[0.76rem] text-fg/muted">
        <Icon className={`shrink-0 ${statusClassName}`} size={14} />
        <span className={`min-w-0 truncate ${statusClassName}`}>{status}</span>
        <span className="ml-auto" />
        {snoozed ? <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-label="Snoozed"><SnoozedThreadIcon size={16} /></span> : null}
        <WorkbenchRelativeTime className="shrink-0" timestampMs={activityAt} />
      </div>
      {extraDetails}
      {ownClaims.length || subagentClaims.length ? (
        <ThreadTooltipSection aria-label="Claimed files" className="flex flex-col gap-2">
          {ownClaims.length ? (
            <ClaimedPathsPanel label={subagentClaims.length ? "Main agent" : undefined} paths={ownClaims} projectId={projectId} />
          ) : null}
          {subagentClaims.map((child) => (
            <ClaimedPathsPanel
              key={child.threadId}
              label={<ThreadAgentName subagent={child} thread={null} />}
              paths={child.claimedPaths}
              projectId={projectId}
              title={child.title}
            />
          ))}
        </ThreadTooltipSection>
      ) : null}
    </div>
  );
}
