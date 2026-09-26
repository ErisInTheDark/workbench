/*
 * Exports:
 * - default WorkbenchThreadReferenceList: render compact navigable thread references with optional file links.
 */
"use client";

import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget, WorkbenchThreadWaitTarget } from "workbench-shared/workbench/thread/thread-state";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
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
  references: readonly (WorkbenchThreadWaitTarget & { entry?: ProviderThreadSidebarEntry; paths?: readonly string[] })[];
  onOpenThread?: (target: WorkbenchThreadTarget) => void;
}) {
  const projectHref = useWorkbenchProjectNavigation();
  const sidebars = useWorkbenchProjectThreadSidebars();
  if (!references.length) return null;
  const projectFilePaths = references.flatMap(({ paths }) => paths ?? []);
  return (<>
    {label ? <div className="px-2 pt-1 text-[0.78em] font-medium text-fg/muted">{label}</div> : null}
    <ul className="m-0 flex flex-col gap-1 px-1 py-1" data-thread-reference-list="true">
      {references.map(({ entry: suppliedEntry, identity, paths = [], projectId, title }) => {
        const entry = suppliedEntry ?? sidebars.projects.find(sidebar => sidebar.projectId === projectId)?.entries.find(
          (candidate): candidate is ProviderThreadSidebarEntry => candidate.entryKind === "thread"
            && candidate.identity.harness === identity.harness && candidate.identity.threadId === identity.threadId,
        );
        const target = { harness: identity.harness, kind: "provider" as const, threadId: identity.threadId };
        const href = projectHref(createThreadRoute(projectId, target));
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
          /> : <a className="block rounded-[0.65rem] px-2 py-1 text-text hover:bg-accent-soft" href={href}>{title}</a>}
        </li>;
      })}
    </ul>
  </>);
}
