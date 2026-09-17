/* Exports: default WorkbenchGitSidebar: render selected-project unclaimed Git status and navigation. */
"use client";
import type { MouseEvent } from "react";
import { createGitRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import { GitArcClaimIcon, GitArcCleanClaimIcon, GitArcDirtyClaimIcon } from "../workbench-icons";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListLabelClassName } from "../workbench-class-names";
import WorkbenchSidebarSectionDisclosure from "../WorkbenchSidebarSectionDisclosure";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitSidebar({ active, onNavigate }: { active: boolean; onNavigate(event: MouseEvent<HTMLAnchorElement>): void }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const projectHref = useWorkbenchProjectNavigation();
  if (!state.projectId) return null;
  const dirty = snapshot.data.repositories.some(repository => repository.files.some(file => !file.ownerIds.length));
  const Icon = dirty ? GitArcDirtyClaimIcon : GitArcCleanClaimIcon;
  const label = snapshot.status === "idle" || snapshot.status === "loading" ? "Checking changes..."
    : snapshot.status === "error" || snapshot.data.errors.length ? "Changes unavailable"
    : snapshot.status === "unavailable" ? "Git unavailable"
    : dirty ? "Uncommitted changes" : "No changes";
  return <section className="shrink-0 pb-5">
    <WorkbenchSidebarSectionDisclosure icon={GitArcClaimIcon} preferenceKey="gitOpen" title="Git">
      <a href={projectHref(createGitRoute(state.projectId))} onClick={onNavigate} aria-current={active ? "page" : undefined} className={`
        ${workbenchOptionRowClassName} min-h-9 w-full md:min-h-8
        ${active ? `${workbenchOptionSelectedClassName} text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
      `}>
        <Icon size={16} />
        <span className={workbenchThreadListLabelClassName}>{label}</span>
      </a>
    </WorkbenchSidebarSectionDisclosure>
  </section>;
}
