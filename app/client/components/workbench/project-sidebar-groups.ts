/*
 * Exports:
 * - ProjectSidebarProject/LogicalSidebarProject/DisplaySidebarProject: project row inputs.
 * - resolveSelectedProjectIds/groupProjectSelection: display app-owned project pools around URL selection.
 */

import type { WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkbenchProjectThreadSummary } from "workbench-shared/workbench/thread/thread-state";

export interface ProjectSidebarProject<P = WorkbenchProjectOption, S = WorkbenchProjectThreadSummary> {
  activityAt: number | null;
  project: P;
  summary: S | null;
}

export type LogicalSidebarProject = ProjectSidebarProject<WorkbenchLogicalProject, WorkbenchLogicalProjectSummary>;
export type DisplaySidebarProject = ProjectSidebarProject<
  WorkbenchProjectOption | WorkbenchLogicalProject,
  WorkbenchProjectThreadSummary | WorkbenchLogicalProjectSummary
>;

export function resolveSelectedProjectIds(
  projectIds: readonly string[],
  selectedProjectIds: readonly string[] | null,
  unarchivedProjectIds: ReadonlySet<string>,
) {
  const available = new Set(projectIds);
  return selectedProjectIds === null
    ? projectIds.filter(id => unarchivedProjectIds.has(id))
    : [...new Set(selectedProjectIds)].filter(id => available.has(id));
}

export function groupProjectSelection<P extends { id: string }, S>(
  entries: readonly ProjectSidebarProject<P, S>[],
  selectedProjectIds: readonly string[],
  unsettledProjectIds: ReadonlySet<string>,
  unarchivedProjectIds: ReadonlySet<string>,
) {
  const byId = new Map(entries.map(entry => [entry.project.id, entry]));
  const selected = selectedProjectIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : []);
  const selectedSet = new Set(selectedProjectIds);
  const remaining = entries.filter(entry => !selectedSet.has(entry.project.id));
  const unsettled = remaining.filter(entry => unsettledProjectIds.has(entry.project.id));
  const unarchived = remaining.filter(entry =>
    !unsettledProjectIds.has(entry.project.id) && unarchivedProjectIds.has(entry.project.id));
  const all = remaining.filter(entry =>
    !unsettledProjectIds.has(entry.project.id) && !unarchivedProjectIds.has(entry.project.id));
  return { selected, unsettled, unarchived, all };
}
