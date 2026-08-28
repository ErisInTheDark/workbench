/*
 * Exports:
 * - default WorkbenchThreadSidebar: render the current project's ordinary thread list from shared sidebar actions. Keywords: sidebar, project, threads, activity, React.
 */
"use client";

import { memo, type PointerEvent, type ReactNode } from "react";

import type { WorkbenchHarness } from "../../lib/types";
import type { WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import { createThreadHref } from "../../lib/workbench/navigation/workbench-route";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget } from "../../lib/workbench/thread/thread-state";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

interface WorkbenchThreadSidebarProps {
  attentionLabelsByThreadId: Record<string, string | undefined>;
  currentTarget: WorkbenchThreadTarget | null;
  harness: WorkbenchHarness;
  isDragActive: boolean;
  onBeginPointerDrag: (event: PointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => void;
  onCreateThread: (folderId?: string) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  showMosaicView: boolean;
}

export default memo(function WorkbenchThreadSidebar({
  attentionLabelsByThreadId,
  currentTarget,
  harness,
  isDragActive,
  onBeginPointerDrag,
  onCreateThread,
  onOpenThread,
  projectId,
  renderThreadTooltipDetails,
  showMosaicView,
}: WorkbenchThreadSidebarProps) {
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  if (actions.isLoading) return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;

  return (
    <>
      <nav aria-label="Threads">
        <WorkbenchThreadList
          allowMainPanelDrop={showMosaicView}
          attentionLabelsByThreadId={attentionLabelsByThreadId}
          autoFocusFolderId={actions.autoFocusFolderId}
          currentTarget={currentTarget}
          displayOrder={actions.displayOrder}
          entries={actions.entries}
          getThreadHref={(target) => createThreadHref(projectId, target)}
          getThreadContextMenu={actions.getThreadContextMenu}
          isDragActive={isDragActive}
          nowMs={actions.nowMs}
          onAction={actions.onAction}
          onAutoFocusFolderComplete={actions.onAutoFocusFolderComplete}
          onCreateThread={onCreateThread}
          onCreateThreadPointerDragStart={showMosaicView ? (event) => {
            onBeginPointerDrag(event, { harness, type: "new-thread" });
          } : undefined}
          onMove={actions.onMove}
          onOpenThread={onOpenThread}
          onRenameFolder={actions.onRenameFolder}
          projectId={projectId}
          renderThreadTooltipDetails={renderThreadTooltipDetails}
        />
      </nav>
      {actions.error ? <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted">{actions.error}</p> : null}
    </>
  );
});
