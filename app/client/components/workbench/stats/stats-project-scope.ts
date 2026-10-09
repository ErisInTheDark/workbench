/*
 * Exports:
 * - StatsProjectGroup: one selected project, with the references that read it on every machine.
 * - StatsProjectScope: the sidebar selection as workspace project references, with names and logical owners for stats rows.
 * - statsLocationKey: the key one daemon's physical project carries in the scope's maps.
 * - resolveStatsProjectScope: map selected logical or physical projects onto references stats read across every machine.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { WorkspaceProjectReference } from "workbench-shared/workbench/workspace/workspace-observation";

export interface StatsProjectGroup {
  /** The selected sidebar id: a logical project id, or a physical one when the sidebar shows physical projects. */
  id: string;
  label: string;
  /** For icons; null when the sidebar knows no project for the id. */
  project: WorkbenchLogicalProject | WorkbenchProjectOption | null;
  references: WorkspaceProjectReference[];
}

export interface StatsProjectScope {
  /** The daemon this app is attached to; its files and threads open locally. */
  attachedDaemonId: string | null;
  /** References for the whole selection; empty when nothing is selected. */
  references: WorkspaceProjectReference[];
  /** One label per selected project. */
  labels: string[];
  groups: StatsProjectGroup[];
  /** Display names by logical id, by `statsLocationKey`, and by a physical id on the attached daemon. */
  names: ReadonlyMap<string, string>;
  /** Logical project owning each `statsLocationKey`. */
  logical: ReadonlyMap<string, string>;
}

export function statsLocationKey(daemonId: string | null, projectId: string) {
  return `${daemonId ?? ""}/${projectId}`;
}

function locationReference(daemonId: string, projectId: string): WorkspaceProjectReference | null {
  const daemon = DaemonIdSchema.safeParse(daemonId).data;
  const project = ProjectIdSchema.safeParse(projectId).data;
  return daemon && project ? { kind: "location", location: { daemonId: daemon, projectId: project } } : null;
}

export function resolveStatsProjectScope({ attachedDaemonId, logicalProjects, projects, selectedProjectIds }: {
  attachedDaemonId: string | null;
  /** Undefined when the sidebar shows physical projects directly. */
  logicalProjects: readonly WorkbenchLogicalProject[] | undefined;
  /** The attached daemon's catalogue. */
  projects: readonly WorkbenchProjectOption[];
  selectedProjectIds: readonly string[];
}): StatsProjectScope {
  const names = new Map(projects.map((project) => [project.id as string, project.name]));
  const logical = new Map<string, string>();
  if (!logicalProjects) {
    const groups = selectedProjectIds.flatMap((id) => {
      const reference = attachedDaemonId ? locationReference(attachedDaemonId, id) : null;
      return reference ? [{ id, label: names.get(id) ?? id, project: projects.find((project) => project.id === id) ?? null, references: [reference] }] : [];
    });
    for (const project of projects) names.set(statsLocationKey(attachedDaemonId, project.id), project.name);
    return {
      attachedDaemonId, groups, labels: groups.map(({ label }) => label), logical, names,
      references: groups.flatMap(({ references }) => references),
    };
  }
  const label = (project: WorkbenchLogicalProject) => project.displayName ?? project.label;
  for (const project of logicalProjects) {
    names.set(project.id, label(project));
    const locations = [
      ...project.locations.map(({ daemonId, name, target }) => ({ daemonId: daemonId as string, name, projectId: target.projectId as string })),
      ...(project.observedLocations ?? []).map(({ daemonId, project: physical, projectId }) => ({ daemonId: daemonId as string, name: physical.name, projectId: projectId as string })),
    ];
    for (const location of locations) {
      const key = statsLocationKey(location.daemonId, location.projectId);
      logical.set(key, project.id);
      // Several folders of one project (such as worktrees) on one machine are told apart by folder name.
      const siblings = locations.filter(({ daemonId }) => daemonId === location.daemonId).length;
      const name = siblings > 1 && location.name !== label(project) ? `${label(project)} · ${location.name}` : label(project);
      names.set(key, name);
      if (location.daemonId === attachedDaemonId) names.set(location.projectId, name);
    }
  }
  const groups: StatsProjectGroup[] = selectedProjectIds.flatMap((selectedId) => {
    const project = logicalProjects.find((candidate) => candidate.id === selectedId);
    const id = LogicalProjectIdSchema.safeParse(selectedId).data;
    return project && id ? [{ id: selectedId, label: label(project), project, references: [{ kind: "logical" as const, projectId: id }] }] : [];
  });
  return {
    attachedDaemonId, groups, labels: groups.map(({ label: name }) => name), logical, names,
    references: groups.flatMap(({ references }) => references),
  };
}
