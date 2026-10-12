/*
 * Exports:
 * - resolveSidebarCreateProject: pick the selected project that owns the sidebar's create-thread location.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";

export function resolveSidebarCreateProject({
  createProjectId,
  logicalProject,
  logicalProjects,
  projects,
  selectedOwnerProjectId,
  selectedProjectIds,
}: {
  createProjectId: string | undefined;
  logicalProject: WorkbenchLogicalProject | null | undefined;
  logicalProjects: readonly WorkbenchLogicalProject[] | undefined;
  projects: readonly WorkbenchProjectOption[];
  selectedOwnerProjectId?: string;
  selectedProjectIds: readonly string[];
}): WorkbenchProjectOption | WorkbenchLogicalProject | null {
  const selectedSet = new Set(selectedProjectIds);
  if (!logicalProject && !logicalProjects) {
    return projects.find(({ id }) => id === selectedOwnerProjectId && selectedSet.has(id))
      ?? projects.find(({ id }) => id === createProjectId && selectedSet.has(id))
      ?? null;
  }
  // Selection holds logical ids; createProjectId is the physical id of a live location.
  const candidates = logicalProject ? [logicalProject] : logicalProjects ?? [];
  const available = (project: WorkbenchLogicalProject) =>
    selectedSet.has(project.id) && project.locations.some(location => location.project);
  return candidates.find(project => project.id === selectedOwnerProjectId && available(project))
    ?? candidates.find(project => selectedSet.has(project.id)
    && project.locations.some(location => location.project && location.target.projectId === createProjectId)) ?? null;
}
