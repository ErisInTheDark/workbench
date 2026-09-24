/*
 * Exports:
 * - default WorkbenchThreadSidebar: render the current project's configured main thread list from shared sidebar actions.
 */
"use client";

import { memo, useState, type PointerEvent, type ReactNode } from "react";

import type { WorkbenchControls, WorkbenchHarness, WorkbenchLogicalThreadRow, WorkbenchLogicalProject } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { projectLogicalThreadDisplayOrder } from "../../workbench/WorkbenchProjectProjection";
import type { WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import { createLogicalExistingThreadRoute, createLogicalThreadRoute, createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import type { WorkbenchSelectedProjectPinPlacement } from "../../workbench/state/workbench-settings";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type { FolderId, ProjectId } from "workbench-shared/workbench/identity";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import { getWorkbenchThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-order";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

interface WorkbenchThreadSidebarProps {
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  currentTarget: WorkbenchThreadTarget | null;
  harness: WorkbenchHarness;
  onBeginPointerDrag: (event: PointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => void;
  onCreateThread: (folderId?: FolderId) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: ProjectId | "";
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedProjectPinPlacement: WorkbenchSelectedProjectPinPlacement;
  showMosaicView: boolean;
  logicalProject?: WorkbenchLogicalProject | null;
  logicalThreads?: readonly WorkbenchLogicalThreadRow[];
  presentation?: PresentationSnapshot | null;
  controls?: WorkbenchControls | null;
  selectedLocation?: ProjectLocationReference | null;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
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
  logicalProject,
  logicalThreads = [],
  presentation,
  controls,
  selectedLocation,
  onOpenQualifiedThread,
}: WorkbenchThreadSidebarProps) {
  const projectHref = useWorkbenchProjectNavigation();
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  const [layoutError, setLayoutError] = useState("");
  if (actions.isLoading) return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;
  if (!projectId) return null;
  const projectRows = logicalProject ? logicalThreads.filter(row =>
    row.logicalProjectId === logicalProject.id) : [];
  const findRow = (target: WorkbenchThreadTarget) => projectRows.find(row =>
    target.kind === "draft" ? row.entry.entryKind === "draft"
      && row.entry.draft.draftId === target.draftId
      : target.kind === "provider" || target.kind === "subagent"
        ? row.entry.entryKind !== "draft"
          && row.entry.identity.threadId === (target.kind === "subagent" ? target.parentThreadId : target.threadId)
        : false);
  const findEntryRow = (entry: WorkbenchThreadSidebarEntry) => projectRows.find(row =>
    entry.entryKind === "draft" ? row.entry.entryKind === "draft"
      && row.entry.draft.draftId === entry.draft.draftId
      : row.entry.entryKind !== "draft" && row.entry.identity.threadId === entry.identity.threadId);
  const displayedEntries = logicalProject ? projectRows.map(row => row.entry) : actions.entries;
  const displayOrder = logicalProject && presentation
    ? projectLogicalThreadDisplayOrder(logicalProject.id, projectRows, presentation)
    : actions.displayOrder;
  const updateLayout = async (intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[2]) => {
    if (!logicalProject || !controls) return false;
    try {
      await controls.updatePresentationProjectLayout(logicalProject.id, projectRows, intent);
      setLayoutError("");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Project layout could not be saved.";
      setLayoutError(message);
      console.error("Project layout save failed", message);
      return false;
    }
  };

  return (
    <>
      <nav aria-label="Threads">
        <WorkbenchThreadList
          allowMainPanelDrop={showMosaicView}
          attentionLabelsByThreadId={attentionLabelsByThreadId}
          autoFocusFolderId={actions.autoFocusFolderId}
          activeDragPayload={activeDragPayload}
          currentTarget={currentTarget}
          displayOrder={displayOrder}
          entries={displayedEntries}
          getThreadHref={(target) => {
            const row = findRow(target);
            if (logicalProject) {
              if (!row && target.kind !== "new") return undefined;
              return projectHref(target.kind === "provider" || target.kind === "subagent"
                ? createLogicalExistingThreadRoute(logicalProject.id, target)
                : createLogicalThreadRoute(logicalProject.id, logicalProject.id,
                  row?.location ?? selectedLocation ?? null, target));
            }
            return projectHref(createThreadRoute(projectId, target));
          }}
          getThreadContextMenu={logicalProject ? (entry, _ownerProjectId, folderScope) => {
            const row = findEntryRow(entry);
            return row ? actions.getThreadContextMenuFor(entry, folderScope) : null;
          } : actions.getThreadContextMenu}
          nowMs={actions.nowMs}
          onAction={logicalProject ? (entry, action) => {
            const row = findEntryRow(entry);
            if (row) actions.onActionFor(entry, action);
          } : actions.onAction}
          onAutoFocusFolderComplete={actions.onAutoFocusFolderComplete}
          onCreateThread={onCreateThread}
          onCreateThreadPointerDragStart={showMosaicView ? (event) => {
            onBeginPointerDrag(event, { harness, type: "new-thread" });
          } : undefined}
          onMove={logicalProject ? (sourceKey, section, destinationFolderId, beforeKey) => {
            void updateLayout({ kind: "move", sourceKey, section, destinationFolderId, beforeKey });
          } : actions.onMove}
          onOpenThread={logicalProject ? target => {
            const row = findRow(target);
            if (row) onOpenQualifiedThread?.(row);
          } : onOpenThread}
          onProjectFolderDrop={logicalProject ? (payload, targetKey, section, destinationFolderId) => {
            void updateLayout({
              kind: "drop", section, sourceKey: payload.projectSourceKey,
              targetKey, destinationFolderId,
            });
          } : (payload, targetKey, section, destinationFolderId) => {
            actions.onProjectFolderDrop(payload, projectId, targetKey, section, destinationFolderId);
          }}
          onRenameFolder={logicalProject ? async (folderId, title) => {
            if (!await updateLayout({ kind: "rename", folderId, title })) {
              throw new Error("Project folder rename could not be saved.");
            }
            return title.trim();
          } : actions.onRenameFolder}
          onSetPriority={logicalProject ? (payload, priority) => {
            const row = projectRows.find(candidate =>
              getWorkbenchThreadDisplayKey(candidate.entry) === payload.projectSourceKey);
            if (!row || !controls) return;
            const mutation = row.entry.entryKind === "draft"
              ? controls.setPresentationDraftPriority(row.entry.draft.draftId, {
                pinned: priority === "pinned", snoozed: priority === "snoozed",
              })
              : controls.threadAction(row.entry.identity.threadId,
                { kind: "priority", priority });
            void mutation.catch(error => {
              const message = error instanceof Error ? error.message.slice(0, 500) : "Thread priority could not be saved.";
              setLayoutError(message);
              console.error("Thread priority failed", message);
            });
          } : actions.onSetPriority}
          onSnoozeUntil={logicalProject ? undefined : (payload, targetIdentity) => actions.onSnoozeUntil(payload, projectId, targetIdentity)}
          projectId={projectId}
          renderThreadTooltipDetails={renderThreadTooltipDetails}
          showPinnedThreadsInMain={selectedProjectPinPlacement === "threads-section"}
        />
      </nav>
      {layoutError ? <p role="alert" className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">{layoutError}</p> : null}
      {actions.error ? <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted">{actions.error}</p> : null}
    </>
  );
});
