/*
 * Exports:
 * - default WorkbenchThreadSidebar: feed the combined thread list for the selected projects with bounded project errors and creation guards.
 */
"use client";

import { memo, type PointerEvent, type ReactNode } from "react";

import type { WorkbenchControls, WorkbenchHarness, WorkbenchLogicalThreadRow, WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import { createLogicalExistingThreadRoute, createLogicalThreadRoute, createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { ProjectIdSchema, type FolderId, type ProjectId } from "workbench-shared/workbench/identity";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import WorkbenchThreadList from "./WorkbenchThreadList";
import { useWorkbenchClientController } from "./workbench-client-context";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import { resolveSidebarCreateProject } from "./workbench-sidebar-create-project";

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

interface WorkbenchThreadSidebarProps {
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  attachedDaemonId?: string | null;
  createProjectId?: string;
  currentTarget: WorkbenchThreadTarget | null;
  emptySelectionMessage?: string;
  harness: WorkbenchHarness;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  onBeginPointerDrag: (event: PointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => void;
  onCreateThread: (ownerProjectId: string, folderId?: FolderId) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: ProjectId | "";
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  showMosaicView: boolean;
  logicalProject?: WorkbenchLogicalProject | null;
  logicalThreads?: readonly WorkbenchLogicalThreadRow[];
  presentation?: PresentationSnapshot | null;
  controls?: WorkbenchControls | null;
  selectedLocation?: ProjectLocationReference | null;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
  projects?: readonly WorkbenchProjectOption[];
  selectedProjectIds?: readonly string[];
  selectedOwnerProjectId?: string;
}

export default memo(function WorkbenchThreadSidebar({
  activeDragPayload,
  attentionLabelsByThreadId,
  attachedDaemonId,
  createProjectId,
  currentTarget,
  emptySelectionMessage,
  harness,
  logicalProjects,
  onBeginPointerDrag,
  onCreateThread,
  onOpenThread,
  projectId,
  renderThreadTooltipDetails,
  showMosaicView,
  logicalProject,
  logicalThreads = [],
  presentation,
  controls,
  selectedLocation,
  onOpenQualifiedThread,
  projects = [],
  selectedProjectIds,
  selectedOwnerProjectId,
}: WorkbenchThreadSidebarProps) {
  const projectHref = useWorkbenchProjectNavigation();
  const client = useWorkbenchClientController();
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  const ownerProjectId = logicalProject?.id ?? projectId;
  const selection = selectedProjectIds ?? (ownerProjectId ? [ownerProjectId] : []);
  const createProject = resolveSidebarCreateProject({
    createProjectId, logicalProject, logicalProjects, projects, selectedProjectIds: selection,
  });

  const errors = [...new Set(actions.projectThreadSidebars.projects
    .filter(sidebar => selection.includes(sidebar.projectId))
    .map(({ error }) => error).filter(Boolean))];
  const explorer = client.explorer;
  const loading = logicalProjects && presentation
    // Logical lists render workspace rows; folder sidebars only describe the browse folder.
    ? !explorer.workspaceThreads && explorer.isThreadsLoading && !explorer.threadsError
    : actions.isLoading && !logicalProject && !selectedLocation && projects.length;
  if (loading) {
    return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;
  }
  if (!selection.length) {
    return <p className="m-0 px-2 py-2 text-[0.8rem] text-fg/muted">
      {emptySelectionMessage ?? "No projects selected. Select a project to see its threads."}
    </p>;
  }

  return (
    <>
      <nav aria-label="Threads">
        <WorkbenchThreadList
          actions={actions}
          activeDragPayload={activeDragPayload}
          allowMainPanelDrop={showMosaicView}
          attentionLabelsByThreadId={attentionLabelsByThreadId}
          attachedDaemonId={attachedDaemonId}
          canCreateThread={logicalProject
            ? Boolean(client.mounted && (selectedLocation || logicalProject.locations.some(location => location.project)))
            : undefined}
          controls={controls}
          createProject={createProject}
          currentTarget={currentTarget}
          displayOrder={logicalProject ? undefined : actions.displayOrder}
          entries={logicalProject ? undefined : actions.entries}
          getThreadHref={(target) => {
            if (logicalProject) {
              const row = findRow(logicalProject, logicalThreads, target);
              if (!row && target.kind !== "new") return undefined;
              return projectHref(target.kind === "provider" || target.kind === "subagent"
                ? createLogicalExistingThreadRoute(logicalProject.id, target)
                : createLogicalThreadRoute(logicalProject.id, logicalProject.id,
                  row?.location ?? selectedLocation ?? null, target));
            }
            return projectHref(createThreadRoute(projectId, target));
          }}
          logicalProjects={logicalProjects ?? (logicalProject ? [logicalProject] : undefined)}
          logicalThreads={logicalThreads}
          onCreateThread={onCreateThread}
          onCreateThreadPointerDragStart={showMosaicView ? (event) => {
            onBeginPointerDrag(event, { harness, type: "new-thread" });
          } : undefined}
          onOpenQualifiedThread={onOpenQualifiedThread}
          onOpenThread={onOpenThread}
          presentation={presentation}
          projectId={ownerProjectId}
          projects={projects}
          renderThreadTooltipDetails={renderThreadTooltipDetails}
          selectedOwnerProjectId={selectedOwnerProjectId ?? ownerProjectId}
          selectedProjectIds={selection}
        />
      </nav>
      {errors.map(error => (
        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger" key={error}>{error}</p>
      ))}
      {actions.error ? <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted">{actions.error}</p> : null}
    </>
  );
});
