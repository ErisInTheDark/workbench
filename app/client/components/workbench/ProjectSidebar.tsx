/*
 * Exports:
 * - default ProjectSidebar: render selected project groups, reveal controls, status summaries, daemon failure, and the new project action.
 */
"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";

import type { WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchProjectOption } from "workbench-shared/types";
import {
  groupProjectSelection, nextProjectSelectionTier, type DisplaySidebarProject,
} from "./project-sidebar-groups";
import { useWorkbenchProjectThreadSummaries } from "./use-workbench-client";
import { workbenchNewEntryButtonClassName } from "./workbench-class-names";
import { NewEntryIcon } from "./workbench-explorer";
import { EllipsisIcon, HomeIcon, ProjectIcon } from "./workbench-icons";
import WorkbenchDaemonStartupFailure from "./WorkbenchDaemonStartupFailure";
import WorkbenchIconButton from "./WorkbenchIconButton";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchProjectListItem from "./WorkbenchProjectListItem";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchThreadStatusCountsButton from "./WorkbenchThreadStatusCountsButton";
import { useWorkbenchClientController } from "./workbench-client-context";

export default function ProjectSidebar ({
  activeProjectId,
  selectedProjectIds,
  orderedProjectIds,
  unsettledProjectIds,
  unarchivedProjectIds,
  emptySelectionMessage,
  logicalProjects,
  logicalSummaries,
  logicalError,
  logicalLoading,
  createProjectHref,
  onCreateProject,
  onHomeClick,
  onProjectLinkClick,
  projects,
}: {
  activeProjectId: string;
  selectedProjectIds: readonly string[];
  orderedProjectIds: readonly string[];
  unsettledProjectIds: ReadonlySet<string>;
  unarchivedProjectIds: ReadonlySet<string>;
  emptySelectionMessage?: string;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  logicalSummaries?: Readonly<Record<string, WorkbenchLogicalProjectSummary>>;
  logicalError?: string | null;
  logicalLoading?: boolean;
  createProjectHref?: string;
  onCreateProject (event: MouseEvent<HTMLAnchorElement>): void;
  onHomeClick (event: MouseEvent<HTMLAnchorElement>): void;
  onProjectLinkClick (event: MouseEvent<HTMLAnchorElement>, projectId: string, logical?: boolean): void;
  projects: readonly WorkbenchProjectOption[];
}) {
  const { preferences } = useWorkbenchSidebarPreferences();
  const workspace = useWorkbenchClientController().explorer.workspaceProjects;
  const summaries = useWorkbenchProjectThreadSummaries();
  const displayedProjects = logicalProjects ?? projects;
  const entriesByProjectId = useMemo(() => new Map<string, DisplaySidebarProject>(displayedProjects.map(project => {
    const summary = logicalProjects
      ? logicalSummaries?.[project.id] ?? null
      : summaries.projects.find(item => item.projectId === project.id) ?? null;
    return [project.id, { project, summary,
      activityAt: summary?.lastThreadUpdateAt ?? ("lastCommitTimeMs" in project ? project.lastCommitTimeMs : null) }];
  })), [displayedProjects, logicalProjects, logicalSummaries, summaries.projects]);
  const orderedEntries = useMemo(() => {
    const ids = [...orderedProjectIds, ...displayedProjects.map(project => project.id)];
    return [...new Set(ids)].flatMap(id => entriesByProjectId.get(id) ? [entriesByProjectId.get(id)!] : []);
  }, [displayedProjects, entriesByProjectId, orderedProjectIds]);
  const [openingSelection, setOpeningSelection] = useState(() => ({
    ids: selectedProjectIds,
    ready: displayedProjects.length > 0,
  }));
  const [revealedTier, setRevealedTier] = useState(0);
  useEffect(() => {
    if (preferences.projectsOpen && !openingSelection.ready && displayedProjects.length) {
      setOpeningSelection({ ids: selectedProjectIds, ready: true });
    }
  }, [displayedProjects.length, openingSelection.ready, preferences.projectsOpen, selectedProjectIds]);
  const projectSelectionGroups = useMemo(() => groupProjectSelection(
    orderedEntries, openingSelection.ids, unsettledProjectIds, unarchivedProjectIds,
  ), [openingSelection.ids, orderedEntries, unsettledProjectIds, unarchivedProjectIds]);
  const selectedSet = useMemo(() => new Set(selectedProjectIds), [selectedProjectIds]);
  const otherCounts = useMemo(() => displayedProjects.reduce(
    (counts, project) => {
      if (selectedSet.has(project.id)) return counts;
      const summary = entriesByProjectId.get(project.id)?.summary;
      return WorkbenchThreadStatusCounts.addCounts(counts,
        summary?.counts ?? WorkbenchThreadStatusCounts.emptyCounts);
    },
    WorkbenchThreadStatusCounts.emptyCounts,
  ), [displayedProjects, entriesByProjectId, selectedSet]);
  const visibleProjects = [
    ...projectSelectionGroups.selected,
    ...(revealedTier >= 1 ? projectSelectionGroups.unsettled : []),
    ...(revealedTier >= 2 ? projectSelectionGroups.unarchived : []),
    ...(revealedTier >= 3 ? projectSelectionGroups.all : []),
  ];
  const nextTier = nextProjectSelectionTier(revealedTier, projectSelectionGroups);
  const nextLabel = nextTier === 1 ? "show unsettled" : nextTier === 2 ? "show unarchived" : "show all projects";
  return (
    <section className="shrink-0 pb-3">
      <WorkbenchSidebarSectionDisclosure
        actions={(
          <div className="flex items-center gap-1">
            {preferences.projectsOpen ? null
              : <WorkbenchThreadStatusCountsButton counts={otherCounts} label="unselected project" scope="project" />}
            <WorkbenchIconButton
              as="a"
              href="/"
              label="Home"
              title="Home"
              display="hover-border"
              size="small"
              onClick={onHomeClick}
            >
              <HomeIcon size={16} />
            </WorkbenchIconButton>
            <WorkbenchIconButton
              as="a"
              href={createProjectHref}
              label="New project"
              title="New project"
              display="hover-border"
              size="small"
              className={workbenchNewEntryButtonClassName}
              onClick={onCreateProject}
            >
              <NewEntryIcon size={16} />
              <span className="sr-only">New project</span>
            </WorkbenchIconButton>
          </div>
        )}
        icon={ProjectIcon}
        preferenceKey="projectsOpen"
        onOpenChange={(open) => {
          setRevealedTier(0);
          if (open) setOpeningSelection({ ids: selectedProjectIds, ready: displayedProjects.length > 0 });
        }}
        title="Projects"
      >
        <nav aria-label="Projects" className="flex flex-col gap-1">
          {visibleProjects.map((entry) => (
            <WorkbenchProjectListItem
              active={entry.project.id === activeProjectId}
              entry={entry}
              key={entry.project.id}
              onProjectLinkClick={onProjectLinkClick}
              selected={selectedSet.has(entry.project.id)}
            />
          ))}
          {emptySelectionMessage ? <p className="m-0 px-2 py-1 text-[0.8rem] text-fg/muted">{emptySelectionMessage}</p> : null}
          {nextTier !== null ? (
            <div className="flex min-w-0 items-center">
              <button
                className="group/reveal flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-2 py-1 text-left text-[0.78rem] text-fg/muted/70 transition hover:text-fg/muted focus-visible:text-fg/muted focus-visible:outline-none md:min-h-8"
                onClick={() => setRevealedTier(nextTier)}
                type="button"
                aria-label={nextLabel}
              >
                <EllipsisIcon className="mr-1.5 shrink-0" size={16} />
                <span className="hidden group-hover/reveal:inline group-focus-visible/reveal:inline">{nextLabel}</span>
              </button>
              {nextTier === 1 ? <WorkbenchThreadStatusCountsButton
                counts={otherCounts}
                label="unselected project"
                scope="project"
              /> : null}
            </div>
          ) : null}
          {logicalError ? <p role="alert" className="m-0 px-2 text-[0.8rem] leading-5 text-danger">{logicalError}</p> : null}
          {!displayedProjects.length ? <WorkbenchDaemonStartupFailure className="px-2" /> : null}
          {!displayedProjects.length && !logicalError ? <p className="m-0 px-2 text-[0.8rem] leading-5 text-fg/muted">
            {logicalLoading || !workspace || workspace.catalogues.some(item => item.phase === "pending")
              ? "Loading projects..." : "No projects were found."}
          </p> : null}
        </nav>
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
