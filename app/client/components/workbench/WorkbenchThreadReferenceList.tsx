/*
 * Exports:
 * - default WorkbenchThreadReferenceList: render compact navigable thread references with optional file links and a per-row detail in place of the timestamp.
 */
"use client";

import type { ReactNode } from "react";
import type { WorkbenchThreadTarget, WorkbenchThreadWaitTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { createLogicalExistingThreadRoute, createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import { ProjectIdSchema, type LogicalProjectId } from "workbench-shared/workbench/identity";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import ProjectFileLinkList from "./ProjectFileLinkList";
import { useWorkbenchProjectThreadSidebars } from "./use-workbench-client";

type ProviderThreadSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export default function WorkbenchThreadReferenceList({
  label,
  onOpenThread,
  references,
}: {
  label?: string;
  references: readonly (WorkbenchThreadWaitTarget & {
    /** Shown where the row's timestamp normally goes. */
    detail?: ReactNode;
    entry?: ProviderThreadSidebarEntry; logicalProjectId?: LogicalProjectId | null; paths?: readonly string[];
  })[];
  onOpenThread?: (target: WorkbenchThreadTarget) => void;
}) {
  const projectHref = useWorkbenchProjectNavigation();
  const sidebars = useWorkbenchProjectThreadSidebars();
  if (!references.length) return null;
  const projectFilePaths = references.flatMap(({ paths }) => paths ?? []);
  return (<>
    {label ? <div className="px-2 pt-1 text-[0.78em] font-medium text-fg/muted">{label}</div> : null}
    <ul className="m-0 flex flex-col gap-1 px-1 py-1" data-thread-reference-list="true">
      {references.map(({ detail, entry: suppliedEntry, identity, logicalProjectId, paths = [], projectId, title }) => {
        const entry = suppliedEntry ?? sidebars.projects.find(sidebar => sidebar.projectId === projectId)?.entries.find(
          (candidate): candidate is ProviderThreadSidebarEntry => candidate.entryKind === "thread"
            && candidate.identity.harness === identity.harness && candidate.identity.threadId === identity.threadId,
        );
        const target = { harness: identity.harness, kind: "provider" as const, threadId: identity.threadId };
        const href = projectHref(logicalProjectId
          ? createLogicalExistingThreadRoute(logicalProjectId, target)
          : createThreadRoute(projectId, target));
        return <li key={`${projectId}:${identity.harness}:${identity.threadId}`}>
          {entry ? <WorkbenchThreadListItem
            className="pb-px"
            compact
            entry={entry}
            href={href}
            onActivate={onOpenThread}
            projectId={ProjectIdSchema.parse(projectId)}
            secondaryRow={paths.length ? <ProjectFileLinkList paths={paths} projectFilePaths={projectFilePaths} projectId={projectId} /> : undefined}
            showTooltip={false}
            trailing={detail}
          /> : detail ? (
            <a className="flex items-baseline justify-between gap-3 rounded-[0.65rem] px-2 py-1 text-text hover:bg-accent-soft" href={href}>
              <span className="min-w-0 truncate">{title}</span>
              <span className="shrink-0 text-[0.72rem] text-fg/muted">{detail}</span>
            </a>
          ) : <a className="block rounded-[0.65rem] px-2 py-1 text-text hover:bg-accent-soft" href={href}>{title}</a>}
        </li>;
      })}
    </ul>
  </>);
}
