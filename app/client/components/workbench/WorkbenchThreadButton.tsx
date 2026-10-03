/*
 * Exports:
 * - WorkbenchThreadButtonTarget: a thread by id, or the parent of a subagent thread.
 * - findWorkbenchThreadButtonEntry: resolve a target to a loaded thread or subagent sidebar entry and its project.
 * - default WorkbenchThreadButton: inline compact thread row (status, title, time, tooltip), or a custom label link with the thread tooltip, linking to a thread with a text fallback.
 */
"use client";

import { useContext, useMemo, type ReactNode } from "react";

import { ProjectIdSchema, type ProjectId } from "workbench-shared/workbench/identity";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type {
  WorkbenchProjectThreadRowSidebars as WorkbenchProjectThreadSidebars, WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-sidebar-row";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import { useWorkbenchProjectThreadSidebars } from "./use-workbench-client";
import WorkbenchClientContext from "./workbench-client-context";
import WorkbenchThreadHoverTooltip from "./WorkbenchThreadHoverTooltip";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";

export type WorkbenchThreadButtonTarget = { threadId: string } | { parentOf: string };
type ProviderEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export function findWorkbenchThreadButtonEntry(sidebars: WorkbenchProjectThreadSidebars, target: WorkbenchThreadButtonTarget) {
  const find = (threadId: string) => {
    for (const sidebar of sidebars.projects) {
      const entry = sidebar.entries.find((candidate): candidate is ProviderEntry => candidate.entryKind !== "draft" && candidate.identity.threadId === threadId);
      if (entry) return { entry, projectId: ProjectIdSchema.parse(sidebar.projectId) as ProjectId };
    }
    return null;
  };
  if ("threadId" in target) return find(target.threadId);
  const child = find(target.parentOf);
  return child?.entry.entryKind === "subagent" ? find(child.entry.parentThreadId) : null;
}

interface WorkbenchThreadButtonProps {
  /** Shown while the thread is not in any loaded project sidebar. */
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

function LoadedWorkbenchThreadButton({ fallback, label, relation = "self", threadId }: WorkbenchThreadButtonProps) {
  const sidebars = useWorkbenchProjectThreadSidebars();
  const projectHref = useWorkbenchProjectNavigation();
  const found = useMemo(
    () => findWorkbenchThreadButtonEntry(sidebars, relation === "parent" ? { parentOf: threadId } : { threadId }),
    [relation, sidebars, threadId],
  );
  if (!found) return <>{fallback}</>;
  const { entry, projectId } = found;
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
