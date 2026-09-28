/*
 * Exports:
 * - default WorkbenchAllProjectsThreadSidebar: bind selected project observations to one combined thread list and bounded project errors.
 */
"use client";

import { memo, useMemo, type ReactNode } from "react";

import type { WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { FolderId } from "workbench-shared/workbench/identity";
import type { WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import WorkbenchHomeThreadList from "./WorkbenchHomeThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

interface WorkbenchAllProjectsThreadSidebarProps {
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  createProjectId: string;
  currentTarget: WorkbenchThreadTarget | null;
  onCreateThread: (ownerProjectId: string, folderId?: FolderId) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projects: readonly WorkbenchProjectOption[];
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedOwnerProjectId: string;
  selectedProjectIds: readonly string[];
  emptySelectionMessage?: string;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  logicalThreads?: readonly WorkbenchLogicalThreadRow[];
  presentation?: PresentationSnapshot | null;
  controls?: WorkbenchControls | null;
  attachedDaemonId?: string | null;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
}

export default memo(function WorkbenchAllProjectsThreadSidebar({
  activeDragPayload,
  attentionLabelsByThreadId,
  createProjectId,
  currentTarget,
  onCreateThread,
  onOpenThread,
  projects,
  renderThreadTooltipDetails,
  selectedOwnerProjectId,
  selectedProjectIds,
  emptySelectionMessage,
  logicalProjects,
  logicalThreads,
  presentation,
  controls,
  attachedDaemonId,
  onOpenQualifiedThread,
}: WorkbenchAllProjectsThreadSidebarProps) {
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  const selected = new Set(selectedProjectIds);
  const createProject = logicalProjects
    ? logicalProjects.find(project => project.locations.some(location =>
      location.target.projectId === createProjectId && location.project)
      && selected.has(project.id)) ?? null
    : projects.find(({ id }) => id === createProjectId && selected.has(id)) ?? null;
  const errors = useMemo(
    () => [...new Set(actions.projectThreadSidebars.projects
      .filter(sidebar => selectedProjectIds.includes(sidebar.projectId))
      .map(({ error }) => error).filter(Boolean))],
    [actions.projectThreadSidebars.projects, selectedProjectIds],
  );
  if (actions.isLoading && !logicalProjects && projects.length) {
    return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;
  }
  if (!selectedProjectIds.length) {
    return <p className="m-0 px-2 py-2 text-[0.8rem] text-fg/muted">{emptySelectionMessage ?? "No projects selected. Select a project to see its threads."}</p>;
  }

  return (
    <nav aria-label="Threads" className="space-y-2">
      <WorkbenchHomeThreadList
          actions={actions}
          activeDragPayload={activeDragPayload}
          attentionLabelsByThreadId={attentionLabelsByThreadId}
          createProject={createProject}
          currentTarget={currentTarget}
          onCreateThread={onCreateThread}
          onOpenThread={onOpenThread}
          projects={projects}
          renderThreadTooltipDetails={renderThreadTooltipDetails}
          selectedOwnerProjectId={selectedOwnerProjectId}
          selectedProjectIds={selectedProjectIds}
          logicalProjects={logicalProjects}
          logicalThreads={logicalThreads}
          presentation={presentation}
          controls={controls}
          attachedDaemonId={attachedDaemonId}
          onOpenQualifiedThread={onOpenQualifiedThread}
        />
      {errors.map((error) => (
        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted" key={error}>{error}</p>
      ))}
    </nav>
  );
});
