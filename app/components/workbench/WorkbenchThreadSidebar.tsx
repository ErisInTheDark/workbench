/*
 * Exports:
 * - default WorkbenchThreadSidebar: render the current project's configured main thread list from shared sidebar actions. Keywords: sidebar, project, pinned, threads, activity, React.
 */
"use client";

import { memo, type PointerEvent, type ReactNode } from "react";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import { createThreadHref } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchSelectedProjectPinPlacement } from "../../workbench/state/workbench-settings";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

interface WorkbenchThreadSidebarProps {
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  currentTarget: WorkbenchThreadTarget | null;
  harness: WorkbenchHarness;
  onBeginPointerDrag: (event: PointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => void;
  onCreateThread: (folderId?: string) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedProjectPinPlacement: WorkbenchSelectedProjectPinPlacement;
  showMosaicView: boolean;
}

export default memo(function WorkbenchThreadSidebar({
  activeDragPayload,
  attentionLabelsByThreadId,
  currentTarget,
  harness,
  onBeginPointerDrag,
  onCreateThread,
  onOpenThread,
  projectId,
  renderThreadTooltipDetails,
  selectedProjectPinPlacement,
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
          activeDragPayload={activeDragPayload}
          currentTarget={currentTarget}
          displayOrder={actions.displayOrder}
          entries={actions.entries}
          getThreadHref={(target) => createThreadHref(projectId, target)}
          getThreadContextMenu={actions.getThreadContextMenu}
          nowMs={actions.nowMs}
          onAction={actions.onAction}
          onAutoFocusFolderComplete={actions.onAutoFocusFolderComplete}
          onCreateThread={onCreateThread}
          onCreateThreadPointerDragStart={showMosaicView ? (event) => {
            onBeginPointerDrag(event, { harness, type: "new-thread" });
          } : undefined}
          onMove={actions.onMove}
          onOpenThread={onOpenThread}
          onProjectFolderDrop={(payload, targetKey, section, destinationFolderId) => {
            actions.onProjectFolderDrop(payload, projectId, targetKey, section, destinationFolderId);
          }}
          onRenameFolder={actions.onRenameFolder}
          onSetPriority={actions.onSetPriority}
          onSnoozeUntil={(payload, targetIdentity) => actions.onSnoozeUntil(payload, projectId, targetIdentity)}
          projectId={projectId}
          renderThreadTooltipDetails={renderThreadTooltipDetails}
          showPinnedThreadsInMain={selectedProjectPinPlacement === "threads-section"}
        />
      </nav>
      {actions.error ? <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted">{actions.error}</p> : null}
    </>
  );
});
