/* Exports: default WorkbenchGitSidebar: render selected-project unclaimed Git status and navigation. */
"use client";
import { useEffect, type MouseEvent } from "react";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListLabelClassName } from "../workbench-class-names";
import { GitArcCleanClaimIcon, GitArcDirtyClaimIcon, GitGraphIcon } from "../workbench-icons";
import WorkbenchSidebarSectionDisclosure from "../WorkbenchSidebarSectionDisclosure";
import { useWorkbenchSidebarPreferences } from "../workbench-sidebar-preferences-context";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitSidebar ({ active, route, onNavigate }: {
  active: boolean; route: WorkbenchRoute; onNavigate (event: MouseEvent<HTMLAnchorElement>): void;
}) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const { preferences } = useWorkbenchSidebarPreferences();
  useEffect(() => preferences.gitOpen ? state.acquireDemand("summary") : undefined, [preferences.gitOpen, state]);
  const projectHref = useWorkbenchProjectNavigation();
  if (!state.projectId) return null;
  const dirty = snapshot.summary.repositories.some(repository => repository.dirty);
  const Icon = dirty ? GitArcDirtyClaimIcon : GitArcCleanClaimIcon;
  const label = snapshot.summaryStatus === "idle" || snapshot.summaryStatus === "loading" ? "Checking changes..."
    : snapshot.summaryStatus === "error" || snapshot.summary.errors.length ? "Changes unavailable"
      : snapshot.summaryStatus === "unavailable" ? "Git unavailable"
        : dirty ? "Uncommitted changes" : "No changes";
  return <section className="shrink-0 pb-3">
    <WorkbenchSidebarSectionDisclosure icon={GitGraphIcon} preferenceKey="gitOpen" title="Git">
      <a href={projectHref(route, "exact")} onClick={onNavigate} aria-current={active ? "page" : undefined} className={`
        ${workbenchOptionRowClassName} min-h-9 w-full md:min-h-8
        ${active ? `${workbenchOptionSelectedClassName} text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
      `}>
        <Icon size={16} />
        <span className={workbenchThreadListLabelClassName}>{label}</span>
      </a>
    </WorkbenchSidebarSectionDisclosure>
  </section>;
}
