/*
 * Exports:
 * - SidebarCreateTarget: the selected logical/physical project and exact logical-project folder for sidebar creation.
 * - resolveSidebarCreateTarget: pick the latest selected-project creation target, with stable selected fallbacks.
 */
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { preferredSelectedLaunchTarget } from "workbench-shared/workbench/project/workbench-project-projection";

export interface SidebarCreateTarget {
  location: ProjectLocationReference | null;
  project: WorkbenchLogicalProject | WorkbenchProjectOption;
}

export function resolveSidebarCreateTarget({
  createProjectId,
  logicalProject,
  logicalProjects,
  projects,
  presentation,
  selectedOwnerProjectId,
  selectedProjectIds,
}: {
  createProjectId: string | undefined;
  logicalProject: WorkbenchLogicalProject | null | undefined;
  logicalProjects: readonly WorkbenchLogicalProject[] | undefined;
  presentation?: PresentationSnapshot | null;
  projects: readonly WorkbenchProjectOption[];
  selectedOwnerProjectId?: string;
  selectedProjectIds: readonly string[];
}): SidebarCreateTarget | null {
  const selectedSet = new Set(selectedProjectIds);
  if (!logicalProject && !logicalProjects) {
    const project = projects.find(({ id }) => id === selectedOwnerProjectId && selectedSet.has(id))
      ?? projects.find(({ id }) => id === createProjectId && selectedSet.has(id));
    return project ? { location: null, project } : null;
  }
  return preferredSelectedLaunchTarget(
    logicalProjects ?? (logicalProject ? [logicalProject] : []),
    selectedProjectIds,
    presentation,
  );
}
