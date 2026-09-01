/*
 * Exports:
 * - default WorkbenchAllProjectsThreadSidebar: bind the global observation to one combined home thread list and bounded project errors. Keywords: home, sidebar, projects, threads.
 */
"use client";

import { memo, useMemo, type ReactNode } from "react";

import type { WorkbenchProjectOption } from "../../lib/types";
import type { WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget } from "../../lib/workbench/thread/thread-state";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import WorkbenchHomeThreadList from "./WorkbenchHomeThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

interface WorkbenchAllProjectsThreadSidebarProps {
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  createProjectId: string;
  currentTarget: WorkbenchThreadTarget | null;
  onCreateThread: (ownerProjectId: string, folderId?: string) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projects: readonly WorkbenchProjectOption[];
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedOwnerProjectId: string;
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
}: WorkbenchAllProjectsThreadSidebarProps) {
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  const createProject = projects.find(({ id }) => id === createProjectId) ?? null;
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
        />
      ) : null}
      {errors.map((error) => (
        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted" key={error}>{error}</p>
      ))}
    </nav>
  );
});
