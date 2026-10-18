/*
 * Exports:
 * - default WorkbenchThreadSidebar: feed the combined thread list for the selected projects (the listing for logical lists, project sidebars for folder lists) with bounded project errors and creation guards.
 */
"use client";

import { memo, useMemo, type ComponentProps, type ReactNode } from "react";

import type { WorkbenchControls, WorkbenchHarness, WorkbenchLogicalThreadRow, WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { useWorkbenchDrag } from "./drag/workbench-drag-context";
import { createLogicalExistingThreadRoute, createLogicalThreadRoute, createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import { ProjectIdSchema, type FolderId, type ProjectId } from "workbench-shared/workbench/identity";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import WorkbenchThreadList from "./WorkbenchThreadList";
import { useWorkbenchClientController } from "./workbench-client-context";
import { useThreads } from "./use-threads";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import { resolveSidebarCreateTarget } from "./workbench-sidebar-create-project";

function findRow(
  logicalProject: WorkbenchLogicalProject,
  logicalThreads: readonly WorkbenchLogicalThreadRow[],
  target: WorkbenchThreadTarget,
) {
  return logicalThreads.find(candidate => candidate.logicalProjectId === logicalProject.id
    && (target.kind === "draft"
      ? candidate.entry.entryKind === "draft" && candidate.entry.draft.draftId === target.draftId
      : target.kind === "provider" || target.kind === "subagent"
        ? candidate.entry.entryKind !== "draft"
          && candidate.entry.identity.threadId === (target.kind === "subagent" ? target.parentThreadId : target.threadId)
        : false));
}

/** Folder-sidebar lists (no app presentation) are built from the project sidebars, so only they subscribe to them. */
function FolderSidebarThreadList({ sidebarProjectId, ...props }: ComponentProps<typeof WorkbenchThreadList> & {
  sidebarProjectId: ProjectId | "";
}) {
  const current = useThreads.sidebar(sidebarProjectId);
  const sidebars = useThreads.sidebars();
  const { order, supported } = useThreads.homeOrder();
  const folderSidebars = useMemo(() => ({
    sidebars, homeDisplayOrder: order.displayOrder, homeDisplayOrderSupported: supported,
    ...(current && sidebarProjectId ? { current: { entries: current.entries, displayOrder: current.displayOrder ?? {} } } : {}),
  }), [current, order.displayOrder, sidebarProjectId, sidebars, supported]);
  return <WorkbenchThreadList {...props} folderSidebars={folderSidebars} />;
}

interface WorkbenchThreadSidebarProps {
  attachedDaemonId?: string | null;
  createProjectId?: string;
  currentTarget: WorkbenchThreadTarget | null;
  emptySelectionMessage?: string;
  harness: WorkbenchHarness;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  onAttachFeedback?: (
    ownerProjectId: string,
    target: WorkbenchThreadTarget,
    reference: WorkbenchThreadAddressedFeedback,
  ) => Promise<void>;
  onCreateThread: (ownerProjectId: string, options?: {
    folderId?: FolderId;
    location?: ProjectLocationReference;
  }) => void;
  projectId: ProjectId | "";
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  showMosaicView: boolean;
  logicalProject?: WorkbenchLogicalProject | null;
  presentation?: PresentationSnapshot | null;
  controls?: WorkbenchControls | null;
  selectedLocation?: ProjectLocationReference | null;
  projects?: readonly WorkbenchProjectOption[];
  selectedProjectIds?: readonly string[];
  selectedOwnerProjectId?: string;
}

export default memo(function WorkbenchThreadSidebar({
  attachedDaemonId,
  createProjectId,
  currentTarget,
  emptySelectionMessage,
  harness,
  logicalProjects,
  onAttachFeedback,
  onCreateThread,
  projectId,
  renderThreadTooltipDetails,
  showMosaicView,
  logicalProject,
  presentation,
  controls,
  selectedLocation,
  projects = [],
  selectedProjectIds,
  selectedOwnerProjectId,
}: WorkbenchThreadSidebarProps) {
  const projectHref = useWorkbenchProjectNavigation();
  const client = useWorkbenchClientController();
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  const beginDrag = useWorkbenchDrag.mainPanel();
  const ownerProjectId = logicalProject?.id ?? projectId;
  const selection = selectedProjectIds ?? (ownerProjectId ? [ownerProjectId] : []);
  const createTarget = resolveSidebarCreateTarget({
    createProjectId, logicalProject, logicalProjects, presentation, projects, selectedOwnerProjectId,
    selectedProjectIds: selection,
  });

  const errorText = useThreads.sidebarErrors(selection);
  const errors = errorText ? errorText.split("\n") : [];
  const listing = useThreads.status();
  const sidebarLoading = useThreads.sidebarLoading(projectId);
  const logicalList = Boolean(logicalProjects && presentation);
  const loading = logicalList
    // Logical lists render workspace rows; folder sidebars only describe the browse folder.
    ? !listing.listed && listing.loading && !listing.error
    : sidebarLoading && !logicalProject && !selectedLocation && projects.length;
  if (loading) {
    return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;
  }
  if (!selection.length) {
    return <p className="m-0 px-2 py-2 text-[0.8rem] text-fg/muted">
      {emptySelectionMessage ?? "No projects selected. Select a project to see its threads."}
    </p>;
  }

  const listProps: ComponentProps<typeof WorkbenchThreadList> = {
          actions,
          allowMainPanelDrop: showMosaicView,
          attachedDaemonId,
          canCreateThread: logicalProject
            ? Boolean(client.mounted && (selectedLocation || logicalProject.locations.some(location => location.project)))
            : undefined,
          controls,
          createTarget,
          currentTarget,
          // Logical lists without one selected project use the list's owner-qualified row hrefs.
          getThreadHref: logicalProject ? (target) => {
            const row = findRow(logicalProject, client.mounted?.threadSidebar.getListing?.().rows ?? [], target);
            if (!row && target.kind !== "new") return undefined;
            return projectHref(target.kind === "provider" || target.kind === "subagent"
              ? createLogicalExistingThreadRoute(logicalProject.id, target)
              : createLogicalThreadRoute(logicalProject.id, logicalProject.id,
                row?.location ?? selectedLocation ?? null, target));
          } : logicalProjects ? undefined : (target) => projectHref(createThreadRoute(projectId, target)),
          logicalProjects: logicalProjects ?? (logicalProject ? [logicalProject] : undefined),
          onAttachFeedback,
          onCreateThread,
          onCreateThreadPointerDragStart: showMosaicView ? (event) => {
            beginDrag(event, { harness, type: "new-thread" });
          } : undefined,
          presentation,
          projectId: ownerProjectId,
          projects,
          renderThreadTooltipDetails,
          selectedOwnerProjectId: selectedOwnerProjectId ?? ownerProjectId,
          selectedProjectIds: selection,
  };

  return (
    <>
      <nav aria-label="Threads">
        {logicalList ? <WorkbenchThreadList {...listProps} />
          : <FolderSidebarThreadList {...listProps} sidebarProjectId={logicalProject ? "" : projectId} />}
      </nav>
      {errors.map(error => (
        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger" key={error}>{error}</p>
      ))}
      {actions.error ? <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted">{actions.error}</p> : null}
    </>
  );
});
