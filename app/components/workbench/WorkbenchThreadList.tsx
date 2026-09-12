/*
 * Exports:
 * - default WorkbenchThreadList: render project-owned main, snoozed, and settled threads with optional pinned priority rows.
 */
"use client";

import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import {
  canMoveWorkbenchThreadRowToSection,
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_MAIN_PANEL_DROP_TARGET_ID,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadDragSection,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import {
  findWorkbenchThreadFolder,
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadFolderKey,
  projectWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayItem,
  type WorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import {
  groupWorkbenchThreadSidebarEntries,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadPriority,
  type WorkbenchThreadRouteTarget as WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import { isWorkbenchThreadTargetSelected } from "workbench-shared/workbench/navigation/workbench-route";
import type { FolderId, ProjectId, ThreadDisplayKey, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import { SparkleIcon } from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadDragTargets from "./WorkbenchThreadDragTargets";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchThreadPriorityDropZone from "./WorkbenchThreadPriorityDropZone";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";

const SETTLED_THREAD_PAGE_SIZE = 50;
const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;

function targetForEntry(entry: WorkbenchThreadSidebarEntry): import("workbench-shared/workbench/thread/thread-state").WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function itemKey(item: WorkbenchThreadDisplayItem) {
  return item.itemKind === "folder" ? getWorkbenchThreadFolderKey(item.folder.folderId) : getWorkbenchThreadDisplayKey(item.entry);
}

function itemThreadCount(item: WorkbenchThreadDisplayItem) {
  return item.itemKind === "folder" ? item.entries.length : 1;
}

export default function WorkbenchThreadList({
  allowMainPanelDrop = false,
  attentionLabelsByThreadId = {},
  autoFocusFolderId = null,
  createThreadLabel = "Create new thread",
  currentTarget,
  displayOrder = {},
  getThreadContextMenu,
  entries,
  getThreadHref,
  activeDragPayload = null,
  nowMs = Date.now(),
  onAction,
  onAutoFocusFolderComplete,
  onCreateThread,
  onCreateThreadPointerDragStart,
  onMove,
  onOpenThread,
  onProjectFolderDrop,
  onRenameFolder,
  onSetPriority,
  onSnoozeUntil,
  projectId,
  renderThreadTooltipDetails,
  showPinnedThreadsInMain = false,
}: {
  allowMainPanelDrop?: boolean;
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  autoFocusFolderId?: string | null;
  createThreadLabel?: string;
  currentTarget: WorkbenchThreadTarget | null;
  displayOrder?: WorkbenchThreadDisplayOrder;
  entries: WorkbenchThreadSidebarEntry[];
  getThreadHref: (target: WorkbenchThreadTarget, ownerProjectId?: string) => string;
  getThreadContextMenu?: (entry: WorkbenchThreadSidebarEntry, ownerProjectId: ProjectId, folderScope?: "pinned" | "project") => WorkbenchContextMenuDefinition | null;
  activeDragPayload?: WorkbenchDragPayload | null;
  nowMs?: number;
  onAction?: (entry: WorkbenchThreadSidebarEntry, action: import("./thread-row-actions").ThreadRowAction, ownerProjectId: ProjectId) => void;
  onAutoFocusFolderComplete?: () => void;
  onCreateThread: (folderId?: FolderId) => void;
  onCreateThreadPointerDragStart?: (event: import("react").PointerEvent<HTMLAnchorElement>) => void;
  onMove?: (sourceKey: ThreadDisplayKey, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null, beforeKey: string | null) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  onProjectFolderDrop?: (payload: WorkbenchThreadRowDragPayload, targetKey: ThreadDisplayKey, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null) => void;
  onRenameFolder?: (folderId: string, title: string) => Promise<string>;
  onSetPriority?: (payload: WorkbenchThreadRowDragPayload, priority: WorkbenchThreadPriority) => void;
  onSnoozeUntil?: (payload: WorkbenchThreadRowDragPayload, targetIdentity: { harness: "codex" | "copilot" | "opencode"; threadId: WorkbenchThreadId }) => void;
  projectId: ProjectId;
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  showPinnedThreadsInMain?: boolean;
}) {
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const groupedEntries = groupWorkbenchThreadSidebarEntries(entries);
  const pinnedItems = showPinnedThreadsInMain
    ? projectWorkbenchThreadDisplaySection(entries, displayOrder, "pinned")
    : [];
  const mainEntries = groupedEntries.mainEntries;
  const snoozedItems = projectWorkbenchThreadDisplaySection(entries, displayOrder, "snoozed");
  const settledItems = projectWorkbenchThreadDisplaySection(entries, displayOrder, "settled");
  const historyItems: WorkbenchThreadDisplayItem[] = [
    ...settledItems,
    ...groupedEntries.archivedEntries.map(entry => ({ entry, itemKind: "thread" as const })),
  ];
  const isShiftPressed = useNonTextInputShiftKey();
  const {
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setSettledThreadItemLimit,
  } = useWorkbenchSidebarPreferences();
  const displayedHistoryItems = historyItems.slice(0, preferences.settledThreadItemLimit);
  const remainingHistoryThreadCount = historyItems.slice(preferences.settledThreadItemLimit).reduce((total, item) => total + itemThreadCount(item), 0);
  const nextHistoryItemCount = Math.min(SETTLED_THREAD_PAGE_SIZE, historyItems.length - displayedHistoryItems.length);
  const nextHistoryThreadCount = historyItems.slice(
    preferences.settledThreadItemLimit,
    preferences.settledThreadItemLimit + nextHistoryItemCount,
  ).reduce((total, item) => total + itemThreadCount(item), 0);
  const visibleEntriesForItems = (items: WorkbenchThreadDisplayItem[]) => items.flatMap((item) => item.itemKind === "folder"
    ? preferences.threadFolderIds.includes(item.folder.folderId) ? item.entries : []
    : [item.entry]);
  const primaryEntries = [...visibleEntriesForItems(pinnedItems), ...mainEntries, ...visibleEntriesForItems(snoozedItems)];
  const navigableEntries = preferences.settledThreadsOpen ? [...primaryEntries, ...visibleEntriesForItems(displayedHistoryItems)] : primaryEntries;
  const hasSelectedEntry = navigableEntries.some((entry) => isWorkbenchThreadTargetSelected(targetForEntry(entry), currentTarget));
  const isDragActive = Boolean(activeDragPayload);
  const moveFocus = (event: ReactKeyboardEvent<HTMLAnchorElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(navigableEntries.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = navigableEntries.length - 1;
    else return;
    event.preventDefault();
    const nextEntry = navigableEntries[next];
    if (nextEntry) rowRefs.current.get(getWorkbenchThreadDisplayKey(nextEntry))?.focus();
  };
  const renderEntry = (
    entry: WorkbenchThreadSidebarEntry,
    reorderSection: WorkbenchThreadDisplaySection | null = null,
    dimmedOverride?: boolean,
    asTab = true,
  ) => {
    const index = navigableEntries.indexOf(entry);
    const target = targetForEntry(entry);
    const selected = isWorkbenchThreadTargetSelected(target, currentTarget);
    const displayKey = getWorkbenchThreadDisplayKey(entry);
    const dragSection: WorkbenchThreadDragSection = reorderSection
      ?? (entry.entryKind !== "subagent" && entry.metadata.pinned ? "pinned" : "main");
    const folder = reorderSection ? findWorkbenchThreadFolder(displayOrder, displayKey) : null;
    const targetIdentity = entry.entryKind === "thread" ? entry.identity : null;
    const targetReady = entry.entryKind === "thread"
      && entry.lifecycle.kind === "completed"
      && !(entry.gitArc?.claimedPaths.length);
    const folderDropEnabled = Boolean(
      isWorkbenchThreadRowDragPayload(activeDragPayload)
      && targetIdentity
      && reorderSection
      && activeDragPayload.ownerProjectId === projectId
      && (reorderSection !== "settled" || activeDragPayload.section === "settled"),
    );
    const archived = entry.entryKind === "thread" && entry.metadata.archived;
    const dragTargets = archived ? null : (
      <WorkbenchThreadDragTargets
        activePayload={activeDragPayload}
        folderLabel={folder ? `add to ${folder.title}` : "create folder"}
        onFolderDrop={folderDropEnabled && reorderSection && onProjectFolderDrop
          ? (payload) => onProjectFolderDrop(payload, displayKey, reorderSection, folder?.folderId ?? null)
          : undefined}
        onSnoozeUntilDrop={targetIdentity && !targetReady && onSnoozeUntil
          ? (payload) => onSnoozeUntil(payload, targetIdentity)
          : undefined}
        targetIdentity={targetIdentity}
        targetProjectId={projectId}
        targetTitle={entry.title}
      />
    );
    const renderRow = ({ draggable, onDragStart, onPointerDown }: {
      draggable: false;
      onDragStart: import("react").DragEventHandler<HTMLElement>;
      onPointerDown: import("react").PointerEventHandler<HTMLElement>;
    }) => {
      const sharedProps = {
        anchorRef: (node: HTMLAnchorElement | null) => { if (node) rowRefs.current.set(displayKey, node); else rowRefs.current.delete(displayKey); },
        attentionLabel: entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId],
        contextMenu: getThreadContextMenu?.(entry, projectId, "project") ?? null,
        dimmedOverride,
        entry,
        isShiftPressed,
        nowMs,
        onAction: (action: import("./thread-row-actions").ThreadRowAction) => onAction?.(entry, action, projectId),
        onActivate: (activatedTarget: WorkbenchThreadTarget) => onOpenThread(activatedTarget),
        onDragStart: (event: import("react").DragEvent<HTMLAnchorElement>) => onDragStart(event),
        onKeyDown: (event: ReactKeyboardEvent<HTMLAnchorElement>) => moveFocus(event, index),
        onPointerDown: (event: import("react").PointerEvent<HTMLAnchorElement>) => onPointerDown(event),
        projectId,
        selected,
        showActions: true,
        showPinPriorityIcon: showPinnedThreadsInMain,
        tooltipDetails: renderThreadTooltipDetails?.(entry),
      };
      return asTab ? (
        <WorkbenchThreadListItem
          {...sharedProps}
          draggable={draggable}
          dragTargets={dragTargets}
          href={getThreadHref(target)}
          isDragActive={isDragActive}
          role="tab"
          tabIndex={selected || (!hasSelectedEntry && index === 0) ? 0 : -1}
        />
      ) : (
        <WorkbenchThreadListItem
          {...sharedProps}
          draggable={draggable}
          dragTargets={dragTargets}
          href={getThreadHref(target)}
          isDragActive={isDragActive}
        />
      );
    };
    const rowDragEnabled = entry.entryKind !== "subagent" && !archived;
    const dropTargetIds = rowDragEnabled
      ? [
          ...(onMove ? [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID] : []),
          WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
          WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
          ...(allowMainPanelDrop ? [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID] : []),
        ]
      : allowMainPanelDrop
        ? [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID]
        : [];
    return (
      <Draggable
        disabled={dropTargetIds.length === 0}
        dropTargetIds={dropTargetIds}
        key={displayKey}
        label={entry.title}
        payload={rowDragEnabled
          ? {
              ownerProjectId: projectId,
              projectSourceKey: displayKey,
              section: dragSection,
              sourceKey: displayKey,
              target: { kind: "thread", target },
              type: "thread-row",
            }
          : { target: { kind: "thread", target }, type: "panel-target" }}
      >
        {renderRow}
      </Draggable>
    );
  };

  const renderDropMarker = (
    key: string,
    section: WorkbenchThreadDisplaySection,
    destinationFolderId: string | null,
  ) => (
    <DropTarget
      as="li"
      className="m-0 list-none"
      dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
      key={`before:${destinationFolderId ?? "root"}:${key}`}
      range={THREAD_ORDER_DROP_RANGE}
      enabled={(payload) => isWorkbenchThreadRowDragPayload(payload)
        ? canMoveWorkbenchThreadRowToSection(payload, section, projectId)
        : payload.type === "thread-folder"
          && payload.section === section
          && destinationFolderId === null}
      onDrop={(payload) => {
        if (isWorkbenchThreadRowDragPayload(payload)) onMove?.(payload.projectSourceKey, section, destinationFolderId, key || null);
        else if (payload.type === "thread-folder") onMove?.(payload.sourceKey, section, destinationFolderId, key || null);
      }}
      preview={(payload) => isWorkbenchThreadRowDragPayload(payload) && section !== "settled"
        ? { action: section, label: `move to ${section}` }
        : null}
    >
      {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-30 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} data-thread-insertion-target={section} />}
    </DropTarget>
  );

  const renderFolderEntries = (item: Extract<WorkbenchThreadDisplayItem, { itemKind: "folder" }>) => (
    <DropTargetBoundary className="min-w-0 px-1">
      <ul className="m-0 flex flex-col gap-0.5 p-0">
        {item.entries.flatMap((entry) => {
          const key = getWorkbenchThreadDisplayKey(entry);
          return [
            renderDropMarker(key, item.folder.section, item.folder.folderId),
            renderEntry(entry, item.folder.section, item.folder.section === "snoozed" ? false : undefined),
          ];
        })}
        {renderDropMarker("", item.folder.section, item.folder.folderId)}
      </ul>
    </DropTargetBoundary>
  );

  const renderFolderTooltip = (item: Extract<WorkbenchThreadDisplayItem, { itemKind: "folder" }>) => (
    <ul className="m-0 flex w-[min(28rem,calc(100vw-2rem))] max-w-full list-none flex-col gap-0.5 p-0">
      {item.entries.map((entry) => {
        const target = targetForEntry(entry);
        return (
          <WorkbenchThreadListItem
            attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
            compact={false}
            dimmedOverride={false}
            entry={entry}
            href={getThreadHref(target)}
            key={`tooltip:${getWorkbenchThreadDisplayKey(entry)}`}
            nowMs={nowMs}
            onActivate={onOpenThread}
            projectId={projectId}
            showTooltip={false}
            tabIndex={-1}
          />
        );
      })}
    </ul>
  );

  const renderFolderCreateThread = (folderId: FolderId) => {
    const target = { folderId, kind: "new" as const };
    const selected = isWorkbenchThreadTargetSelected(target, currentTarget);
    return (
      <a
        href={getThreadHref(target)}
        title={createThreadLabel}
        aria-current={selected ? "page" : undefined}
        className={`
          ${workbenchOptionRowClassName} min-h-9 w-full md:min-h-8
          ${selected ? `${workbenchOptionSelectedClassName} text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
        `}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread(folderId);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="shrink-0" size={16} />
          <span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a>
    );
  };

  const renderReorderableSection = (items: WorkbenchThreadDisplayItem[], section: WorkbenchThreadDisplaySection) => (
    <ul className="m-0 flex flex-col gap-0.5 p-0">
      {items.flatMap((item) => {
        const key = itemKey(item);
        return [
          renderDropMarker(key, section, null),
          item.itemKind === "folder" ? (
            <li className="m-0 list-none" key={key}>
              <WorkbenchThreadFolder
                activeDragPayload={activeDragPayload}
                autoFocusName={autoFocusFolderId === item.folder.folderId}
                attentionLabelsByThreadId={attentionLabelsByThreadId}
                canPrependThread={(payload) => canMoveWorkbenchThreadRowToSection(payload, section, projectId)
                  && !item.folder.threadKeys.includes(payload.projectSourceKey)}
                entries={item.entries}
                folder={item.folder}
                isDragActive={isDragActive}
                nowMs={nowMs}
                onAutoFocusComplete={onAutoFocusFolderComplete}
                onOpenChange={(nextOpen) => setFolderOpen("threads", item.folder.folderId, nextOpen)}
                onPrependThread={(payload) => onMove?.(
                  payload.projectSourceKey,
                  section,
                  item.folder.folderId,
                  item.folder.threadKeys[0] ?? null,
                )}
                onRename={(title) => onRenameFolder ? onRenameFolder(item.folder.folderId, title) : Promise.resolve(item.folder.title)}
                open={preferences.threadFolderIds.includes(item.folder.folderId)}
                tooltip={renderFolderTooltip(item)}
              >
                {section === "settled" ? null : renderFolderCreateThread(item.folder.folderId)}
                {renderFolderEntries(item)}
              </WorkbenchThreadFolder>
            </li>
          ) : renderEntry(item.entry, section),
        ];
      })}
      {renderDropMarker("", section, null)}
    </ul>
  );

  const blankThreadSelected = isWorkbenchThreadTargetSelected({ kind: "new" }, currentTarget);
  const priorityTarget = (priority: WorkbenchThreadPriority) => onSetPriority ? (
    <WorkbenchThreadPriorityDropZone
      activePayload={activeDragPayload}
      onDrop={(payload) => onSetPriority(payload, priority)}
      priority={priority}
    />
  ) : null;
  return (
    <DropTargetBoundary className="space-y-1">
      <a
        href={getThreadHref({ kind: "new" })}
        title={createThreadLabel}
        aria-current={blankThreadSelected ? "page" : undefined}
        className={`
          ${workbenchOptionRowClassName} mt-1 min-h-9 w-full md:min-h-8
          ${blankThreadSelected ? `${workbenchOptionSelectedClassName} text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
        `}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onCreateThreadPointerDragStart?.(event);
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="shrink-0" size={16} />
          <span className={`${workbenchThreadListLabelClassName}${blankThreadSelected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a>
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {showPinnedThreadsInMain
          ? pinnedItems.length
            ? renderReorderableSection(pinnedItems, "pinned")
            : priorityTarget("pinned")
          : null}
        {priorityTarget("main")}
        {mainEntries.length
          ? <ul className="m-0 flex flex-col gap-1 p-0">{mainEntries.map((entry) => renderEntry(entry))}</ul>
          : null}
        {snoozedItems.length ? renderReorderableSection(snoozedItems, "snoozed") : priorityTarget("snoozed")}
        {historyItems.length ? (
          <ThreadDisclosure
            className="mt-4"
            contentClassName="mt-1"
            open={preferences.settledThreadsOpen}
            onToggle={(event) => setDisclosureOpen("settledThreadsOpen", event.currentTarget.open)}
            summary="Settled threads"
            summaryClassName="text-[0.72rem] font-medium leading-[1.5] text-fg/muted"
          >
            {renderReorderableSection(displayedHistoryItems.filter(item => item.itemKind === "folder" || item.entry.entryKind !== "thread" || !item.entry.metadata.archived), "settled")}
            {displayedHistoryItems.some(item => item.itemKind === "thread" && item.entry.entryKind === "thread" && item.entry.metadata.archived) ? (
              <h3 className="mt-4 mb-1 text-[0.72rem] font-medium text-fg/muted">Archived threads</h3>
            ) : null}
            <ul className="m-0 flex flex-col gap-1 p-0">
              {displayedHistoryItems.flatMap(item => item.itemKind === "thread" && item.entry.entryKind === "thread" && item.entry.metadata.archived ? [renderEntry(item.entry)] : [])}
            </ul>
            {remainingHistoryThreadCount > 0 ? (
              <button type="button" aria-label={`Load ${nextHistoryThreadCount} more historical threads`} className={`${workbenchThreadListButtonClassName} mt-1 justify-center text-center text-[0.72rem] font-medium text-fg/muted`} onClick={() => setSettledThreadItemLimit(preferences.settledThreadItemLimit + nextHistoryItemCount)}>
                Load {nextHistoryThreadCount} more
              </button>
            ) : null}
          </ThreadDisclosure>
        ) : null}
      </div>
    </DropTargetBoundary>
  );
}
