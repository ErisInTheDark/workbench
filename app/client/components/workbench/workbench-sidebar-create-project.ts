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
  selectedProjectIds,
}: {
  createProjectId: string | undefined;
  logicalProject: WorkbenchLogicalProject | null | undefined;
  logicalProjects: readonly WorkbenchLogicalProject[] | undefined;
  projects: readonly WorkbenchProjectOption[];
  selectedProjectIds: readonly string[];
}): WorkbenchProjectOption | WorkbenchLogicalProject | null {
  const selectedSet = new Set(selectedProjectIds);
  if (!logicalProject && !logicalProjects) {
    return projects.find(({ id }) => id === createProjectId && selectedSet.has(id)) ?? null;
  }
  // Selection holds logical ids; createProjectId is the physical id of a live location.
  const candidates = logicalProject ? [logicalProject] : logicalProjects ?? [];
  return candidates.find(project => selectedSet.has(project.id)
    && project.locations.some(location => location.project && location.target.projectId === createProjectId)) ?? null;
}
