/*
 * Exports:
 * - default WorkbenchThreadList: orchestrate grouped sidebar thread navigation, actions, pagination, and shared row rendering. Keywords: workbench, threads, sidebar, tooltip.
 */
"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from "react";

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

const SETTLED_THREAD_PAGE_SIZE = 50;

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
  nowMs = Date.now(),
  onAction,
  onCreateThread,
  onCreateThreadPointerDragStart,
  onThreadPointerDragStart,
  onOpenThread,
  projectId,
}: {
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  createThreadLabel?: string;
  currentTarget: WorkbenchThreadTarget | null;
  entries: WorkbenchThreadSidebarEntry[];
  getThreadHref: (target: WorkbenchThreadTarget) => string;
  getThreadContextMenu?: (entry: WorkbenchThreadSidebarEntry) => WorkbenchContextMenuDefinition | null;
  nowMs?: number;
  onAction?: (entry: WorkbenchThreadSidebarEntry, action: "complete" | "discard" | "restore" | "settle" | "wake") => void;
  onCreateThread: () => void;
  onCreateThreadPointerDragStart?: (event: PointerEvent<HTMLAnchorElement>) => void;
  onThreadPointerDragStart?: (event: PointerEvent<HTMLElement>, entry: WorkbenchThreadSidebarEntry) => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectId: string;
}) {
  const rowRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const { primaryEntries, settledEntries } = groupWorkbenchThreadSidebarEntries(entries);
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
  const displayedSettledEntries = settledEntries.slice(0, settledEntryLimit);
  const remainingSettledEntryCount = settledEntries.length - displayedSettledEntries.length;
  const nextSettledEntryCount = Math.min(SETTLED_THREAD_PAGE_SIZE, remainingSettledEntryCount);
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
  const renderEntry = (entry: WorkbenchThreadSidebarEntry) => {
    const index = navigableEntries.indexOf(entry);
    const target = targetForEntry(entry);
    const selected = isWorkbenchThreadTargetSelected(target, currentTarget);
    return (
      <WorkbenchThreadListItem
        anchorRef={(node) => { if (index >= 0) rowRefs.current[index] = node; }}
        attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
        contextMenu={getThreadContextMenu?.(entry) ?? null}
        entry={entry}
        href={getThreadHref(target)}
        isShiftPressed={isShiftPressed}
        key={entry.entryKind === "draft" ? `draft:${entry.draft.draftId}` : `${entry.identity.harness}:${entry.identity.threadId}`}
        nowMs={nowMs}
        onAction={(action) => onAction?.(entry, action)}
        onActivate={onOpenThread}
        onKeyDown={(event) => moveFocus(event, index)}
        onPointerDown={(event) => onThreadPointerDragStart?.(event, entry)}
        projectId={projectId}
        role="tab"
        selected={selected}
        showActions
        tabIndex={selected || (!hasSelectedEntry && index === 0) ? 0 : -1}
      />
    );
  };

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
        {primaryEntries.length ? <ul className="m-0 flex flex-col gap-1 p-0">{primaryEntries.map(renderEntry)}</ul> : null}
        {settledEntries.length ? (
          <ThreadDisclosure
            className="mt-4"
            contentClassName="mt-1"
            open={isOlderThreadsOpen}
            onToggle={(event) => setIsOlderThreadsOpen(event.currentTarget.open)}
            summary="Settled threads"
            summaryClassName="text-[0.72rem] font-medium leading-[1.5] text-muted"
          >
            <ul className="m-0 flex flex-col gap-1 p-0">{displayedSettledEntries.map(renderEntry)}</ul>
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
