/*
 * Exports:
 * - default ProjectSidebar: render project groups, status summaries, and Git-root setup access.
 */
"use client";

import { useMemo, type MouseEvent } from "react";

import type { WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchProjectOption } from "workbench-shared/types";
import { getFirstSidebarProjectGroup, groupLogicalSidebarProjects, groupSidebarProjects, type DisplaySidebarGroups } from "./project-sidebar-groups";
import { useWorkbenchProjectThreadSummaries } from "./use-workbench-client";
import { ProjectIcon } from "./workbench-icons";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchProjectListItem from "./WorkbenchProjectListItem";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchThreadStatusCountsButton from "./WorkbenchThreadStatusCountsButton";

export default function ProjectSidebar ({
  activeProjectId,
  logicalProjects,
  logicalSummaries,
  onConfigureGitRoots,
  onProjectLinkClick,
  projects,
  showGitRootsSetup,
}: {
  activeProjectId: string;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  logicalSummaries?: Readonly<Record<string, WorkbenchLogicalProjectSummary>>;
  onConfigureGitRoots: () => void;
  onProjectLinkClick (event: MouseEvent<HTMLAnchorElement>, projectId: string, logical?: boolean): void;
  projects: readonly WorkbenchProjectOption[];
  showGitRootsSetup: boolean;
}) {
  const { preferences, setProjectTimeGroupCount } = useWorkbenchSidebarPreferences();
  const summaries = useWorkbenchProjectThreadSummaries();
  const displayedProjects = logicalProjects ?? projects;
  const grouped = useMemo<DisplaySidebarGroups>(() => logicalProjects
    ? groupLogicalSidebarProjects(logicalProjects, logicalSummaries ?? {})
    : groupSidebarProjects(projects, summaries.projects),
    [logicalProjects, logicalSummaries, projects, summaries.projects]);
  const entriesByProjectId = useMemo(() => new Map(
    [...grouped.alwaysVisibleProjects, ...grouped.timeGroups.flatMap(({ projects: entries }) => entries)]
      .map((entry) => [entry.project.id, entry]),
  ), [grouped]);
  const otherCounts = useMemo(() => displayedProjects.reduce(
    (counts, project) => {
      if (project.id === activeProjectId) return counts;
      const summary = entriesByProjectId.get(project.id)?.summary;
      const unpinnedCounts = summary
        ? WorkbenchThreadStatusCounts.subtractCounts(summary.counts,
          WorkbenchThreadStatusCounts.countPinnedStatuses(
            logicalProjects ? (summary as WorkbenchLogicalProjectSummary).pinnedThreads.map(item => item.entry)
              : (summary as typeof summaries.projects[number]).pinnedThreads,
          ))
        : WorkbenchThreadStatusCounts.emptyCounts;
      return WorkbenchThreadStatusCounts.addCounts(counts, unpinnedCounts);
    },
    WorkbenchThreadStatusCounts.emptyCounts,
  ), [activeProjectId, displayedProjects, entriesByProjectId, logicalProjects, summaries.projects]);
  const firstGroup = getFirstSidebarProjectGroup(grouped);
  const visibleProjects = grouped.alwaysVisibleProjects.length
    ? [...firstGroup, ...grouped.timeGroups.slice(0, preferences.projectTimeGroupCount).flatMap(({ projects: entries }) => entries)]
    : [...firstGroup, ...grouped.timeGroups.slice(1, preferences.projectTimeGroupCount).flatMap(({ projects: entries }) => entries)];
  const hasMoreTimeGroups = preferences.projectTimeGroupCount < grouped.timeGroups.length;
  const nowMs = Date.now();

  return (
    <section className="shrink-0 pb-3">
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
          {showGitRootsSetup ? (
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[0.78rem] font-medium text-accent transition hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
              onClick={onConfigureGitRoots}
              type="button"
            >
              Set Git roots
            </button>
          ) : null}
          {hasMoreTimeGroups ? (
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[0.78rem] font-medium text-fg/muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              onClick={() => setProjectTimeGroupCount(preferences.projectTimeGroupCount + 1)}
              type="button"
            >
              Show {grouped.timeGroups[preferences.projectTimeGroupCount]?.label ?? "older projects"}
            </button>
          ) : null}
          {!displayedProjects.length ? <p className="m-0 px-2 text-[0.8rem] leading-5 text-fg/muted">No projects were found.</p> : null}
        </nav>
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
