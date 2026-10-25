/*
 * Exports:
 * - default WorkbenchSidebarPane: the workbench sidebar: a fixed header, a status-counts footer, and between them (and
 *   fading under both) the threads, git, explorer or reload panel. On desktop the active tab brings its panel forward.
 */
"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

import type { WorkbenchLogicalThreadRow } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import {
  createNewProjectRoute, createSettingsRoute, createStatsRoute, createToggledProjectSelectionRoute, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type WorkbenchBrowseSessionController from "../../workbench/browse/WorkbenchBrowseSessionController";
import useMediaQuery from "../../workbench/dom/layout/use-media-query";
import { useWorkbenchNavigate, useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import { MOBILE_MEDIA_QUERY } from "../../workbench/state/mobile-pane-url-state";
import IconButton from "../ui/IconButton";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import { useWorkbenchExplorer } from "./explorer/workbench-explorer-context";
import WorkbenchExplorerSection from "./explorer/WorkbenchExplorerSection";
import WorkbenchGitSidebar from "./git/WorkbenchGitSidebar";
import ProjectSidebar from "./ProjectSidebar";
import WorkbenchReloadPanel from "./reload/WorkbenchReloadPanel";
import { useWorkbenchSearch } from "./search/workbench-search-context";
import { sidebarPanelForRoute, type WorkbenchSidebarPanel } from "./sidebar/sidebar-panel";
import WorkbenchSidebarFooter from "./sidebar/WorkbenchSidebarFooter";
import { useProjects } from "./use-projects";
import WorkbenchBrowseSessionsSection from "./WorkbenchBrowseSessionsSection";
import { useWorkbenchClientController } from "./workbench-client-context";
import WorkbenchConnectionSpinner from "./WorkbenchConnectionSpinner";
import WorkbenchFolderSidebar from "./WorkbenchFolderSidebar";
import { DraftThreadIcon, GearIcon, SearchIcon, StatsIcon } from "./workbench-icons";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadSidebar from "./WorkbenchThreadSidebar";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

type ThreadSidebarProps = ComponentProps<typeof WorkbenchThreadSidebar>;
type ActionsProps = ComponentProps<typeof WorkbenchThreadSidebarActionsProvider>;
type ReloadPanelProps = ComponentProps<typeof WorkbenchReloadPanel>;

/** Desktop tabs pick the panel once per tab change, so a footer pick stays until the next tab. Mobile never follows tabs. */
function useTabPanel(route: WorkbenchRoute, setPanel: (panel: WorkbenchSidebarPanel) => void) {
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const panel = sidebarPanelForRoute(route);
  const tab = `${route.view}\0${route.filePath}\0${route.view === "thread" ? JSON.stringify(route.threadTarget) : ""}`;
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (mobile || followed.current === tab) return;
    followed.current = tab;
    if (panel) setPanel(panel);
  }, [mobile, panel, setPanel, tab]);
}

