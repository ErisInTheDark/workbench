/*
 * Exports:
 * - default WorkbenchAllProjectsThreadSidebar: bind the global observation to one combined home thread list and bounded project errors.
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
  logicalProjects,
  logicalThreads,
  presentation,
  controls,
  attachedDaemonId,
  onOpenQualifiedThread,
}: WorkbenchAllProjectsThreadSidebarProps) {
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  const createProject = logicalProjects?.find(project => project.locations.some(location =>
    location.target.projectId === createProjectId && location.project))
    ?? projects.find(({ id }) => id === createProjectId) ?? null;
  const errors = useMemo(
    () => [...new Set(actions.projectThreadSidebars.projects.map(({ error }) => error).filter(Boolean))],
    [actions.projectThreadSidebars.projects],
  );
  if (actions.isLoading && projects.length) return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;

  return (
    <nav aria-label="Threads" className="space-y-2">
      {createProject ? (
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
          logicalProjects={logicalProjects}
          logicalThreads={logicalThreads}
          presentation={presentation}
          controls={controls}
          attachedDaemonId={attachedDaemonId}
          onOpenQualifiedThread={onOpenQualifiedThread}
        />
      ) : null}
      {errors.map((error) => (
        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted" key={error}>{error}</p>
      ))}
    </nav>
  );
});
