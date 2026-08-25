/*
 * Exports:
 * - default WorkbenchThreadList: orchestrate mixed thread and folder sidebar navigation, actions, pagination, and drag ordering. Keywords: workbench, threads, folders, sidebar, context menu.
 * - Local helpers: derive thread targets and stable mixed-item keys and counts. Keywords: thread, folder, identity, pagination.
 */
"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { WORKBENCH_MAIN_PANEL_DROP_TARGET_ID, WORKBENCH_THREAD_ORDER_DROP_TARGET_ID } from "../../lib/workbench/layout/workbench-drag";
import {
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadFolderKey,
  projectWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayItem,
  type WorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplaySection,
} from "../../lib/workbench/thread/thread-display-order";
import {
  groupWorkbenchThreadSidebarEntries,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadTarget,
} from "../../lib/workbench/thread/thread-state";
import { isWorkbenchThreadTargetSelected } from "../../lib/workbench/navigation/workbench-route";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import { SparkleIcon } from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";

const SETTLED_THREAD_PAGE_SIZE = 50;
const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;

function targetForEntry(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadTarget {
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
  attentionLabelsByThreadId = {},
  autoFocusFolderId = null,
  createThreadLabel = "Create new thread",
  currentTarget,
  displayOrder = {},
  getThreadContextMenu,
  entries,
  getThreadHref,
  isDragActive = false,
  nowMs = Date.now(),
  onAction,
  onAutoFocusFolderComplete,
  onCreateThread,
  onCreateThreadPointerDragStart,
  onMove,
  onOpenThread,
  onRenameFolder,
  projectId,
}: {
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  autoFocusFolderId?: string | null;
  createThreadLabel?: string;
  currentTarget: WorkbenchThreadTarget | null;
  displayOrder?: WorkbenchThreadDisplayOrder;
  entries: WorkbenchThreadSidebarEntry[];
  getThreadHref: (target: WorkbenchThreadTarget) => string;
  getThreadContextMenu?: (entry: WorkbenchThreadSidebarEntry) => WorkbenchContextMenuDefinition | null;
  isDragActive?: boolean;
  nowMs?: number;
  onAction?: (entry: WorkbenchThreadSidebarEntry, action: "complete" | "discard" | "restore" | "settle" | "wake") => void;
  onAutoFocusFolderComplete?: () => void;
  onCreateThread: (folderId?: string) => void;
  onCreateThreadPointerDragStart?: (event: import("react").PointerEvent<HTMLAnchorElement>) => void;
  onMove?: (sourceKey: string, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null, beforeKey: string | null) => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  onRenameFolder?: (folderId: string, title: string) => Promise<string>;
  projectId: string;
}) {
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const { mainEntries } = groupWorkbenchThreadSidebarEntries(entries);
  const pinnedItems = projectWorkbenchThreadDisplaySection(entries, displayOrder, "pinned");
  const snoozedItems = projectWorkbenchThreadDisplaySection(entries, displayOrder, "snoozed");
  const settledItems = projectWorkbenchThreadDisplaySection(entries, displayOrder, "settled");
  const [isOlderThreadsOpen, setIsOlderThreadsOpen] = useState(false);
  const [settledItemLimit, setSettledItemLimit] = useState(SETTLED_THREAD_PAGE_SIZE);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Shift") setIsShiftPressed(true); };
    const handleKeyUp = (event: KeyboardEvent) => { if (event.key === "Shift") setIsShiftPressed(false); };
    const handleBlur = () => setIsShiftPressed(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);
  const displayedSettledItems = settledItems.slice(0, settledItemLimit);
  const remainingSettledThreadCount = settledItems.slice(settledItemLimit).reduce((total, item) => total + itemThreadCount(item), 0);
  const nextSettledItemCount = Math.min(SETTLED_THREAD_PAGE_SIZE, settledItems.length - displayedSettledItems.length);
  const nextSettledThreadCount = settledItems.slice(settledItemLimit, settledItemLimit + nextSettledItemCount).reduce((total, item) => total + itemThreadCount(item), 0);
  const visibleEntriesForItems = (items: WorkbenchThreadDisplayItem[]) => items.flatMap((item) => item.itemKind === "folder"
    ? openFolderIds.has(item.folder.folderId) ? item.entries : []
    : [item.entry]);
  const primaryEntries = [...visibleEntriesForItems(pinnedItems), ...mainEntries, ...visibleEntriesForItems(snoozedItems)];
  const navigableEntries = isOlderThreadsOpen ? [...primaryEntries, ...visibleEntriesForItems(displayedSettledItems)] : primaryEntries;
  const hasSelectedEntry = navigableEntries.some((entry) => isWorkbenchThreadTargetSelected(targetForEntry(entry), currentTarget));
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
  ) => {
    const index = navigableEntries.indexOf(entry);
    const target = targetForEntry(entry);
    const selected = isWorkbenchThreadTargetSelected(target, currentTarget);
    const displayKey = getWorkbenchThreadDisplayKey(entry);
    const renderRow = ({ draggable, onDragStart, onPointerDown }: {
      draggable: false;
      onDragStart: import("react").DragEventHandler<HTMLElement>;
      onPointerDown: import("react").PointerEventHandler<HTMLElement>;
    }) => (
      <WorkbenchThreadListItem
        anchorRef={(node) => { if (node) rowRefs.current.set(displayKey, node); else rowRefs.current.delete(displayKey); }}
        attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
        contextMenu={getThreadContextMenu?.(entry) ?? null}
        dimmedOverride={dimmedOverride}
        draggable={draggable}
        entry={entry}
        href={getThreadHref(target)}
        isDragActive={isDragActive}
        isShiftPressed={isShiftPressed}
        key={displayKey}
        nowMs={nowMs}
        onAction={(action) => onAction?.(entry, action)}
        onActivate={onOpenThread}
        onDragStart={(event) => onDragStart(event)}
        onKeyDown={(event) => moveFocus(event, index)}
        onPointerDown={(event) => onPointerDown(event)}
        projectId={projectId}
        role="tab"
        selected={selected}
        showActions
        tabIndex={selected || (!hasSelectedEntry && index === 0) ? 0 : -1}
      />
    );
    return (
      <Draggable
        dropTargetIds={reorderSection ? [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID, WORKBENCH_MAIN_PANEL_DROP_TARGET_ID] : [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID]}
        key={displayKey}
        label={entry.title}
        payload={reorderSection
          ? { section: reorderSection, sourceKey: displayKey, target: { kind: "thread", target }, type: "thread-row" }
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
      enabled={(payload) => (payload.type === "thread-row" || payload.type === "thread-folder")
        && payload.section === section
        && (destinationFolderId === null || payload.type === "thread-row")}
      onDrop={(payload) => {
        if (payload.type === "thread-row" || payload.type === "thread-folder") onMove?.(payload.sourceKey, section, destinationFolderId, key || null);
      }}
    >
      {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-30 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} />}
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

  const renderFolderCreateThread = (folderId: string) => {
    const target = { folderId, kind: "new" as const };
    const selected = isWorkbenchThreadTargetSelected(target, currentTarget);
    return (
      <a
        href={getThreadHref(target)}
        title={createThreadLabel}
        className={`${workbenchThreadListButtonClassName}${selected ? " text-accent" : " text-muted"}`}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread(folderId);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="size-4 shrink-0" />
          <span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a>
    );
  };

  const renderReorderableSection = (items: WorkbenchThreadDisplayItem[], section: WorkbenchThreadDisplaySection) => (
    <DropTargetBoundary className="min-w-0">
      <ul className="m-0 flex flex-col gap-0.5 p-0">
        {items.flatMap((item) => {
          const key = itemKey(item);
          return [
            renderDropMarker(key, section, null),
            item.itemKind === "folder" ? (
              <li className="m-0 list-none" key={key}>
                <WorkbenchThreadFolder
                  autoFocusName={autoFocusFolderId === item.folder.folderId}
                  attentionLabelsByThreadId={attentionLabelsByThreadId}
                  entries={item.entries}
                  folder={item.folder}
                  isDragActive={isDragActive}
                  nowMs={nowMs}
                  onAutoFocusComplete={onAutoFocusFolderComplete}
                  onMoveThread={(sourceKey, destinationFolderId, beforeKey) => onMove?.(sourceKey, section, destinationFolderId, beforeKey)}
                  onOpenChange={(nextOpen) => setOpenFolderIds((current) => {
                    const next = new Set(current);
                    if (nextOpen) next.add(item.folder.folderId); else next.delete(item.folder.folderId);
                    return next;
                  })}
                  onRename={(title) => onRenameFolder ? onRenameFolder(item.folder.folderId, title) : Promise.resolve(item.folder.title)}
                  open={openFolderIds.has(item.folder.folderId)}
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
    </DropTargetBoundary>
  );

  const blankThreadSelected = isWorkbenchThreadTargetSelected({ kind: "new" }, currentTarget);

  return (
    <div className="space-y-1">
      <a
        href={getThreadHref({ kind: "new" })}
        title={createThreadLabel}
        className={`${workbenchThreadListButtonClassName}${blankThreadSelected ? " text-accent" : " text-muted"}`}
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
          <SparkleIcon className="size-4 shrink-0" />
          <span className={`${workbenchThreadListLabelClassName}${blankThreadSelected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a>
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {pinnedItems.length ? renderReorderableSection(pinnedItems, "pinned") : null}
        {mainEntries.length ? <ul className="m-0 flex flex-col gap-1 p-0">{mainEntries.map((entry) => renderEntry(entry))}</ul> : null}
        {snoozedItems.length ? renderReorderableSection(snoozedItems, "snoozed") : null}
        {settledItems.length ? (
          <ThreadDisclosure
            className="mt-4"
            contentClassName="mt-1"
            open={isOlderThreadsOpen}
            onToggle={(event) => setIsOlderThreadsOpen(event.currentTarget.open)}
            summary="Settled threads"
            summaryClassName="text-[0.72rem] font-medium leading-[1.5] text-muted"
          >
            {renderReorderableSection(displayedSettledItems, "settled")}
            {remainingSettledThreadCount > 0 ? (
              <button type="button" aria-label={`Load ${nextSettledThreadCount} more settled threads`} className={`${workbenchThreadListButtonClassName} mt-1 justify-center text-center text-[0.72rem] font-medium text-muted`} onClick={() => setSettledItemLimit((current) => current + nextSettledItemCount)}>
                Load {nextSettledThreadCount} more
              </button>
            ) : null}
          </ThreadDisclosure>
        ) : null}
      </div>
    </div>
  );
}
