/*
 * Keywords: project, sidebar, disclosure, status, activity.
 * Exports:
 * - default ProjectSidebar: render a flush project disclosure with thread-style cards, progressive activity groups, and live cross-project status summaries. Keywords: project, sidebar, disclosure, status, activity.
 */
"use client";

import { useMemo, type MouseEvent } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { getFirstSidebarProjectGroup, groupSidebarProjects } from "./project-sidebar-groups";
import WorkbenchProjectListItem from "./WorkbenchProjectListItem";
import { ProjectIcon } from "./workbench-icons";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchThreadStatusCountsButton from "./WorkbenchThreadStatusCountsButton";
import { useWorkbenchProjectThreadSummaries } from "./use-workbench-client";

export default function ProjectSidebar({
  activeProjectId,
  onProjectLinkClick,
  projects,
}: {
  activeProjectId: string;
  onProjectLinkClick(event: MouseEvent<HTMLAnchorElement>, projectId: string): void;
  projects: readonly WorkbenchProjectOption[];
}) {
  const { preferences, setProjectTimeGroupCount } = useWorkbenchSidebarPreferences();
  const summaries = useWorkbenchProjectThreadSummaries();
  const grouped = useMemo(() => groupSidebarProjects(projects, summaries.projects), [projects, summaries.projects]);
  const entriesByProjectId = useMemo(() => new Map(
    [...grouped.alwaysVisibleProjects, ...grouped.timeGroups.flatMap(({ projects: entries }) => entries)]
      .map((entry) => [entry.project.id, entry]),
  ), [grouped]);
  const otherCounts = useMemo(() => projects.reduce(
    (counts, project) => {
      if (project.id === activeProjectId) return counts;
      const summary = entriesByProjectId.get(project.id)?.summary;
      const unpinnedCounts = summary
        ? WorkbenchThreadStatusCounts.subtractCounts(
          summary.counts,
          WorkbenchThreadStatusCounts.countPinnedStatuses(summary.pinnedThreads),
        )
        : WorkbenchThreadStatusCounts.emptyCounts;
      return WorkbenchThreadStatusCounts.addCounts(counts, unpinnedCounts);
    },
    WorkbenchThreadStatusCounts.emptyCounts,
  ), [activeProjectId, entriesByProjectId, projects]);
  const firstGroup = getFirstSidebarProjectGroup(grouped);
  const visibleProjects = grouped.alwaysVisibleProjects.length
    ? [...firstGroup, ...grouped.timeGroups.slice(0, preferences.projectTimeGroupCount).flatMap(({ projects: entries }) => entries)]
    : [...firstGroup, ...grouped.timeGroups.slice(1, preferences.projectTimeGroupCount).flatMap(({ projects: entries }) => entries)];
  const hasMoreTimeGroups = preferences.projectTimeGroupCount < grouped.timeGroups.length;
  const nowMs = Date.now();

  return (
    <section className="shrink-0 pb-5">
      <WorkbenchSidebarSectionDisclosure
        actions={<WorkbenchThreadStatusCountsButton counts={otherCounts} label="other project" scope="project" />}
        contentClassName="pb-3"
        icon={ProjectIcon}
        preferenceKey="projectsOpen"
        title="Projects"
      >
        <nav aria-label="Projects" className="flex flex-col gap-1">
          {visibleProjects.map((entry) => (
            <WorkbenchProjectListItem
              active={entry.project.id === activeProjectId}
              entry={entry}
              key={entry.project.id}
              nowMs={nowMs}
              onProjectLinkClick={onProjectLinkClick}
            />
          ))}
          {hasMoreTimeGroups ? (
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[0.78rem] font-medium text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              onClick={() => setProjectTimeGroupCount(preferences.projectTimeGroupCount + 1)}
              type="button"
            >
              Show {grouped.timeGroups[preferences.projectTimeGroupCount]?.label ?? "older projects"}
            </button>
          ) : null}
          {!projects.length ? <p className="m-0 px-2 text-[0.8rem] leading-5 text-muted">No projects were found.</p> : null}
        </nav>
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