export default function WorkbenchSidebarPane({
  activeProjectId, appRuntime, askAgentWithReferences,
  browseSessionController, collapsed, createThread, currentFilePath,
  onFileDeleted, onOpenQualifiedThread, onOpenThread,
  onPresentationDraftDeleted, onThreadSettled, projectSourceError,
  renderThreadTooltipDetails, route,
  viewedProjectId,
}: {
  activeProjectId: ActionsProps["projectId"];
  appRuntime: ReloadPanelProps["appRuntime"];
  askAgentWithReferences: ReloadPanelProps["onAskAgent"];
  browseSessionController: WorkbenchBrowseSessionController;
  collapsed: boolean;
  createThread: ThreadSidebarProps["onCreateThread"];
  /** The file the main pane shows, highlighted in the explorer. */
  currentFilePath: string;
  /** Close the views of a file the explorer deleted or a new file it discarded. */
  onFileDeleted: (path: string) => void;
  /** Context-menu "Open" for a listed thread row; row clicks follow their hrefs. */
  onOpenQualifiedThread: (row: WorkbenchLogicalThreadRow, selectedLogicalProjectId: string | null) => void;
  onOpenThread: ActionsProps["onOpenThread"];
  onPresentationDraftDeleted: NonNullable<ActionsProps["onPresentationDraftDeleted"]>;
  onThreadSettled: ActionsProps["onThreadSettled"];
  projectSourceError: string;
  renderThreadTooltipDetails: ThreadSidebarProps["renderThreadTooltipDetails"];
  route: WorkbenchRoute;
  viewedProjectId: string;
}) {
  const client = useWorkbenchClientController();
  const explorer = useWorkbenchExplorer();
  const physicalProjects = explorer.projects;
  const browseLocation = explorer.browseLocation ?? null;
  const browseProjectId = browseLocation?.projectId ?? explorer.currentProjectId;
  const search = useWorkbenchSearch();
  const projectHref = useWorkbenchProjectNavigation();
  const navigate = useWorkbenchNavigate();
  const { preferences, setPanel } = useWorkbenchSidebarPreferences();
  useTabPanel(route, setPanel);
  const panel = preferences.panel;
  const selection = useProjects.selection(route, physicalProjects, browseLocation);
  const projectOrder = (selection.displayedLogicalProjects ?? physicalProjects).map(project => project.id);
  const toggleProject = (projectId: string) => navigate(
    createToggledProjectSelectionRoute(route, selection.selectionProjectIds, projectId, projectOrder),
    { selection: "exact", keepMobileSidebar: true },
  );
  const unarchivedProjectIds = new Set(selection.unarchivedProjectIds);
  const unsettledProjectIds = new Set(selection.unsettledProjectIds);
  const presentation = client.mounted?.presentationClient?.snapshot();
  const navigator = client.mounted?.projectNavigator;
  const daemonRuntime = client.controls?.daemonRuntime ?? null;
  // A daemon project's workspace is agent scratch: no working tree or explorer to browse.
  const folderOptions = (navigator?.folderOptions([...selection.selectionProjectIds]) ?? [])
    .filter(folder => folder.project?.kind !== "daemon");
  const projects = (
    <ProjectSidebar
      activeProjectId={viewedProjectId}
      selectedProjectIds={selection.selectionProjectIds}
      orderedProjectIds={selection.orderedProjectIds}
      unsettledProjectIds={unsettledProjectIds}
      unarchivedProjectIds={unarchivedProjectIds}
      emptySelectionMessage={route.selectedProjectIds?.length === 0
        ? "No projects selected." : route.selectedProjectIds === null
          && !selection.selectionProjectIds.length && !selection.pending
          ? "No projects have unarchived threads." : undefined}
      logicalProjects={selection.displayedLogicalProjects}
      logicalError={[presentation?.error, projectSourceError].filter(Boolean).join(" ") || null}
      logicalLoading={presentation?.phase === "loading"}
      onToggleProject={toggleProject}
      createProjectHref={projectHref(createNewProjectRoute())}
      createProjectSelected={route.view === "new-project"}
      homeSelected={route.view === "home"}
      projects={physicalProjects}
    />
  );
  const folder = (content: (location: ProjectLocationReference) => ReactNode) => folderOptions.length ? (
    <WorkbenchFolderSidebar
      folders={folderOptions}
      label="Choose folder"
      onSelect={location => {
        navigate({
          ...route,
          folderAddress: navigator?.folderAddressFor(location, route) ?? null,
        }, { keepMobileSidebar: true });
      }}
      selected={browseLocation}
    >
      {browseLocation ? content(browseLocation) : (
        <p className="m-0 px-2 py-1 text-[0.8rem] leading-5 text-fg/muted">Choose a folder to see its changes and files.</p>
      )}
    </WorkbenchFolderSidebar>
  ) : (
    <p className="m-0 px-2 py-1 text-[0.8rem] leading-5 text-fg/muted">Select a project with a folder to browse.</p>
  );
  return (
    <aside className={`
      grid h-dvh w-screen min-w-0 shrink-0 select-none grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]
      overflow-hidden pr-5 text-[0.95rem] leading-6 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:pr-6
      ${collapsed ? "md:hidden" : ""}
    `}>
      <header className="z-10 col-start-1 row-start-1 grid min-w-0 grid-cols-[1fr_auto_auto_auto] items-center gap-1 pt-3 pb-2">
        <span className="flex min-w-0 items-center gap-2 pl-5 text-xl font-semibold leading-tight text-text">
          <span className="min-w-0 truncate">workbench</span>
          <WorkbenchConnectionSpinner />
        </span>
        <IconButton label="Open workspace search" display="hover-border" onClick={() => search.open()} type="button">
          <SearchIcon size={20} />
        </IconButton>
        <IconButton as="a" label="Open statistics" display="hover-border" href={projectHref(createStatsRoute(null))}>
          <StatsIcon size={20} />
        </IconButton>
        <IconButton as="a" label="Open settings" display="hover-border" href={projectHref(createSettingsRoute(""))}>
          <GearIcon size={20} />
        </IconButton>
      </header>
      <DropTargetBoundary className={`
        scrollbar-hover-reveal scroll-fade-y col-start-1 row-[1/4] flex min-h-0 min-w-0 flex-col
        overflow-x-hidden overflow-y-auto pr-2 pt-16 pb-16 [--scroll-fade-top:2.75rem] [--scroll-fade-bottom:2.5rem]
      `}>
        <WorkbenchThreadSidebarActionsProvider
          onPresentationDraftDeleted={onPresentationDraftDeleted}
          onOpenThread={onOpenThread}
          onOpenQualifiedThread={row => onOpenQualifiedThread(row, route.logical?.projectId ?? null)}
          onThreadSettled={onThreadSettled}
          projectId={activeProjectId}
        >
          {panel === "reload" ? null : projects}
          {panel === "threads" ? <>
            <section className="shrink-0 pb-3">
              <WorkbenchSidebarSectionDisclosure
                contentClassName="space-y-2"
                icon={DraftThreadIcon}
                preferenceKey="threadsOpen"
                title="Threads"
              >
                <WorkbenchThreadSidebar
                  attachedDaemonId={client.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId ?? null}
                  createProjectId={selection.createProjectId}
                  emptySelectionMessage={route.selectedProjectIds === null
                    ? selection.pending ? "Loading projects..." : "No projects have unarchived threads."
                    : undefined}
                  logicalProject={selection.selectedLogicalProject}
                  logicalProjects={selection.displayedLogicalProjects}
                  presentation={presentation?.data}
                  controls={client.controls}
                  selectedLocation={browseLocation}
                  currentTarget={route.view === "thread" ? route.threadTarget : null}
                  onCreateThread={createThread}
                  projectId={browseProjectId}
                  projects={physicalProjects}
                  renderThreadTooltipDetails={renderThreadTooltipDetails}
                  selectedOwnerProjectId={route.view === "thread"
                    ? route.logical?.threadOwnerProjectId ?? (route.threadOwnerProjectId || route.projectId)
                    : viewedProjectId}
                  selectedProjectIds={selection.selectionProjectIds}
                />
              </WorkbenchSidebarSectionDisclosure>
            </section>
            <WorkbenchBrowseSessionsSection controller={browseSessionController} />
          </> : null}
        </WorkbenchThreadSidebarActionsProvider>
        {panel === "git" ? folder(location => (
          <WorkbenchGitSidebar location={location} route={route} onAskAgent={askAgentWithReferences} />
        )) : null}
        {panel === "explorer" ? folder(() => (
          <WorkbenchExplorerSection currentPath={currentFilePath} onFileDeleted={onFileDeleted} route={route} />
        )) : null}
        {panel === "reload" ? (
          <WorkbenchReloadPanel appRuntime={appRuntime} daemonRuntime={daemonRuntime} onAskAgent={askAgentWithReferences} />
        ) : null}
      </DropTargetBoundary>
      <footer className="z-10 col-start-1 row-start-3 pt-2 pb-[calc(0.5rem+min(0.75rem,var(--workbench-safe-area-bottom,0px)))]">
        <WorkbenchSidebarFooter
          appRuntime={appRuntime}
          daemonRuntime={daemonRuntime}
          location={browseLocation}
          onAskAgent={askAgentWithReferences}
          onPanel={setPanel}
          panel={panel}
          projectIds={selection.selectionProjectIds}
        />
      </footer>
    </aside>
  );
}
