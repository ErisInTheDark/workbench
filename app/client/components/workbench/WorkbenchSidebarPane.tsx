/*
 * Exports:
 * - default WorkbenchSidebarPane: the workbench sidebar (header links, projects, threads, folders, browse sessions, reload notice), reading the route's project selection itself.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";

import type { WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import {
  createNewProjectRoute, createSettingsRoute, createStatsRoute, createToggledProjectSelectionRoute, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type WorkbenchBrowseSessionController from "../../workbench/browse/WorkbenchBrowseSessionController";
import { useWorkbenchNavigate, useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import IconButton from "../ui/IconButton";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import WorkbenchGitSidebar from "./git/WorkbenchGitSidebar";
import ProjectSidebar from "./ProjectSidebar";
import ReloadNecessary from "./ReloadNecessary";
import { useWorkbenchSearch } from "./search/workbench-search-context";
import { useProjects } from "./use-projects";
import WorkbenchBrowseSessionsSection from "./WorkbenchBrowseSessionsSection";
import { useWorkbenchClientController } from "./workbench-client-context";
import WorkbenchConnectionSpinner from "./WorkbenchConnectionSpinner";
import WorkbenchFolderSidebar from "./WorkbenchFolderSidebar";
import { DraftThreadIcon, GearIcon, SearchIcon, StatsIcon } from "./workbench-icons";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadSidebar from "./WorkbenchThreadSidebar";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

type ThreadSidebarProps = ComponentProps<typeof WorkbenchThreadSidebar>;
type ActionsProps = ComponentProps<typeof WorkbenchThreadSidebarActionsProvider>;
export default function WorkbenchSidebarPane({
  activeProjectId, appRuntime, askAgentWithReferences, browseLocation, browseProjectId,
  browseSessionController, collapsed, createThread, explorerSection, harness,
  onAttachFeedback, onOpenQualifiedThread, onOpenThread,
  onPresentationDraftDeleted, onThreadSettled, physicalProjects, projectSourceError,
  renderThreadTooltipDetails, route, showGitView, showMosaicView,
  viewedProjectId,
}: {
  activeProjectId: ActionsProps["projectId"];
  appRuntime: ComponentProps<typeof ReloadNecessary>["appRuntime"];
  askAgentWithReferences: ComponentProps<typeof ReloadNecessary>["onAskAgent"];
  browseLocation: ProjectLocationReference | null;
  browseProjectId: ThreadSidebarProps["projectId"];
  browseSessionController: WorkbenchBrowseSessionController;
  collapsed: boolean;
  createThread: ThreadSidebarProps["onCreateThread"];
  /** The folder's explorer tree, rendered only while a folder is selected. */
  explorerSection: ReactNode;
  harness: ThreadSidebarProps["harness"];
  onAttachFeedback: ThreadSidebarProps["onAttachFeedback"];
  /** Context-menu "Open" for a listed thread row; row clicks follow their hrefs. */
  onOpenQualifiedThread: (row: WorkbenchLogicalThreadRow, selectedLogicalProjectId: string | null) => void;
  onOpenThread: ActionsProps["onOpenThread"];
  onPresentationDraftDeleted: NonNullable<ActionsProps["onPresentationDraftDeleted"]>;
  onThreadSettled: ActionsProps["onThreadSettled"];
  physicalProjects: readonly WorkbenchProjectOption[];
  projectSourceError: string;
  renderThreadTooltipDetails: ThreadSidebarProps["renderThreadTooltipDetails"];
  route: WorkbenchRoute;
  showGitView: boolean;
  showMosaicView: boolean;
  viewedProjectId: string;
}) {
  const client = useWorkbenchClientController();
  const search = useWorkbenchSearch();
  const projectHref = useWorkbenchProjectNavigation();
  const navigate = useWorkbenchNavigate();
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
  // A daemon project's workspace is agent scratch: no working tree or explorer to browse.
  const folderOptions = (navigator?.folderOptions([...selection.selectionProjectIds]) ?? [])
    .filter(folder => folder.project?.kind !== "daemon");
  const gitRoute = navigator?.gitRoute(route, browseLocation) ?? null;
  return (
    <aside className={`flex h-dvh w-screen min-w-0 shrink-0 select-none flex-col overflow-hidden pr-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:pr-6${collapsed ? " md:hidden" : ""}`}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-[0.95rem] leading-6">
        <DropTargetBoundary className="scrollbar-hover-reveal flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pt-3 pb-[calc(0.75rem+min(0.75rem,var(--workbench-safe-area-bottom,0px)))] pr-2">
          <header className="-mr-2 grid shrink-0 grid-cols-[1fr_auto_auto_auto] items-center gap-1 pb-2">
            <span className="flex min-w-0 items-center gap-2 pl-5 text-xl font-semibold leading-tight text-text">
              <span className="min-w-0 truncate">workbench</span>
              <WorkbenchConnectionSpinner />
            </span>
            <IconButton
              label="Open workspace search"
              display="hover-border"
              onClick={() => search.open()}
              title="Open workspace search"
              type="button"
            >
              <SearchIcon size={20} />
              <span className="sr-only">Open workspace search</span>
            </IconButton>
            <IconButton
              as="a"
              label="Open statistics"
              display="hover-border"
              href={projectHref(createStatsRoute(null))}
              title="Open statistics"
            >
              <StatsIcon size={20} />
              <span className="sr-only">Open statistics</span>
            </IconButton>
            <IconButton
              as="a"
              label="Open settings"
              display="hover-border"
              href={projectHref(createSettingsRoute(""))}
              title="Open settings"
            >
              <GearIcon size={20} />
              <span className="sr-only">Open settings</span>
            </IconButton>
          </header>
          <WorkbenchThreadSidebarActionsProvider
            onPresentationDraftDeleted={onPresentationDraftDeleted}
            onOpenThread={onOpenThread}
            onOpenQualifiedThread={row => onOpenQualifiedThread(row, route.logical?.projectId ?? null)}
            onThreadSettled={onThreadSettled}
            projectId={activeProjectId}
          >
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
                  onAttachFeedback={onAttachFeedback}
                  presentation={presentation?.data}
                  controls={client.controls}
                  selectedLocation={browseLocation}
                  currentTarget={route.view === "thread" ? route.threadTarget : null}
                  harness={harness}
                  onCreateThread={createThread}
                  projectId={browseProjectId}
                  projects={physicalProjects}
                  renderThreadTooltipDetails={renderThreadTooltipDetails}
                  selectedOwnerProjectId={route.view === "thread"
                    ? route.logical?.threadOwnerProjectId ?? (route.threadOwnerProjectId || route.projectId)
                    : viewedProjectId}
                  selectedProjectIds={selection.selectionProjectIds}
                  showMosaicView={showMosaicView}
                />
              </WorkbenchSidebarSectionDisclosure>
            </section>
          </WorkbenchThreadSidebarActionsProvider>
          {folderOptions.length ? <WorkbenchFolderSidebar
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
            {browseLocation && gitRoute ? <WorkbenchGitSidebar active={showGitView} location={browseLocation} route={gitRoute}
              onAskAgent={askAgentWithReferences} /> : (
              <p className="m-0 px-2 py-1 text-[0.8rem] leading-5 text-fg/muted">
                Choose a folder to see its working tree and files.
              </p>
            )}
            {browseLocation ? explorerSection : null}
          </WorkbenchFolderSidebar> : null}
          <WorkbenchBrowseSessionsSection controller={browseSessionController} />
          <ReloadNecessary
            appRuntime={appRuntime}
            daemonRuntime={client.controls?.daemonRuntime ?? null}
            onAskAgent={askAgentWithReferences}
          />
        </DropTargetBoundary>
      </div>
    </aside>
  );
}
