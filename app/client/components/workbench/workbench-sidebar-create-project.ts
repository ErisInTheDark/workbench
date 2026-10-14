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
  // Selection holds logical ids; createProjectId is the physical id of a live location.
  const candidates = logicalProject ? [logicalProject] : logicalProjects ?? [];
  const available = (project: WorkbenchLogicalProject) =>
    selectedSet.has(project.id) && project.locations.some(location => location.project);
  const hasAcceptedSelection = !logicalProject && presentation?.drafts.some(draft =>
    draft.phase === "accepted" && selectedSet.has(draft.logicalProjectId)
    && candidates.some(project => project.id === draft.logicalProjectId
      && project.locations.some(location =>
        location.target.daemonId === draft.target.daemonId
        && location.target.projectId === draft.target.projectId)));
  if (hasAcceptedSelection && presentation) {
    const preferred = preferredSelectedLaunchTarget(candidates, selectedProjectIds, presentation);
    if (preferred) return preferred;
  }
  const project = candidates.find(candidate => candidate.id === selectedOwnerProjectId && available(candidate))
    ?? candidates.find(candidate => selectedSet.has(candidate.id)
      && candidate.locations.some(location => location.project && location.target.projectId === createProjectId));
  if (!project) return null;
  const location = project.locations.find(item =>
    item.project && item.target.projectId === createProjectId)?.target
    ?? project.locations.find(item => item.project)?.target
    ?? null;
  return location ? { location, project } : null;
}
