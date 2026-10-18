/*
 * Exports:
 * - ThreadListRowEntry: a placed row, by key: a listed slot whose facts the row reads itself, or a folder-sidebar entry.
 * - ThreadListRowContext: list-wide state and actions every row of one list shares.
 * - default WorkbenchThreadListRow: one sidebar thread row that reads its own facts, attention and actions, so one thread's activity re-renders only its row.
 */
"use client";

import type { DragEventHandler, KeyboardEvent as ReactKeyboardEvent, PointerEventHandler, ReactNode } from "react";

import type {
  WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalThreadRow, WorkbenchProjectOption, WorkbenchThreadListingSlot,
} from "workbench-shared/types";
import { DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, type ProjectThreadDisplayKey } from "workbench-shared/workbench/identity";
import {
  createHomeThreadRoute, createLogicalExistingThreadRoute, createLogicalThreadRoute, isWorkbenchThreadTargetSelected,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchHomeThreadDisplayItem } from "workbench-shared/workbench/thread/home-thread-display-order";
import { getWorkbenchThreadDisplayKey, type WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import type {
  WorkbenchThreadRouteTarget as WorkbenchThreadTarget, WorkbenchThreadTarget as ListedTarget,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import {
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_MAIN_PANEL_DROP_TARGET_ID,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchThreadDragSection,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import Draggable from "./drag/Draggable";
import { useWorkbenchDrag } from "./drag/workbench-drag-context";
import { useThread } from "./use-thread";
import { useThreads } from "./use-threads";
import WorkbenchThreadComposerDropTarget from "./WorkbenchThreadComposerDropTarget";
import WorkbenchThreadDragTargets from "./WorkbenchThreadDragTargets";
import WorkbenchThreadListItem, { WorkbenchPendingThreadListItem } from "./WorkbenchThreadListItem";
import type WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

type ThreadActions = ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>;
type PlacementFolder = Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>["folder"];

type ListedEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>;

export type ThreadListRowEntry =
  | { slot: WorkbenchThreadListingSlot; projectId: string; threadKey: ProjectThreadDisplayKey }
  | { entry: ListedEntry; projectId: string; threadKey: ProjectThreadDisplayKey };

export interface ThreadListRowContext {
  actions: ThreadActions;
  allowMainPanelDrop: boolean;
  /** Folder-sidebar rows on this daemon resolve their listed row through it. */
  attachedDaemonId: string | null;
  controls: WorkbenchControls | null | undefined;
  currentTarget: WorkbenchThreadTarget | null;
  focusRow: (event: ReactKeyboardEvent<HTMLAnchorElement>, threadKey: string) => void;
  getThreadHref?: (target: WorkbenchThreadTarget, ownerProjectId?: string) => string | undefined;
  hasSelectedEntry: boolean;
  firstThreadKey: string | null;
  homeDisplayOrderSupported: boolean;
  isShiftPressed: boolean;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  onAttachFeedback?: (ownerProjectId: string, target: WorkbenchThreadTarget, reference: WorkbenchThreadAddressedFeedback) => Promise<void>;
  projectHref: (route: WorkbenchRoute) => string | undefined;
  projectsById: ReadonlyMap<string, WorkbenchProjectOption | WorkbenchLogicalProject>;
  readRowForPayload: (payload: WorkbenchThreadRowDragPayload) => WorkbenchLogicalThreadRow | undefined;
  registerRow: (threadKey: string, node: HTMLAnchorElement | null) => void;
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedOwnerProjectId: string;
  setLayoutError: (message: string) => void;
  showProjectEyebrow: boolean;
  updateProjectLayout: (logicalProjectId: WorkbenchLogicalProject["id"],
    intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[1]) => Promise<boolean>;
}

function targetForEntry(entry: ListedEntry): ListedTarget {
  return entry.entryKind === "draft"
    ? { draftId: entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

export function targetForRowEntry(entry: ThreadListRowEntry): ListedTarget {
  if ("entry" in entry) return targetForEntry(entry.entry);
  const { ref } = entry.slot;
  return ref.kind === "draft"
    ? { draftId: DraftIdSchema.parse(ref.draftId), kind: "draft" }
    : { harness: ref.identity.harness, kind: "provider", threadId: ref.identity.threadId };
}

/**
 * A listed slot reads its own member and row. A folder-sidebar entry already carries its row; on the attached daemon it
 * may also be a listed row, which says whether it is only observed.
 */
function useRowFacts(listEntry: ThreadListRowEntry, logical: boolean, attachedDaemonId: string | null) {
  const listed = useThreads.row("slot" in listEntry || logical ? listEntry.threadKey : "");
  const physical = useThreads.physicalRow("entry" in listEntry && !logical && attachedDaemonId
    ? `${attachedDaemonId}:${listEntry.threadKey}` : "");
  if ("entry" in listEntry) {
    return { entry: listEntry.entry as ListedEntry | null, qualified: logical ? listed.row : physical, member: null };
  }
  const loaded = listed.row;
  const entry = loaded && loaded.entry.entryKind !== "subagent" ? loaded.entry : null;
  return { entry, qualified: entry ? loaded : null, member: listed.member };
}

export default function WorkbenchThreadListRow({
  context, listEntry, placementFolder = null, placementSection, presentation = "row", reorderSection,
}: {
  context: ThreadListRowContext;
  listEntry: ThreadListRowEntry;
  placementFolder?: PlacementFolder | null;
  placementSection?: WorkbenchThreadDragSection | "archived";
  /** A folder's hover preview lists its rows without actions or drag. */
  presentation?: "row" | "preview";
  reorderSection?: WorkbenchThreadDisplaySection;
}) {
  const { entry, qualified, member } = useRowFacts(listEntry, Boolean(context.logicalProjects), context.attachedDaemonId);
  const attentionLabel = useThread.attention(entry && entry.entryKind !== "draft" ? entry.identity.threadId : null);
  const activeDragPayload = useWorkbenchDrag.activePayload();
  const { threadKey, projectId: entryProjectId } = listEntry;
  const ctx = context;
  const project = ctx.projectsById.get(entryProjectId) ?? null;
  if (!project && (ctx.showProjectEyebrow || presentation === "preview")) return null;
  const target = targetForRowEntry(listEntry);

  if (!entry) {
    if (!member) return null;
    const logicalProject = ctx.logicalProjects?.find(item => item.id === member.logicalProjectId);
    const sourceProjectId = member.location.projectId;
    return (
      <WorkbenchPendingThreadListItem
        activityAt={member.activityAt}
        contextMenu={presentation === "row" && member.ref.kind === "thread"
          ? ctx.actions.getPendingThreadContextMenu(member.ref.identity.threadId, member.title) : null}
        href={ctx.getThreadHref ? ctx.getThreadHref(target, sourceProjectId) : ctx.projectHref(target.kind === "provider"
          ? createLogicalExistingThreadRoute(null, target)
          : createLogicalThreadRoute(null, LogicalProjectIdSchema.parse(entryProjectId), member.location, target))}
        project={ctx.showProjectEyebrow ? logicalProject ?? project ?? undefined : undefined}
        title={member.title}
      />
    );
  }

  const logicalProject = qualified && ctx.logicalProjects?.find(item => item.id === qualified.logicalProjectId);
  const sourceProjectId = qualified?.location.projectId ?? ProjectIdSchema.parse(entryProjectId);
  const href = ctx.getThreadHref ? ctx.getThreadHref(target, sourceProjectId) : ctx.projectHref(qualified
    ? target.kind === "provider"
      ? createLogicalExistingThreadRoute(null, target)
      : createLogicalThreadRoute(null, qualified.logicalProjectId, qualified.location, target)
    : createHomeThreadRoute(entryProjectId, target));
  const eyebrow = ctx.showProjectEyebrow ? logicalProject ?? project ?? undefined : undefined;

  if (presentation === "preview") {
    return (
      <WorkbenchThreadListItem
        compact={false}
        dimmedOverride={false}
        entry={entry}
        href={href}
        project={eyebrow}
        projectId={sourceProjectId}
        projectSource={qualified?.location}
        showPinPriorityIcon
        showTooltip={false}
        tabIndex={-1}
      />
    );
  }

  const projectSourceKey = getWorkbenchThreadDisplayKey(entry);
  const frozenSection = placementSection ?? reorderSection ?? (entry.metadata.pinned ? "pinned" : "main");
  const dragSection: WorkbenchThreadDragSection = frozenSection === "archived" ? "main" : frozenSection;
  const archived = frozenSection === "archived";
  const targetIdentity = entry.entryKind === "thread" ? entry.identity : null;
  const targetReady = entry.entryKind === "thread"
    && entry.lifecycle.kind === "completed"
    && !(entry.gitArc?.claimedPaths.length);
  const folderDropEnabled = Boolean(
    isWorkbenchThreadRowDragPayload(activeDragPayload)
    && targetIdentity
    && reorderSection
    && activeDragPayload.ownerProjectId === entryProjectId
    && (reorderSection !== "settled" || activeDragPayload.section === "settled"),
  );
  const readOnly = Boolean(qualified?.observedOnly);
  const rowActionDragTargets = archived || readOnly ? null : (
    <WorkbenchThreadDragTargets
      activePayload={activeDragPayload}
      folderLabel={placementFolder ? `add to ${placementFolder.title}` : "create folder"}
      onFolderDrop={folderDropEnabled && reorderSection
        ? (payload) => {
          if (ctx.logicalProjects && qualified) {
            const source = ctx.readRowForPayload(payload);
            if (source?.logicalProjectId !== qualified.logicalProjectId) {
              ctx.setLayoutError("A folder cannot combine different project identities.");
              return;
            }
            void ctx.updateProjectLayout(qualified.logicalProjectId, {
              kind: "drop", section: reorderSection, sourceKey: payload.projectSourceKey,
              targetKey: projectSourceKey, destinationFolderId: placementFolder?.folderId ?? null,
            });
          } else if (!ctx.logicalProjects) {
            ctx.actions.onProjectFolderDrop(
              payload, sourceProjectId, projectSourceKey, reorderSection, placementFolder?.folderId ?? null,
            );
          }
        }
        : undefined}
      onSnoozeUntilDrop={targetIdentity
        ? (payload) => {
          if (!ctx.logicalProjects) {
            ctx.actions.onSnoozeUntil(payload, sourceProjectId, targetIdentity);
            return;
          }
          const source = ctx.readRowForPayload(payload);
          if (!source || !qualified || payload.target.target.kind !== "provider") {
            ctx.setLayoutError("Dependent snooze needs two existing threads.");
            return;
          }
          void ctx.controls?.threadAction(payload.target.target.threadId, {
            kind: "snoozeUntil", targetThreadId: targetIdentity.threadId,
          }).catch(error => {
            const message = error instanceof Error ? error.message.slice(0, 500) : "Dependent snooze failed.";
            ctx.setLayoutError(message);
            console.error("Dependent snooze failed", message);
          });
        }
        : undefined}
      targetIdentity={targetIdentity}
      targetProjectId={ProjectIdSchema.parse(entryProjectId)}
      targetReady={targetReady}
      targetTitle={entry.title}
    />
  );
  const feedbackDropTarget = readOnly || !ctx.onAttachFeedback ? null : (
    <WorkbenchThreadComposerDropTarget
      activePayload={activeDragPayload}
      onDrop={({ reference }) => {
        void ctx.onAttachFeedback?.(ProjectIdSchema.parse(entryProjectId), target, reference).catch(error => {
          const message = error instanceof Error ? error.message.slice(0, 500) : "Unable to attach feedback.";
          ctx.setLayoutError(message);
          console.error("Unable to attach feedback", message);
        });
      }}
      title={entry.title}
    />
  );
  const dragTargets = rowActionDragTargets || feedbackDropTarget
    ? <>{rowActionDragTargets}{feedbackDropTarget}</>
    : null;
  const selected = isWorkbenchThreadTargetSelected(target, ctx.currentTarget);
  const renderRow = ({ draggable, onDragStart, onPointerDown }: {
    draggable: false;
    onDragStart: DragEventHandler<HTMLElement>;
    onPointerDown: PointerEventHandler<HTMLElement>;
  }) => (
    <WorkbenchThreadListItem
      anchorRef={(node: HTMLAnchorElement | null) => ctx.registerRow(threadKey, node)}
      attentionLabel={attentionLabel}
      compact={false}
      contextMenu={readOnly ? null : qualified
        ? ctx.actions.getThreadContextMenuFor(entry, "project")
        : ctx.logicalProjects ? null : ctx.actions.getThreadContextMenu(entry, sourceProjectId, "project")}
      draggable={draggable && !readOnly}
      dragTargets={dragTargets}
      entry={entry}
      href={href}
      isDragActive={Boolean(activeDragPayload)}
      isShiftPressed={ctx.isShiftPressed}
      onKeyDown={(event) => ctx.focusRow(event, threadKey)}
      onAction={(action) => readOnly ? undefined : qualified
        ? ctx.actions.onActionFor(entry, action)
        : ctx.actions.onAction(entry, action, sourceProjectId)}
      onDragStart={readOnly ? undefined : onDragStart}
      onPointerDown={readOnly ? undefined : onPointerDown}
      project={eyebrow}
      projectId={sourceProjectId}
      projectSource={qualified?.location}
      role="tab"
      selected={entryProjectId === ctx.selectedOwnerProjectId && selected}
      showActions={!readOnly}
      showPinPriorityIcon
      tabIndex={selected || (!ctx.hasSelectedEntry && ctx.firstThreadKey === threadKey) ? 0 : -1}
      tooltipDetails={ctx.renderThreadTooltipDetails?.(entry)}
    />
  );
  return (
    <Draggable
      disabled={archived || readOnly}
      dropTargetIds={[
        ...(ctx.homeDisplayOrderSupported ? [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID] : []),
        WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
        WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
        ...(ctx.allowMainPanelDrop ? [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID] : []),
      ]}
      label={entry.title}
      payload={archived || readOnly
        ? { target: { kind: "thread", target }, type: "panel-target" }
        : {
          ownerProjectId: ProjectIdSchema.parse(entryProjectId),
          projectSourceKey,
          section: dragSection,
          sourceKey: threadKey,
          target: { kind: "thread", target },
          type: "home-thread-row",
          waitingOnThreadIds: entry.entryKind === "thread"
            ? entry.waitingOnThreads?.map(wait => wait.identity.threadId) ?? [] : [],
        }}
    >
      {renderRow}
    </Draggable>
  );
}
