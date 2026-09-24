/*
 * Exports:
 * - ProjectSidebarProject/LogicalSidebarProject/DisplaySidebarProject/DisplaySidebarGroups: concrete, identity-level and combined display inputs.
 * - groupSidebarProjects/groupLogicalSidebarProjects/getFirstSidebarProjectGroup: preserve recency groups across both project views.
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

export interface ProjectSidebarTimeGroup<P = WorkbenchProjectOption, S = WorkbenchProjectThreadSummary> {
  label: ProjectRecencyLabel;
  projects: ProjectSidebarProject<P, S>[];
}

export interface GroupedSidebarProjects<P = WorkbenchProjectOption, S = WorkbenchProjectThreadSummary> {
  alwaysVisibleProjects: ProjectSidebarProject<P, S>[];
  timeGroups: ProjectSidebarTimeGroup<P, S>[];
}

const PROJECT_RECENCY_DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_RECENCY_BUCKETS = [
  { label: "last week", maxAgeMs: 7 * PROJECT_RECENCY_DAY_MS },
  { label: "last month", maxAgeMs: 31 * PROJECT_RECENCY_DAY_MS },
  { label: "last 3 months", maxAgeMs: 93 * PROJECT_RECENCY_DAY_MS },
  { label: "last 6 months", maxAgeMs: 186 * PROJECT_RECENCY_DAY_MS },
  { label: "last year", maxAgeMs: 366 * PROJECT_RECENCY_DAY_MS },
  { label: "ever", maxAgeMs: Number.POSITIVE_INFINITY },
] as const;
type ProjectRecencyLabel = (typeof PROJECT_RECENCY_BUCKETS)[number]["label"];

function getProjectRecencyLabel(activityAt: number | null, nowMs: number): ProjectRecencyLabel {
  if (activityAt === null) return "ever";
  const ageMs = Math.max(0, nowMs - activityAt);
  return PROJECT_RECENCY_BUCKETS.find((bucket) => ageMs <= bucket.maxAgeMs)?.label ?? "ever";
}

function compareSidebarProjects<P extends { id: string }, S>(
  left: ProjectSidebarProject<P, S>,
  right: ProjectSidebarProject<P, S>,
  catalogOrder: ReadonlyMap<string, number>,
) {
  return (right.activityAt ?? Number.NEGATIVE_INFINITY) - (left.activityAt ?? Number.NEGATIVE_INFINITY)
    || (catalogOrder.get(left.project.id) ?? 0) - (catalogOrder.get(right.project.id) ?? 0);
}

function groupEntries<P extends { id: string }, S extends { unsettledThreads: readonly object[] }>(
  entries: ProjectSidebarProject<P, S>[],
  isLibrary: (project: P) => boolean,
  nowMs: number,
): GroupedSidebarProjects<P, S> {
  const catalogOrder = new Map(entries.map((entry, index) => [entry.project.id, index]));
  const alwaysVisibleProjects = entries
    .filter(({ project, summary }) => (
      isLibrary(project)
      || Boolean(summary?.unsettledThreads.length)
    ))
    .sort((left, right) => (
      Number(isLibrary(right.project)) - Number(isLibrary(left.project))
      || compareSidebarProjects(left, right, catalogOrder)
    ));
  const alwaysVisibleProjectIds = new Set(alwaysVisibleProjects.map(({ project }) => project.id));
  const timeGroupsByLabel = new Map<ProjectRecencyLabel, ProjectSidebarTimeGroup<P, S>>();

  for (const entry of entries) {
    if (alwaysVisibleProjectIds.has(entry.project.id)) continue;
    const label = getProjectRecencyLabel(entry.activityAt, nowMs);
    const group = timeGroupsByLabel.get(label);
    if (group) group.projects.push(entry);
    else timeGroupsByLabel.set(label, { label, projects: [entry] });
  }

  return {
    alwaysVisibleProjects,
    timeGroups: PROJECT_RECENCY_BUCKETS
      .map(({ label }) => timeGroupsByLabel.get(label))
      .filter((group): group is ProjectSidebarTimeGroup<P, S> => Boolean(group))
      .map((group) => ({
        ...group,
        projects: group.projects.sort((left, right) => compareSidebarProjects(left, right, catalogOrder)),
      })),
  };
}
export type DisplaySidebarGroups = GroupedSidebarProjects<
  WorkbenchProjectOption | WorkbenchLogicalProject,
  WorkbenchProjectThreadSummary | WorkbenchLogicalProjectSummary
>;

export function groupSidebarProjects(
  projects: readonly WorkbenchProjectOption[],
  summaries: readonly WorkbenchProjectThreadSummary[] = [],
  nowMs = Date.now(),
): GroupedSidebarProjects {
  const byId = new Map(summaries.map(summary => [summary.projectId, summary]));
  return groupEntries(projects.map(project => {
    const summary = byId.get(project.id) ?? null;
    return { project, summary, activityAt: summary?.lastThreadUpdateAt ?? project.lastCommitTimeMs };
  }), project => project.kind === "workbench-library", nowMs);
}

export function groupLogicalSidebarProjects(
  projects: readonly WorkbenchLogicalProject[],
  summaries: Readonly<Record<string, WorkbenchLogicalProjectSummary>>,
  nowMs = Date.now(),
): GroupedSidebarProjects<WorkbenchLogicalProject, WorkbenchLogicalProjectSummary> {
  return groupEntries(projects.map(project => {
    const summary = summaries[project.id] ?? null;
    return { project, summary, activityAt: summary?.lastThreadUpdateAt ?? null };
  }), () => false, nowMs);
}

export function getFirstSidebarProjectGroup<P, S>(grouped: GroupedSidebarProjects<P, S>) {
  return grouped.alwaysVisibleProjects.length
    ? grouped.alwaysVisibleProjects
    : grouped.timeGroups[0]?.projects ?? [];
}
