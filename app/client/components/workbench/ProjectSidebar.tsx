/*
 * Exports:
 * - default ProjectSidebar: render the home and new project links, selected project groups, reveal controls, status
 *   summaries, daemon failure, the collapsed selection icons and tooltip, and each logical project's "Folders" visibility menu.
 */
"use client";

import { useEffect, useMemo, useState, type ComponentType, type MouseEvent } from "react";

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { DaemonId, ProjectId } from "workbench-shared/workbench/identity";
import { ProjectFolderAddress } from "workbench-shared/workbench/project/project-folder-address";
import { isDaemonOwnedProject } from "workbench-shared/workbench/project/workbench-project-projection";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import {
  groupProjectSelection, nextProjectSelectionTier, type DisplaySidebarProject,
} from "./project-sidebar-groups";
import { useProjects } from "./use-projects";
import {
  workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";
import { EllipsisIcon, FolderClosedIcon, HomeIcon, ProjectIcon, type IconProps } from "./workbench-icons";
import WorkbenchDaemonStartupFailure from "./WorkbenchDaemonStartupFailure";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";
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
    // A registered folder without catalogue facts sits on a daemon this app cannot reach right now.
    ...project.locations.map(location => ({ ...location.target, hostname: location.hostname, rootPath: location.rootPath,
      checked: true, lock: visibleLock, offline: location.project === null })),
    ...(project.observedLocations ?? []).map(location => ({ ...location, checked: true,
      lock: isDaemonOwnedProject(project.matchKey) ? visibleLock : null, offline: false })),
    ...(project.hiddenLocations ?? []).map(location => ({ ...location, checked: false, lock: null, offline: false })),
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
          .map(folder => ({ id: `${folder.daemonId}/${folder.projectId}`,
            label: `${labels.get(folder) ?? folder.rootPath}${folder.offline ? " · offline" : ""}`,
            title: [folder.rootPath, folder.offline ? `${folder.hostname} is offline; this folder stays listed until it reconnects.` : null, folder.lock]
              .filter(Boolean).join("\n"),
            checked: folder.checked, disabled: folder.lock !== null })),
      })),
      onToggle: (ids, checked) => onToggle(ids.flatMap(id => targets.get(id) ?? []), !checked),
    }],
  };
}

const SUMMARY_ICON_LIMIT = 7;

/** The collapsed summary's icon strip; past the limit, the last slot counts the rest. */
function SelectedProjectIcons({ entries }: { entries: readonly DisplaySidebarProject[] }) {
  const overflow = entries.length > SUMMARY_ICON_LIMIT;
  const shown = overflow ? entries.slice(0, SUMMARY_ICON_LIMIT - 1) : entries;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {shown.map(entry => <WorkbenchProjectIcon key={entry.project.id} project={entry.project} />)}
      {overflow ? (
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[0.3rem] border border-fg/10 text-[0.6rem] font-semibold leading-none text-fg/muted">
          +{entries.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

/** A sidebar navigation option styled like the thread section's "Create new thread" row. */
function ProjectSectionLink({ href, icon: Icon, label, onClick, selected }: {
  href?: string;
  icon: ComponentType<IconProps>;
  label: string;
  onClick (event: MouseEvent<HTMLAnchorElement>): void;
  selected: boolean;
}) {
  return (
    <a
      aria-current={selected ? "page" : undefined}
      className={`
        ${workbenchOptionRowClassName} min-h-9 min-w-0 flex-1 md:min-h-8
        ${selected ? `${workbenchOptionSelectedClassName} font-semibold text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
      `}
      href={href}
      onClick={onClick}
      title={label}
    >
      <Icon className="shrink-0" size={16} />
      <span className={workbenchThreadListLabelClassName}>{label}</span>
    </a>
  );
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
  createProjectSelected,
  homeSelected,
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
  createProjectSelected: boolean;
  homeSelected: boolean;
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
  const selectedEntries = orderedEntries.filter(entry => selectedSet.has(entry.project.id));
  return (
    <section className="shrink-0 pb-3">
      <WorkbenchSidebarSectionDisclosure
        actions={preferences.projectsOpen ? null : <SelectedProjectIcons entries={selectedEntries} />}
        collapsedTooltip={(
          <div className="flex w-[min(24rem,calc(100vw-2rem))] max-w-full flex-col gap-0.5">
            {selectedEntries.map(entry => (
              <WorkbenchProjectListItem entry={entry} key={entry.project.id} presentation="preview" />
            ))}
            {selectedEntries.length ? null : (
              <p className="m-0 text-[0.8rem] text-fg/muted">{emptySelectionMessage ?? "No projects selected."}</p>
            )}
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
          <div className="mt-1 flex min-w-0 gap-1">
            <ProjectSectionLink href="/" icon={HomeIcon} label="Home" onClick={onHomeClick} selected={homeSelected} />
            <ProjectSectionLink
              href={createProjectHref}
              icon={FolderClosedIcon}
              label="New project"
              onClick={onCreateProject}
              selected={createProjectSelected}
            />
          </div>
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
