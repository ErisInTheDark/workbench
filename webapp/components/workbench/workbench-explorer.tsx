/*
 * Exports:
 * - NewEntryIcon: render the create-entry glyph used in the explorer. Keywords: workbench, explorer, icon.
 * - FileVisibilityIcon: render the eye glyph used by the explorer file-visibility toggle. Keywords: workbench, explorer, icon, visibility.
 * - SidebarLoadingSkeleton: render animated placeholder rows for loading sidebar sections. Keywords: sidebar, loading, skeleton.
 * - ThreadsList: render the thread list in the workbench sidebar, including the create-thread row. Keywords: workbench, threads, sidebar, create.
 * - BrowseSessionsList: render active Browse sessions in the workbench sidebar. Keywords: workbench, browse, sessions, sidebar.
 * - ExplorerTree: render the recursive project tree with current, modified, and create-entry state. Keywords: workbench, explorer, tree.
 * - Local helpers: support modified markers, change summaries, and recursive directory state. Keywords: recursion, tree state, helpers.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";

import type {
  ChangeSummary,
  TreeNode,
  WorkbenchBrowseSessionSummary,
  WorkbenchControls
} from "../../lib/types";
import type { WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import { getThreadSidebarGroup, isWorkbenchThreadStatusProviderOwned, type WorkbenchThreadSidebarEntry, type WorkbenchThreadTarget } from "../../lib/workbench/thread/thread-state";
import ChevronIcon from "./ChevronIcon";
import ContextMenuCapability from "./ContextMenuCapability";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import {
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";
import { BrowserSessionIcon, CompletedThreadIcon, DiscardDraftIcon, DraftThreadIcon, NeedsAttentionThreadIcon, PinIcon, RestoreThreadIcon, SettleThreadIcon, SnoozedThreadIcon, SparkleIcon, StoppedThreadIcon, UnsnoozeThreadIcon, WorkingThreadIcon } from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

export function NewEntryIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M6 2.75H11.75L15.5 6.5V16.25C15.5 16.94 14.94 17.5 14.25 17.5H6C5.31 17.5 4.75 16.94 4.75 16.25V4C4.75 3.31 5.31 2.75 6 2.75Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.75 2.75V6.5H15.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.125 9V14M7.625 11.5H12.625" strokeLinecap="round" />
    </svg>
  );
}

export function FileVisibilityIcon ({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M2.75 10C4.41 6.78 6.98 5.17 10 5.17C13.02 5.17 15.59 6.78 17.25 10C15.59 13.22 13.02 14.83 10 14.83C6.98 14.83 4.41 13.22 2.75 10Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.2" />
      {visible ? null : <path d="M4.1 4.1 15.9 15.9" strokeLinecap="round" />}
    </svg>
  );
}

export function SidebarLoadingSkeleton ({
  ariaLabel,
  rows,
}: {
  ariaLabel: string;
  rows: number;
}) {
  return (
    <div aria-label={ariaLabel} aria-live="polite" role="status" className="space-y-1 py-1 pr-2 md:pr-4.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 min-w-0 items-center gap-2 px-2">
          <span className="size-4 shrink-0 rounded-full workbench-skeleton" aria-hidden="true" />
          <span
            className="h-3.5 rounded-full workbench-skeleton"
            style={{ width: `${Math.max(42, 86 - index * 7)}%` }}
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}

function ThreadListRow ({
  active = false,
  children,
  onClick,
  title,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  title: string;
}) {
  const className = `${workbenchThreadListButtonClassName}${active ? " text-accent" : " text-muted"}`;
  if (!onClick) {
    return (
      <div
        title={title}
        className={className}
      >
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      title={title}
      className={className}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ExplorerModifiedDot ({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      data-role="tree-modified"
      hidden={hidden}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--attention)]"
      aria-hidden="true"
    />
  );
}

function ExplorerFileSpacer () {
  return (
    <span
      data-role="tree-spacer"
      className="shrink-0"
      style={{ width: "1.1rem", height: "1.1rem" }}
      aria-hidden="true"
    />
  );
}

function ExplorerChangeSummary ({ summary }: { summary: ChangeSummary | null }) {
  if (!summary || (!summary.additions && !summary.deletions)) {
    return null;
  }

  return (
    <span data-role="tree-change" className="inline-flex shrink-0 items-center gap-1.5 text-[0.8rem]">
      {summary.additions ? (
        <span className="text-[var(--explorer-change-add)]">
          +{summary.additions}
        </span>
      ) : null}
      {summary.deletions ? (
        <span className="text-[var(--explorer-change-del)]">
          -{summary.deletions}
        </span>
      ) : null}
    </span>
  );
}

export function ThreadsList ({
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
}) {
  const rowRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const visibleEntries = entries.filter((entry) => getThreadSidebarGroup(entry) !== "hidden" && entry.entryKind !== "subagent");
  const targetForEntry = (entry: WorkbenchThreadSidebarEntry): WorkbenchThreadTarget => entry.entryKind === "draft"
    ? { draftId: entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
  const targetSelected = (target: WorkbenchThreadTarget) => {
    if (!currentTarget) return false;
    if (target.kind === "provider" && currentTarget.kind === "subagent") return target.threadId === currentTarget.parentThreadId
      && (!target.harness || !currentTarget.harness || target.harness === currentTarget.harness);
    if (currentTarget.kind !== target.kind) return false;
    if (target.kind === "new") return true;
    if (target.kind === "draft" && currentTarget.kind === "draft") return target.draftId === currentTarget.draftId;
    return target.kind === "provider" && currentTarget.kind === "provider" && target.threadId === currentTarget.threadId
      && (!target.harness || !currentTarget.harness || target.harness === currentTarget.harness);
  };
  const isPinned = (entry: WorkbenchThreadSidebarEntry) => entry.entryKind === "draft" ? entry.metadata.pinned : entry.entryKind === "thread" ? entry.metadata.pinned : entry.pinned;
  const settledEntries = visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === "other");
  const shouldOpenOlderThreads = settledEntries.some((entry) => targetSelected(targetForEntry(entry)));
  const [isOlderThreadsOpen, setIsOlderThreadsOpen] = useState(shouldOpenOlderThreads);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  useEffect(() => {
    if (shouldOpenOlderThreads) setIsOlderThreadsOpen(true);
  }, [shouldOpenOlderThreads]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") setIsShiftPressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") setIsShiftPressed(false);
    };
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
  const navigableEntries = visibleEntries.filter((entry) => getThreadSidebarGroup(entry) !== "other" || isOlderThreadsOpen);
  const groups = [
    "drafts", "needsAttention", "completed", "working", "snoozed",
  ] as const;
  const primaryEntries = groups.flatMap((group) => visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === group));
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
    const selected = targetSelected(target);
    const group = getThreadSidebarGroup(entry);
    const lifecycle = entry.entryKind === "draft" ? null : entry.lifecycle;
    const attentionLabel = entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]?.trim() ?? "";
    const baseStatus = entry.entryKind === "draft"
      ? "Draft"
      : lifecycle?.kind === "needsAttention" ? attentionLabel || "Needs attention" : lifecycle?.kind === "working" ? "Working" : lifecycle?.kind === "stopped" ? "Stopped" : "Completed";
    const status = entry.entryKind !== "draft" && (lifecycle?.kind === "stopped" || lifecycle?.kind === "completed") && entry.fileClaim
      ? entry.fileClaim.proposalStatus === "proposed"
        ? `${lifecycle.kind === "stopped" ? "Stopped" : "Completed"} with proposed commit`
        : `${lifecycle.kind === "stopped" ? "Stopped" : "Completed"} with file claims`
      : baseStatus;
    const pinned = isPinned(entry);
    const timestamp = new Date(entry.activityAt);
    const relativeTime = formatThreadRelativeTimestamp(entry.activityAt / 1000, nowMs);
    const exactTime = timestamp.toLocaleString();
    const canComplete = entry.entryKind === "thread" && !isWorkbenchThreadStatusProviderOwned(entry.lifecycle) && (entry.lifecycle.kind === "needsAttention" || entry.lifecycle.kind === "stopped");
    const baseAction = entry.entryKind === "draft" ? "discard" : group === "other" ? "restore" : group === "snoozed" ? "wake" : canComplete ? "complete" : lifecycle?.kind === "completed" && !lifecycle.settled && !entry.fileClaim ? "settle" : null;
    const canShiftSettle = canComplete && !entry.fileClaim;
    const action = canShiftSettle && isShiftPressed ? "settle" : baseAction;
    const Icon = entry.entryKind === "draft" ? DraftThreadIcon : lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : CompletedThreadIcon;
    const statusClassName = entry.entryKind === "draft"
      ? "text-muted"
      : lifecycle?.kind === "working"
        ? "text-sky-600 dark:text-sky-300"
        : lifecycle?.kind === "needsAttention"
          ? "text-amber-600 dark:text-amber-300"
          : lifecycle?.kind === "stopped"
            ? "text-red-600 dark:text-red-300"
            : "text-emerald-600 dark:text-emerald-300";
    const ActionIcon = action === "discard" ? DiscardDraftIcon : action === "restore" ? RestoreThreadIcon : action === "wake" ? UnsnoozeThreadIcon : SettleThreadIcon;
    const actionLabel = action === "complete" ? "Completed" : action === "discard" ? "Discard draft" : action === "restore" ? "Restore" : action === "settle" ? "Settle" : "Wake";
    const rowName = `${entry.title}, ${status}${group === "snoozed" ? ", snoozed" : ""}${pinned ? ", pinned" : ""}, ${exactTime}`;
    const dimmed = !selected && (group === "snoozed" || group === "other");
    const hasDashedBorder = entry.entryKind === "draft" || lifecycle?.kind === "needsAttention" || lifecycle?.kind === "stopped";
    const strokeOpacity = entry.entryKind === "draft" ? 0.24 : 1;
    const compact = group === "other";
    const actionButton = action ? (
      <button type="button" aria-label={actionLabel} title={actionLabel} className={`pointer-events-auto z-20 row-start-1 -mt-1 -mb-1 ml-0 mr-0 hidden cursor-pointer items-center rounded-lg text-muted hover:text-text focus-visible:flex focus-visible:text-text group-hover/thread-row:flex group-focus-within/thread-row:flex ${compact ? "col-start-3 self-center" : "col-start-2 self-start"} ${action === "discard" ? "p-1" : "gap-1 px-1.5 py-1 text-[0.72rem] font-medium"}`} onClick={(event) => { event.stopPropagation(); onAction?.(entry, canShiftSettle && (event.shiftKey || event.detail > 1) ? "settle" : action); }} onPointerDown={(event) => event.stopPropagation()}>
        <ActionIcon className="size-4" />
        {action === "discard" ? null : <span>{actionLabel}</span>}
      </button>
    ) : null;
    return (
      <li key={entry.entryKind === "draft" ? `draft:${entry.draft.draftId}` : `${entry.identity.harness}:${entry.identity.threadId}`} className={`group/thread-row relative isolate m-0 list-none${dimmed ? " opacity-50 hover:opacity-100 focus-within:opacity-100" : ""}`}>
        <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 size-full transition-opacity duration-75 ease-out ${statusClassName} ${selected ? "opacity-100" : "opacity-0 group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100"}`}>
          <rect
            x="0.5"
            y="0.5"
            width="calc(100% - 1px)"
            height="calc(100% - 1px)"
            rx="12.8"
            fill="color-mix(in srgb, var(--text) 4%, transparent)"
            stroke="currentColor"
            strokeWidth="1"
            strokeOpacity={strokeOpacity}
            strokeDasharray={hasDashedBorder ? "6 4" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <ContextMenuCapability menu={getThreadContextMenu?.(entry) ?? null}>
          <a
            ref={(node) => { if (index >= 0) rowRefs.current[index] = node; }}
            href={getThreadHref(target)}
            role="tab"
            tabIndex={selected || (!navigableEntries.some((candidate) => targetSelected(targetForEntry(candidate))) && index === 0) ? 0 : -1}
            aria-selected={selected}
            aria-label={rowName}
            title={entry.title}
            className="absolute inset-0 z-10 cursor-pointer rounded-[0.8rem] border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              event.preventDefault();
              onOpenThread(target);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenThread(target); return; }
              moveFocus(event, index);
            }}
            onPointerDown={(event) => onThreadPointerDragStart?.(event, entry)}
          />
        </ContextMenuCapability>
        {compact ? (
          <div className="pointer-events-none relative z-10 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center px-2 py-1">
            <Icon className={`mr-1.5 size-3.5 ${statusClassName}`} />
            <span className={`${workbenchThreadListLabelClassName} truncate${selected ? " font-semibold text-text" : ""}`}>{entry.title}</span>
            <span className="col-start-3 row-start-1 inline-flex items-center gap-1.5 text-[0.72rem] text-muted group-hover/thread-row:invisible group-focus-within/thread-row:invisible">
              <span className="inline-flex size-4 items-center justify-center">{pinned ? <PinIcon className="size-3.5" /> : null}</span>
              <time dateTime={timestamp.toISOString()} title={exactTime}>{relativeTime}</time>
            </span>
            {actionButton}
          </div>
        ) : (
          <div className="pointer-events-none relative z-10 min-w-0">
            <div className="pointer-events-none grid min-w-0 grid-cols-[minmax(0,1fr)_auto] px-2 pt-1.5">
              <span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold text-text" : ""}`}>{entry.title}</span>
              {actionButton}
            </div>
            <div className="pointer-events-none mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 px-2 pb-1.5 text-[0.72rem] text-muted">
              <Icon className={`size-3.5 ${statusClassName}`} />
              <span className={`truncate ${statusClassName}`}>{status}</span>
              <span className="inline-flex size-4 items-center justify-center">{group === "snoozed" ? <SnoozedThreadIcon className="size-3.5" /> : pinned ? <PinIcon className="size-3.5" /> : null}</span>
              <time dateTime={timestamp.toISOString()} title={exactTime}>{relativeTime}</time>
            </div>
          </div>
        )}
      </li>
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
            <ul className="m-0 flex flex-col gap-1 p-0">
              {settledEntries.map(renderEntry)}
            </ul>
          </ThreadDisclosure>
        ) : null}
      </div>
    </div>
  );
}

export function BrowseSessionsList ({
  getSessionContextMenu,
  isLoading,
  sessions,
}: {
  getSessionContextMenu?: (session: WorkbenchBrowseSessionSummary) => WorkbenchContextMenuDefinition | null;
  isLoading: boolean;
  sessions: WorkbenchBrowseSessionSummary[];
}) {
  if (isLoading && !sessions.length) {
    return <SidebarLoadingSkeleton ariaLabel="Loading Browse sessions" rows={3} />;
  }

  if (!sessions.length) {
    return null;
  }

  return (
    <ul className="m-0 space-y-1 p-0">
      {sessions.map((session) => {
        const detail = formatBrowseSessionDetail(session);
        const title = `${session.name}${detail ? ` — ${detail}` : ""}`;
        const isProblemState = session.state === "orphan" || session.state === "stale" || session.state === "unknown";

        return (
          <li key={session.name} className="m-0 list-none">
            <ContextMenuCapability menu={getSessionContextMenu?.(session) ?? null}>
              <ThreadListRow
                active={isProblemState}
                title={title}
              >
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <BrowserSessionIcon className="size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className={`${workbenchThreadListLabelClassName}${isProblemState ? " font-semibold" : ""}`}>{session.name}</span>
                      {detail ? <span className="block truncate text-[0.75rem] leading-4 text-muted">{detail}</span> : null}
                    </span>
                  </span>
                </span>
              </ThreadListRow>
            </ContextMenuCapability>
          </li>
        );
      })}
    </ul>
  );
}

function formatBrowseSessionDetail (session: WorkbenchBrowseSessionSummary) {
  const parts = [
    session.mode,
    session.threadId ? `thread ${session.threadId.slice(0, 8)}` : null,
    session.state,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

interface ExplorerTreeDerivedState {
  changeSummariesByPath: ReadonlyMap<string, ChangeSummary>;
  modifiedPathsWithDescendants: ReadonlySet<string>;
}

function buildExplorerTreeDerivedState (
  nodes: TreeNode[],
  changes: Record<string, ChangeSummary>,
  modifiedPaths: Set<string>,
): ExplorerTreeDerivedState {
  const changeSummariesByPath = new Map<string, ChangeSummary>();
  const modifiedPathsWithDescendants = new Set<string>();

  const visit = (node: TreeNode): ChangeSummary | null => {
    if (node.type === "file") {
      const summary = changes[node.path] ?? null;
      if (summary) {
        changeSummariesByPath.set(node.path, summary);
      }
      if (modifiedPaths.has(node.path)) {
        modifiedPathsWithDescendants.add(node.path);
      }
      return summary;
    }

    let additions = 0;
    let deletions = 0;
    let isModified = modifiedPaths.has(node.path);

    for (const child of node.children) {
      const summary = visit(child);
      if (summary) {
        additions += summary.additions;
        deletions += summary.deletions;
      }
      if (modifiedPathsWithDescendants.has(child.path)) {
        isModified = true;
      }
    }

    if (isModified) {
      modifiedPathsWithDescendants.add(node.path);
    }

    if (!additions && !deletions) {
      return null;
    }

    const summary = { additions, deletions };
    changeSummariesByPath.set(node.path, summary);
    return summary;
  };

  for (const node of nodes) {
    visit(node);
  }

  return {
    changeSummariesByPath,
    modifiedPathsWithDescendants,
  };
}

interface ExplorerTreeProps {
  changes: Record<string, ChangeSummary>;
  controls: WorkbenchControls | null;
  currentPath: string;
  expandedDirectories: Set<string>;
  isFileOpenable?: (path: string) => boolean;
  getFileDragPayload?: (path: string) => WorkbenchDragPayload | null;
  getNodeContextMenu?: (node: TreeNode) => WorkbenchContextMenuDefinition | null;
  derivedState?: ExplorerTreeDerivedState;
  modifiedPaths: Set<string>;
  nested?: boolean;
  nodes: TreeNode[];
  onCreateInDirectory?: (path: string) => void;
  onFilePointerDragStart?: (event: PointerEvent<HTMLElement>, path: string) => void;
  onOpenFile?: (path: string) => void;
}

export function ExplorerTree ({
  changes,
  controls,
  currentPath,
  derivedState,
  expandedDirectories,
  isFileOpenable,
  getFileDragPayload,
  getNodeContextMenu,
  modifiedPaths,
  nested = false,
  nodes,
  onCreateInDirectory,
  onFilePointerDragStart,
  onOpenFile,
}: ExplorerTreeProps) {
  const treeDerivedState = useMemo(() => (
    derivedState ?? buildExplorerTreeDerivedState(nodes, changes, modifiedPaths)
  ), [changes, derivedState, modifiedPaths, nodes]);

  return (
    <ul
      className={`m-0 p-0${nested ? " ml-4" : ""}`}
      data-role={nested ? "tree-group-nested" : "tree-group-root"}
    >
      {nodes.map((node) => {
        if (node.type === "directory") {
          const changeSummary = treeDerivedState.changeSummariesByPath.get(node.path) ?? null;
          const isExpanded = expandedDirectories.has(node.path);
          const isModified = treeDerivedState.modifiedPathsWithDescendants.has(node.path);

          return (
            <li
              key={`${node.type}:${node.path}`}
              className="m-0 list-none"
              data-path={node.path}
              data-tree-key={`${node.type}:${node.path}`}
              data-tree-type={node.type}
            >
              <ContextMenuCapability menu={getNodeContextMenu?.(node) ?? null}>
                <div className="group/entry-row flex min-w-0 items-center justify-between gap-2">
                  <button
                    data-role="tree-button"
                    type="button"
                    className="inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-0.5"
                    onClick={() => {
                      controls?.toggleDirectory(node.path);
                    }}
                  >
                    <ChevronIcon
                      data-role="tree-chevron"
                      className="mt-0.5 transition-transform"
                      style={{
                        width: "1.1rem",
                        height: "1.1rem",
                        transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                      }}
                    />
                    <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                    <ExplorerModifiedDot hidden={!isModified} />
                    <ExplorerChangeSummary summary={changeSummary} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Create in ${node.name}`}
                    title={`Create in ${node.name}`}
                    className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}`}
                    onClick={() => {
                      onCreateInDirectory?.(node.path);
                    }}
                  >
                    <NewEntryIcon />
                    <span className="sr-only">{`Create in ${node.name}`}</span>
                  </button>
                </div>
              </ContextMenuCapability>
              {isExpanded ? (
                <ExplorerTree
                  changes={changes}
                  controls={controls}
                  currentPath={currentPath}
                  derivedState={treeDerivedState}
                  expandedDirectories={expandedDirectories}
                  getFileDragPayload={getFileDragPayload}
                  getNodeContextMenu={getNodeContextMenu}
                  isFileOpenable={isFileOpenable}
                  modifiedPaths={modifiedPaths}
                  nested
                  nodes={node.children}
                  onCreateInDirectory={onCreateInDirectory}
                  onFilePointerDragStart={onFilePointerDragStart}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </li>
          );
        }

        const changeSummary = treeDerivedState.changeSummariesByPath.get(node.path) ?? null;
        const isOpenable = isFileOpenable?.(node.path) ?? true;
        const isModified = treeDerivedState.modifiedPathsWithDescendants.has(node.path);
        const isCurrent = node.path === currentPath;
        const disabledTitle = `${node.name} can't be opened in the workbench`;

        return (
          <li
            key={`${node.type}:${node.path}`}
            className="m-0 list-none"
            data-path={node.path}
            data-tree-key={`${node.type}:${node.path}`}
            data-tree-type={node.type}
          >
            <ContextMenuCapability menu={getNodeContextMenu?.(node) ?? null}>
              <div className="flex min-w-0 items-center gap-2">
                <button
                  data-role="tree-button"
                  type="button"
                  aria-disabled={!isOpenable}
                  disabled={!isOpenable}
                  title={isOpenable ? node.name : disabledTitle}
                  className={`inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted disabled:focus-visible:bg-transparent disabled:focus-visible:text-muted md:py-0.5${isCurrent ? " font-semibold text-accent" : ""}`}
                  onPointerDown={(event) => {
                    if (!isOpenable) {
                      return;
                    }

                    event.stopPropagation();
                    onFilePointerDragStart?.(event, node.path);
                  }}
                  onClick={() => {
                    if (!isOpenable) {
                      return;
                    }

                    onOpenFile?.(node.path);
                  }}
                >
                  <ExplorerFileSpacer />
                  <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                  <ExplorerModifiedDot hidden={!isModified} />
                  <ExplorerChangeSummary summary={changeSummary} />
                </button>
              </div>
            </ContextMenuCapability>
          </li>
        );
      })}
    </ul>
  );
}
