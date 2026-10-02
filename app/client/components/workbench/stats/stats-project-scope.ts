/*
 * Exports:
 * - StatsProjectScope: the sidebar selection expressed as projects on the daemon that serves statistics.
 * - resolveStatsProjectScope: map selected logical or physical projects onto one daemon's project ids and names.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";

export interface StatsProjectScope {
  /** The daemon whose statistics are observed; null until the app knows it. */
  daemonId: string | null;
  /** Physical project ids on the stats daemon, in selection order. */
  projectIds: string[];
  /** Selected projects counted here, one label per selected project. */
  labels: string[];
  /** Selected projects with no location on the stats daemon; their usage lives elsewhere. */
  elsewhere: string[];
  names: ReadonlyMap<string, string>;
}

export function resolveStatsProjectScope({ daemonId, logicalProjects, projects, selectedProjectIds }: {
  daemonId: string | null;
  /** Undefined when the sidebar shows physical projects directly. */
  logicalProjects: readonly WorkbenchLogicalProject[] | undefined;
  projects: readonly Pick<WorkbenchProjectOption, "id" | "name">[];
  selectedProjectIds: readonly string[];
}): StatsProjectScope {
  const names = new Map(projects.map((project) => [project.id as string, project.name]));
  if (!logicalProjects) {
    return { daemonId, projectIds: [...selectedProjectIds], labels: selectedProjectIds.map((id) => names.get(id) ?? id), elsewhere: [], names };
  }
  const label = (project: WorkbenchLogicalProject) => project.displayName ?? project.label;
  for (const logical of logicalProjects) {
    const local = logical.locations.filter((location) => location.target.daemonId === daemonId);
    // Several folders of one project (such as worktrees) are told apart by folder name.
    for (const location of local) {
      names.set(location.target.projectId, local.length > 1 && location.name !== label(logical)
        ? `${label(logical)} · ${location.name}` : label(logical));
    }
  }
  const projectIds: string[] = [];
  const labels: string[] = [];
  const elsewhere: string[] = [];
  for (const selectedId of selectedProjectIds) {
    const logical = logicalProjects.find((project) => project.id === selectedId);
    const local = logical?.locations.filter((location) => location.target.daemonId === daemonId) ?? [];
    const name = logical ? label(logical) : selectedId;
    (local.length ? labels : elsewhere).push(name);
    for (const location of local) {
      if (!projectIds.includes(location.target.projectId)) projectIds.push(location.target.projectId);
    }
  }
  return { daemonId, projectIds, labels, elsewhere, names };
}
