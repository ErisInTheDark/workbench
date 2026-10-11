/*
 * Exports:
 * - default ProjectSidebar: render selected project groups, reveal controls, status summaries, daemon failure, the new
 *   project action and each logical project's "Folders" visibility menu.
 */
"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { DaemonId, ProjectId } from "workbench-shared/workbench/identity";
import { ProjectFolderAddress } from "workbench-shared/workbench/project/project-folder-address";
import { isDaemonOwnedProject } from "workbench-shared/workbench/project/workbench-project-projection";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import {
  groupProjectSelection, nextProjectSelectionTier, type DisplaySidebarProject,
} from "./project-sidebar-groups";
import { useProjects } from "./use-projects";
import { workbenchNewEntryButtonClassName } from "./workbench-class-names";
import { NewEntryIcon } from "./workbench-explorer";
import { EllipsisIcon, HomeIcon, ProjectIcon } from "./workbench-icons";
import WorkbenchDaemonStartupFailure from "./WorkbenchDaemonStartupFailure";
import IconButton from "../ui/IconButton";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchProjectListItem from "./WorkbenchProjectListItem";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchThreadStatusCountsButton from "./WorkbenchThreadStatusCountsButton";
import { useWorkbenchClientController } from "./workbench-client-context";

type FolderTarget = { daemonId: DaemonId; projectId: ProjectId };

/**
 * A logical project's "Folders" menu: every visible, observed and hidden folder grouped by host. Matching the presentation
 * repository's guards, the last visible registered folder and a daemon-owned project's visible folders are locked (with
 * the reason on hover). Daemon projects get a disabled note.
 */
function projectFolderMenu(
  project: WorkbenchLogicalProject,
  onToggle: (targets: FolderTarget[], hidden: boolean) => void,
): WorkbenchContextMenuDefinition {
  const id = `project-folders:${project.id}`;
  const label = `${project.label} actions`;
  if (project.matchKey.startsWith("daemon://")) {
    return { id, label, items: [{ id: "folders", label: "Daemon projects have no other folders", disabled: true, onSelect: () => {} }] };
  }
  const visibleLock = isDaemonOwnedProject(project.matchKey) ? "Each daemon's own Workbench folder always stays visible."
    : project.locations.length <= 1 ? "A project must keep at least one visible folder." : null;
  const folders = [
    ...project.locations.map(location => ({ ...location.target, hostname: location.hostname, rootPath: location.rootPath,
      checked: true, lock: visibleLock })),
    ...(project.observedLocations ?? []).map(location => ({ ...location, checked: true,
      lock: isDaemonOwnedProject(project.matchKey) ? visibleLock : null })),
    ...(project.hiddenLocations ?? []).map(location => ({ ...location, checked: false, lock: null })),
  ];
  const targets = new Map(folders.map(folder => [`${folder.daemonId}/${folder.projectId}`,
    { daemonId: folder.daemonId, projectId: folder.projectId }]));
  const labels = new Map(ProjectFolderAddress.suffixes(folders.map(folder =>
    ({ target: { daemonId: folder.daemonId, projectId: folder.projectId }, rootPath: folder.rootPath })))
    .map((suffix, index) => [folders[index]!, suffix.join("/")]));
  const hosts = [...new Set(folders.map(folder => folder.hostname))].sort((left, right) => left.localeCompare(right));
  return {
    id, label,
    items: [{
      id: "folders", kind: "checklist-tree", label: "Folders",
      groups: hosts.map(hostname => ({
        id: hostname, label: hostname,
        items: folders.filter(folder => folder.hostname === hostname)
          .sort((left, right) => left.rootPath.localeCompare(right.rootPath))
          .map(folder => ({ id: `${folder.daemonId}/${folder.projectId}`, label: labels.get(folder) ?? folder.rootPath,
            title: folder.lock ? `${folder.rootPath}\n${folder.lock}` : folder.rootPath,
            checked: folder.checked, disabled: folder.lock !== null })),
      })),
      onToggle: (ids, checked) => onToggle(ids.flatMap(id => targets.get(id) ?? []), !checked),
    }],
  };
}

export default function ProjectSidebar ({
  activeProjectId,
  selectedProjectIds,
  orderedProjectIds,
  unsettledProjectIds,
  unarchivedProjectIds,
  emptySelectionMessage,
  logicalProjects,
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
  logicalError?: string | null;
  logicalLoading?: boolean;
  createProjectHref?: string;
  onCreateProject (event: MouseEvent<HTMLAnchorElement>): void;
  onHomeClick (event: MouseEvent<HTMLAnchorElement>): void;
  onProjectLinkClick (event: MouseEvent<HTMLAnchorElement>, projectId: string, logical?: boolean): void;
  projects: readonly WorkbenchProjectOption[];
}) {
  const { preferences } = useWorkbenchSidebarPreferences();
  const client = useWorkbenchClientController();
  const folders = useProjects.folders();
  const presentation = client.mounted?.presentationClient ?? null;
  const [folderError, setFolderError] = useState<string | null>(null);
  const folderMenus = useMemo(() => new Map<string, WorkbenchContextMenuDefinition>((logicalProjects ?? []).map(project =>
    [project.id, projectFolderMenu(project, (targets, hidden) => {
      setFolderError(null);
      void presentation?.setLocationsHidden(project.id, targets, hidden).catch((error: unknown) => {
        setFolderError(error instanceof Error ? error.message : "Unable to change this project's folders.");
      });
    })] as const)), [logicalProjects, presentation]);
  const summaries = useProjects.threads();
  const logicalSummaries = useProjects.summaries();
  const displayedProjects = logicalProjects ?? projects;
  const entriesByProjectId = useMemo(() => new Map<string, DisplaySidebarProject>(displayedProjects.map(project => {
    const summary = logicalProjects
      ? logicalSummaries[project.id] ?? null
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
            <IconButton
              as="a"
              href="/"
              label="Home"
              title="Home"
              display="hover-border"
              size="small"
              onClick={onHomeClick}
            >
              <HomeIcon size={16} />
            </IconButton>
            <IconButton
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
            </IconButton>
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
              contextMenu={folderMenus.get(entry.project.id) ?? null}
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
          {folderError ? <p role="alert" className="m-0 px-2 text-[0.8rem] leading-5 text-danger">{folderError}</p> : null}
          {logicalError ? <p role="alert" className="m-0 px-2 text-[0.8rem] leading-5 text-danger">{logicalError}</p> : null}
          {!displayedProjects.length ? <WorkbenchDaemonStartupFailure className="px-2" /> : null}
          {!displayedProjects.length && !logicalError ? <p className="m-0 px-2 text-[0.8rem] leading-5 text-fg/muted">
            {logicalLoading || !folders || folders.catalogues.some(item => item.phase === "pending")
              ? "Loading projects..." : "No projects were found."}
          </p> : null}
        </nav>
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
