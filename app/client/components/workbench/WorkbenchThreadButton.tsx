/*
 * Exports:
 * - default WorkbenchThreadButton: inline compact thread row (status, title, time, tooltip), or a custom label link with the thread tooltip, linking to a thread in any project with a text fallback.
 */
"use client";

import { useContext, type ReactNode } from "react";

import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import { useThread } from "./use-thread";
import WorkbenchClientContext from "./workbench-client-context";
import WorkbenchThreadHoverTooltip from "./WorkbenchThreadHoverTooltip";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";

interface WorkbenchThreadButtonProps {
  /** Shown while the thread's row is loading or unknown. */
  fallback: ReactNode;
  /** Render this label as a link with the thread tooltip instead of the compact row, e.g. a coloured subagent name. */
  label?: ReactNode;
  /** `parent` shows the thread that owns the subagent `threadId`. */
  relation?: "self" | "parent";
  threadId: string;
}

/** Transcripts also render outside a mounted client (tests, render lab), where only the fallback can show. */
export default function WorkbenchThreadButton(props: WorkbenchThreadButtonProps) {
  return useContext(WorkbenchClientContext) ? <LoadedWorkbenchThreadButton {...props} /> : <>{props.fallback}</>;
}

/** Leases its thread's summary by id, so references work for threads in any project, listed or not. */
function LoadedWorkbenchThreadButton({ fallback, label, relation = "self", threadId }: WorkbenchThreadButtonProps) {
  const projectHref = useWorkbenchProjectNavigation();
  const child = useThread.summary(relation === "parent" ? threadId : null);
  const targetId = relation === "parent"
    ? child?.summary.row.entryKind === "subagent" ? child.summary.row.parentThreadId : null
    : threadId;
  const thread = useThread.summary(targetId);
  if (!thread) return <>{fallback}</>;
  const entry = thread.summary.row;
  const projectId = thread.location.projectId;
  const route = createThreadRoute(projectId, entry.entryKind === "subagent"
    ? { harness: entry.identity.harness, kind: "subagent", parentThreadId: entry.parentThreadId, threadId: entry.identity.threadId }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId });
  if (label) {
    return (
      <WorkbenchThreadHoverTooltip thread={{ harness: entry.identity.harness, projectId, threadId: entry.identity.threadId }} title={entry.title}>
        <a className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft" data-thread-button="label" href={projectHref(route)}>
          {label}
        </a>
      </WorkbenchThreadHoverTooltip>
    );
  }
  return (
    <ul className="m-0 inline-grid max-w-full list-none p-0 align-middle" data-thread-button="true">
      {/* An empty trailing slot replaces the activity time, which is noise in inline references. */}
      <WorkbenchThreadListItem compact entry={entry} href={projectHref(route)} projectId={projectId} trailing={false} />
    </ul>
  );
}
