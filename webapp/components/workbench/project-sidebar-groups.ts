/*
 * Exports:
 * - ProjectSidebarProject/ProjectSidebarTimeGroup/GroupedSidebarProjects: flat project-sidebar visibility and progressive recency contracts. Keywords: project, sidebar, recency, activity.
 * - groupSidebarProjects: promote libraries and unsnoozed unsettled work, then bucket remaining projects by effective thread or commit activity. Keywords: project, sidebar, grouping, time, status.
 */

import type { WorkbenchProjectOption } from "../../lib/types";
import type { WorkbenchProjectThreadSummary } from "../../lib/workbench/thread/thread-state";

export interface ProjectSidebarProject {
  activityAt: number | null;
  project: WorkbenchProjectOption;
  summary: WorkbenchProjectThreadSummary | null;
}

export interface ProjectSidebarTimeGroup {
  label: ProjectRecencyLabel;
  projects: ProjectSidebarProject[];
}

export interface GroupedSidebarProjects {
  alwaysVisibleProjects: ProjectSidebarProject[];
  timeGroups: ProjectSidebarTimeGroup[];
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

function compareSidebarProjects(
  left: ProjectSidebarProject,
  right: ProjectSidebarProject,
  catalogOrder: ReadonlyMap<string, number>,
) {
  return (right.activityAt ?? Number.NEGATIVE_INFINITY) - (left.activityAt ?? Number.NEGATIVE_INFINITY)
    || (catalogOrder.get(left.project.id) ?? 0) - (catalogOrder.get(right.project.id) ?? 0);
}

export function groupSidebarProjects(
  projects: readonly WorkbenchProjectOption[],
  summaries: readonly WorkbenchProjectThreadSummary[] = [],
  nowMs = Date.now(),
): GroupedSidebarProjects {
  const summariesByProjectId = new Map(summaries.map((summary) => [summary.projectId, summary]));
  const catalogOrder = new Map(projects.map((project, index) => [project.id, index]));
  const entries = projects.map((project): ProjectSidebarProject => {
    const summary = summariesByProjectId.get(project.id) ?? null;
    return {
      activityAt: summary?.lastThreadUpdateAt ?? project.lastCommitTimeMs,
      project,
      summary,
    };
  });
  const alwaysVisibleProjects = entries
    .filter(({ project, summary }) => (
      project.kind === "workbench-library"
      || Boolean(summary?.unsettledThreads.length)
    ))
    .sort((left, right) => (
      Number(right.project.kind === "workbench-library") - Number(left.project.kind === "workbench-library")
      || compareSidebarProjects(left, right, catalogOrder)
    ));
  const alwaysVisibleProjectIds = new Set(alwaysVisibleProjects.map(({ project }) => project.id));
  const timeGroupsByLabel = new Map<ProjectRecencyLabel, ProjectSidebarTimeGroup>();

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
      .filter((group): group is ProjectSidebarTimeGroup => Boolean(group))
      .map((group) => ({
        ...group,
        projects: group.projects.sort((left, right) => compareSidebarProjects(left, right, catalogOrder)),
      })),
  };
}
