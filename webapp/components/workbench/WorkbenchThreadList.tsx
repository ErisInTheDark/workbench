/*
 * Exports:
 * - default WorkbenchThreadList: orchestrate grouped sidebar thread navigation, actions, pagination, and shared row rendering. Keywords: workbench, threads, sidebar, context menu.
 */
"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { WORKBENCH_MAIN_PANEL_DROP_TARGET_ID, WORKBENCH_THREAD_ORDER_DROP_TARGET_ID } from "../../lib/workbench/layout/workbench-drag";
import { getWorkbenchThreadDisplayKey, getWorkbenchThreadDisplaySection, type WorkbenchThreadDisplaySection } from "../../lib/workbench/thread/thread-display-order";
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

export default function WorkbenchThreadList({
  attentionLabelsByThreadId = {},
  createThreadLabel = "Create new thread",
  currentTarget,
  getThreadContextMenu,
  entries,
  getThreadHref,
  isDragActive = false,
  nowMs = Date.now(),
  onAction,
  onCreateThread,
  onCreateThreadPointerDragStart,
  onOpenThread,
  onReorder,
  projectId,
}: {
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  createThreadLabel?: string;
  currentTarget: WorkbenchThreadTarget | null;
  entries: WorkbenchThreadSidebarEntry[];
  getThreadHref: (target: WorkbenchThreadTarget) => string;
  getThreadContextMenu?: (entry: WorkbenchThreadSidebarEntry) => WorkbenchContextMenuDefinition | null;
  isDragActive?: boolean;
  nowMs?: number;
  onAction?: (entry: WorkbenchThreadSidebarEntry, action: "complete" | "discard" | "restore" | "settle" | "wake") => void;
  onCreateThread: () => void;
  onCreateThreadPointerDragStart?: (event: import("react").PointerEvent<HTMLAnchorElement>) => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  onReorder?: (sourceKey: string, section: WorkbenchThreadDisplaySection, beforeKey: string | null) => void;
  projectId: string;
}) {
  const rowRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const { mainEntries, pinnedEntries, settledEntries, snoozedEntries } = groupWorkbenchThreadSidebarEntries(entries);
  const settledPinnedEntries = settledEntries.filter((entry) => getWorkbenchThreadDisplaySection(entry) === "settledPinned");
  const settledNaturalEntries = settledEntries.filter((entry) => getWorkbenchThreadDisplaySection(entry) !== "settledPinned");
  const [isOlderThreadsOpen, setIsOlderThreadsOpen] = useState(false);
  const [settledEntryLimit, setSettledEntryLimit] = useState(SETTLED_THREAD_PAGE_SIZE);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
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
  const displayedSettledEntries = [...settledPinnedEntries, ...settledNaturalEntries].slice(0, settledEntryLimit);
  const remainingSettledEntryCount = settledEntries.length - displayedSettledEntries.length;
  const nextSettledEntryCount = Math.min(SETTLED_THREAD_PAGE_SIZE, remainingSettledEntryCount);
  const primaryEntries = [...pinnedEntries, ...mainEntries, ...snoozedEntries];
  const navigableEntries = isOlderThreadsOpen ? [...primaryEntries, ...displayedSettledEntries] : primaryEntries;
  const hasSelectedEntry = navigableEntries.some((entry) => isWorkbenchThreadTargetSelected(targetForEntry(entry), currentTarget));
  const moveFocus = (event: ReactKeyboardEvent<HTMLAnchorElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(navigableEntries.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = navigableEntries.length - 1;
    else return;
    event.preventDefault();
    rowRefs.current[next]?.focus();
  };
  const renderEntry = (entry: WorkbenchThreadSidebarEntry, reorderSection: WorkbenchThreadDisplaySection | null = null) => {
    const index = navigableEntries.indexOf(entry);
    const target = targetForEntry(entry);
    const selected = isWorkbenchThreadTargetSelected(target, currentTarget);
    const renderRow = ({ draggable, onDragStart, onPointerDown }: {
      draggable: false;
      onDragStart: import("react").DragEventHandler<HTMLElement>;
      onPointerDown: import("react").PointerEventHandler<HTMLElement>;
    }) => (
      <WorkbenchThreadListItem
        anchorRef={(node) => { if (index >= 0) rowRefs.current[index] = node; }}
        attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
        contextMenu={getThreadContextMenu?.(entry) ?? null}
        draggable={draggable}
        entry={entry}
        href={getThreadHref(target)}
        isDragActive={isDragActive}
        isShiftPressed={isShiftPressed}
        key={entry.entryKind === "draft" ? `draft:${entry.draft.draftId}` : `${entry.identity.harness}:${entry.identity.threadId}`}
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
    const sourceKey = getWorkbenchThreadDisplayKey(entry);
    return (
      <Draggable
        dropTargetIds={reorderSection ? [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID, WORKBENCH_MAIN_PANEL_DROP_TARGET_ID] : [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID]}
        key={sourceKey}
        label={entry.title}
        payload={reorderSection
          ? { section: reorderSection, sourceKey, target: { kind: "thread", target }, type: "thread-row" }
          : { target: { kind: "thread", target }, type: "panel-target" }}
      >
        {renderRow}
      </Draggable>
    );
  };

  const renderReorderableSection = (sectionEntries: WorkbenchThreadSidebarEntry[], section: WorkbenchThreadDisplaySection) => (
    <DropTargetBoundary className="min-w-0">
      <ul className="m-0 flex flex-col gap-1 p-0">
        {sectionEntries.flatMap((entry) => {
          const key = getWorkbenchThreadDisplayKey(entry);
          return [
            <DropTarget
              as="li"
              className="m-0 list-none"
              dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
              key={`before:${key}`}
              range={THREAD_ORDER_DROP_RANGE}
              enabled={(payload) => payload.type === "thread-row" && payload.section === section}
              onDrop={(payload) => { if (payload.type === "thread-row") onReorder?.(payload.sourceKey, section, key); }}
            >
              {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-10 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} />}
            </DropTarget>,
            renderEntry(entry, section),
          ];
        })}
        <DropTarget
          as="li"
          className="m-0 list-none"
          dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
          range={THREAD_ORDER_DROP_RANGE}
          enabled={(payload) => payload.type === "thread-row" && payload.section === section}
          onDrop={(payload) => { if (payload.type === "thread-row") onReorder?.(payload.sourceKey, section, null); }}
        >
          {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-10 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} />}
        </DropTarget>
      </ul>
    </DropTargetBoundary>
  );

  return (
    <div className="space-y-1">
      <a
        href={getThreadHref({ kind: "new" })}
        title={createThreadLabel}
        className={`${workbenchThreadListButtonClassName}${currentTarget?.kind === "new" ? " text-accent" : " text-muted"}`}
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
          <span className={`${workbenchThreadListLabelClassName}${currentTarget?.kind === "new" ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a>
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {pinnedEntries.length ? renderReorderableSection(pinnedEntries, "pinned") : null}
        {mainEntries.length ? <ul className="m-0 flex flex-col gap-1 p-0">{mainEntries.map((entry) => renderEntry(entry))}</ul> : null}
        {snoozedEntries.length ? renderReorderableSection(snoozedEntries, "snoozed") : null}
        {settledEntries.length ? (
          <ThreadDisclosure
            className="mt-4"
            contentClassName="mt-1"
            open={isOlderThreadsOpen}
            onToggle={(event) => setIsOlderThreadsOpen(event.currentTarget.open)}
            summary="Settled threads"
            summaryClassName="text-[0.72rem] font-medium leading-[1.5] text-muted"
          >
            {settledPinnedEntries.length ? renderReorderableSection(displayedSettledEntries.filter((entry) => getWorkbenchThreadDisplaySection(entry) === "settledPinned"), "settledPinned") : null}
            {displayedSettledEntries.some((entry) => getWorkbenchThreadDisplaySection(entry) !== "settledPinned") ? (
              <ul className="m-0 flex flex-col gap-1 p-0">{displayedSettledEntries.filter((entry) => getWorkbenchThreadDisplaySection(entry) !== "settledPinned").map((entry) => renderEntry(entry))}</ul>
            ) : null}
            {remainingSettledEntryCount > 0 ? (
              <button type="button" aria-label={`Load ${nextSettledEntryCount} more settled threads`} className={`${workbenchThreadListButtonClassName} mt-1 justify-center text-center text-[0.72rem] font-medium text-muted`} onClick={() => setSettledEntryLimit((current) => current + SETTLED_THREAD_PAGE_SIZE)}>
                Load {nextSettledEntryCount} more
              </button>
            ) : null}
          </ThreadDisclosure>
        ) : null}
      </div>
    </div>
  );
}
