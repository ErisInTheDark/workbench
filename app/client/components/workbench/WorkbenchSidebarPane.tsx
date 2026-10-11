/*
 * Exports:
 * - default WorkbenchSidebarPane: the workbench sidebar (header links, projects, threads, folders, browse sessions, reload notice), reading the route's project selection itself.
 */
"use client";

import type { ComponentProps, MouseEvent, ReactNode } from "react";

import type { WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import { createHomeRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type WorkbenchBrowseSessionController from "../../workbench/browse/WorkbenchBrowseSessionController";
import type WorkbenchSearchController from "../../workbench/search/WorkbenchSearchController";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import IconButton from "../ui/IconButton";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import WorkbenchGitSidebar from "./git/WorkbenchGitSidebar";
import ProjectSidebar from "./ProjectSidebar";
import ReloadNecessary from "./ReloadNecessary";
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
type LinkClick = (event: MouseEvent<HTMLAnchorElement>) => void;

export default function WorkbenchSidebarPane({
  activeDragPayload, activeProjectId, appRuntime, askAgentWithReferences, browseLocation, browseProjectId,
  browseSessionController, collapsed, createThread, explorerSection, harness, navigateToRoute, newProjectRoute,
  onAttachFeedback, onBeginPointerDrag, onOpenQualifiedThread, onOpenStats, onOpenSettings, onOpenThread,
  onPresentationDraftDeleted, onSelectProjectLink, onThreadSettled, physicalProjects, projectSourceError,
  renderThreadTooltipDetails, route, searchController, settingsHref, showGitView, showMosaicView, statsRoute,
  viewedProjectId,
}: {
  activeDragPayload: ThreadSidebarProps["activeDragPayload"];
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
  navigateToRoute: (route: WorkbenchRoute) => void;
  newProjectRoute: WorkbenchRoute;
  onAttachFeedback: ThreadSidebarProps["onAttachFeedback"];
  onBeginPointerDrag: ThreadSidebarProps["onBeginPointerDrag"];
  onOpenQualifiedThread: (row: WorkbenchLogicalThreadRow, selectedLogicalProjectId: string | null) => void;
  onOpenStats: LinkClick;
  onOpenSettings: LinkClick;
  onOpenThread: ThreadSidebarProps["onOpenThread"];
  onPresentationDraftDeleted: NonNullable<ActionsProps["onPresentationDraftDeleted"]>;
  onSelectProjectLink: ComponentProps<typeof ProjectSidebar>["onProjectLinkClick"];
  onThreadSettled: ActionsProps["onThreadSettled"];
  physicalProjects: readonly WorkbenchProjectOption[];
  projectSourceError: string;
  renderThreadTooltipDetails: ThreadSidebarProps["renderThreadTooltipDetails"];
  route: WorkbenchRoute;
  searchController: WorkbenchSearchController;
  settingsHref: string;
  showGitView: boolean;
  showMosaicView: boolean;
  statsRoute: WorkbenchRoute;
  viewedProjectId: string;
}) {
  const client = useWorkbenchClientController();
  const projectHref = useWorkbenchProjectNavigation();
  const selection = useProjects.selection(route, physicalProjects, browseLocation);
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
              onClick={() => searchController.open()}
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
              href={projectHref(statsRoute)}
              onClick={onOpenStats}
              title="Open statistics"
            >
              <StatsIcon size={20} />
              <span className="sr-only">Open statistics</span>
            </IconButton>
            <IconButton
              as="a"
              label="Open settings"
              display="hover-border"
              href={settingsHref}
              onClick={onOpenSettings}
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
              onProjectLinkClick={onSelectProjectLink}
              onHomeClick={event => {
                if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                event.preventDefault();
                navigateToRoute(createHomeRoute());
              }}
              createProjectHref={projectHref(newProjectRoute)}
              onCreateProject={event => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigateToRoute(newProjectRoute);
              }}
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
                  activeDragPayload={activeDragPayload}
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
                  onOpenQualifiedThread={row => onOpenQualifiedThread(row,
                    route.selectedProjectIds === null ? null : row.logicalProjectId)}
                  currentTarget={route.view === "thread" ? route.threadTarget : null}
                  harness={harness}
                  onBeginPointerDrag={onBeginPointerDrag}
                  onCreateThread={createThread}
                  onOpenThread={onOpenThread}
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
              navigateToRoute({
                ...route,
                folderAddress: navigator?.folderAddressFor(location, route) ?? null,
              });
            }}
            selected={browseLocation}
          >
            {browseLocation && gitRoute ? <WorkbenchGitSidebar active={showGitView} route={gitRoute} onNavigate={event => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigateToRoute(gitRoute);
            }} /> : (
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
