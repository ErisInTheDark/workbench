/*
 * Exports:
 * - default WorkbenchThreadListItem: render one reusable full or collapsed thread row with direct navigation and explicit context-menu access. Keywords: thread, sidebar, navigation, context menu, claim.
 */
"use client";

import type { DragEventHandler, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, Ref } from "react";

import {
  getThreadSidebarGroup,
  gitArcPreventsThreadSettlement,
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchThreadStatusProviderOwned,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadTarget,
} from "../../lib/workbench/thread/thread-state";
import ContextMenuCapability from "./ContextMenuCapability";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import { workbenchThreadListLabelClassName } from "./workbench-class-names";
import {
  getNeedsAttentionThreadStatusTone,
  getWorkbenchThreadStatusClassName,
  type WorkbenchThreadStatusTone,
} from "./workbench-thread-status-colors";
import {
  CompletedThreadIcon,
  DiscardDraftIcon,
  DraftThreadIcon,
  FlagIcon,
  MoreVerticalIcon,
  NeedsAttentionThreadIcon,
  PinIcon,
  ProposedCommitThreadIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  StoppedThreadIcon,
  UnsnoozeThreadIcon,
  WorkingThreadIcon,
} from "./workbench-icons";
import { useWorkbenchContextMenu, type WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

type ThreadAction = "complete" | "discard" | "restore" | "settle" | "wake";

function targetForEntry(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

export default function WorkbenchThreadListItem({
  anchorRef,
  attentionLabel = "",
  className = "",
  compact: compactOverride,
  contextMenu = null,
  draggable,
  entry,
  href,
  isDragActive = false,
  isShiftPressed = false,
  nowMs = Date.now(),
  onAction,
  onActivate,
  onDragStart,
  onKeyDown,
  onPointerDown,
  role,
  selected = false,
  showActions = false,
  tabIndex,
}: {
  anchorRef?: Ref<HTMLAnchorElement>;
  attentionLabel?: string;
  className?: string;
  compact?: boolean;
  contextMenu?: WorkbenchContextMenuDefinition | null;
  draggable?: boolean;
  entry: WorkbenchThreadSidebarEntry;
  href: string;
  isDragActive?: boolean;
  isShiftPressed?: boolean;
  nowMs?: number;
  onAction?: (action: ThreadAction) => void;
  onActivate?: (target: WorkbenchThreadTarget) => void;
  onDragStart?: DragEventHandler<HTMLAnchorElement>;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLAnchorElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLAnchorElement>) => void;
  projectId?: string;
  role?: "tab";
  selected?: boolean;
  showActions?: boolean;
  showTooltip?: boolean;
  tabIndex?: number;
}) {
  const { openContextMenu } = useWorkbenchContextMenu();
  const target = targetForEntry(entry);
  const group = getThreadSidebarGroup(entry);
  const lifecycle = entry.entryKind === "draft" ? null : entry.lifecycle;
  const gitArc = entry.entryKind === "draft" ? null : entry.gitArc ?? null;
  const hasActiveGitArc = gitArc?.phase === "active";
  const claimedPaths = gitArc?.claimedPaths ?? [];
  const claimedFileCount = claimedPaths.length;
  const hasProposedCommit = Boolean(gitArc?.proposals.some(({ status }) => status === "proposed"));
  const showProposedCommit = lifecycle?.kind === "completed" && hasProposedCommit;
  const status = showProposedCommit
    ? "Proposed commit"
    : entry.entryKind === "draft"
      ? "Draft"
      : lifecycle?.kind === "needsAttention" ? attentionLabel.trim() || "Needs attention" : lifecycle?.kind === "working" ? "Working" : lifecycle?.kind === "stopped" ? "Stopped" : "Completed";
  const pinned = entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
  const timestamp = new Date(entry.activityAt);
  const dateTime = timestamp.toISOString();
  const relativeTime = formatThreadRelativeTimestamp(entry.activityAt / 1000, nowMs);
  const exactTime = timestamp.toLocaleString();
  const canComplete = entry.entryKind === "thread" && !isWorkbenchThreadStatusProviderOwned(entry.lifecycle) && (entry.lifecycle.kind === "needsAttention" || entry.lifecycle.kind === "stopped");
  const settlementBlocked = gitArcPreventsThreadSettlement(gitArc);
  const settlementAvailable = isWorkbenchThreadSettlementAvailable(entry);
  const baseAction: ThreadAction | null = entry.entryKind === "draft" ? "discard" : group === "settled" ? "restore" : group === "snoozed" ? "wake" : canComplete ? "complete" : settlementAvailable ? "settle" : null;
  const canShiftSettle = canComplete && !settlementBlocked;
  const action = canShiftSettle && isShiftPressed ? "settle" : baseAction;
  const Icon = entry.entryKind === "draft" ? DraftThreadIcon : showProposedCommit ? ProposedCommitThreadIcon : lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : CompletedThreadIcon;
  const statusTone: WorkbenchThreadStatusTone = lifecycle?.kind === "working"
    ? "working"
    : lifecycle?.kind === "needsAttention"
      ? getNeedsAttentionThreadStatusTone(hasActiveGitArc)
      : lifecycle?.kind === "stopped"
        ? "stopped"
        : "completed";
  const statusClassName = entry.entryKind === "draft" ? "text-muted" : getWorkbenchThreadStatusClassName(statusTone);
  const ActionIcon = action === "discard" ? DiscardDraftIcon : action === "restore" ? RestoreThreadIcon : action === "wake" ? UnsnoozeThreadIcon : SettleThreadIcon;
  const actionLabel = action === "complete" ? "Completed" : action === "discard" ? "Discard draft" : action === "restore" ? "Restore" : action === "settle" ? "Settle" : "Wake";
  const rowName = `${entry.title}, ${status}${claimedFileCount ? `, ${claimedFileCount} claimed ${claimedFileCount === 1 ? "file" : "files"}` : ""}${group === "snoozed" ? ", snoozed" : ""}${pinned ? ", pinned" : ""}, ${exactTime}`;
  const dimmed = !selected && (group === "snoozed" || group === "settled");
  const hasDashedBorder = entry.entryKind === "draft" || lifecycle?.kind === "needsAttention" || lifecycle?.kind === "stopped";
  const strokeOpacity = entry.entryKind === "draft" ? 0.24 : 1;
  const compact = compactOverride ?? group === "settled";
  const hideCompactMetadata = showActions && Boolean(action);
  const actionButton = showActions && action ? (
    <button type="button" aria-label={actionLabel} title={actionLabel} className={`pointer-events-auto z-20 row-start-1 -mt-1 -mb-1 ml-0 mr-0 hidden cursor-pointer items-center rounded-lg text-muted focus-visible:flex focus-visible:text-text${isDragActive ? "" : " hover:text-text group-hover/thread-row:flex group-focus-within/thread-row:flex"} ${compact ? "col-start-3 self-center" : "col-start-2 self-start"} ${action === "discard" ? "p-1" : "gap-1 px-1.5 py-1 text-[0.72rem] font-medium"}`} onClick={(event) => { event.stopPropagation(); onAction?.(canShiftSettle && (event.shiftKey || event.detail > 1) ? "settle" : action); }} onPointerDown={(event) => event.stopPropagation()}>
      <ActionIcon className="size-4" />
      {action === "discard" ? null : <span>{actionLabel}</span>}
    </button>
  ) : null;
  const contextMenuButton = contextMenu ? (
    <button
      type="button"
      aria-label={`More actions for ${entry.title}`}
      className="pointer-events-auto absolute right-0 top-1/2 z-30 size-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
      data-thread-context-menu-trigger="true"
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        openContextMenu({ menu: contextMenu, x: rect.right, y: rect.bottom });
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MoreVerticalIcon className="size-5" />
    </button>
  ) : null;
  const anchor = (
    <a
      ref={anchorRef}
      draggable={draggable}
      href={href}
      role={role}
      tabIndex={tabIndex}
      aria-selected={role === "tab" ? selected : undefined}
      aria-label={rowName}
      className="absolute inset-0 z-10 cursor-pointer rounded-[0.8rem] border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onActivate ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        onActivate(target);
      } : undefined}
      onKeyDown={onActivate ? (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(target); return; }
        onKeyDown?.(event);
      } : onKeyDown}
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
    />
  );
  return (
    <li className={`group/thread-row relative isolate m-0 min-h-11 list-none md:min-h-0${dimmed ? ` opacity-50${isDragActive ? "" : " hover:opacity-100 focus-within:opacity-100"}` : ""}${className ? ` ${className}` : ""}`} data-thread-status-tone={entry.entryKind === "draft" ? "draft" : statusTone}>
      <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 size-full transition-opacity duration-75 ease-out ${statusClassName} ${selected ? "opacity-100" : `opacity-0${isDragActive ? "" : " group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100"}`}`}>
        <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="color-mix(in srgb, var(--text) 4%, transparent)" stroke="currentColor" strokeWidth="1" strokeOpacity={strokeOpacity} strokeDasharray={hasDashedBorder ? "6 4" : undefined} vectorEffect="non-scaling-stroke" />
      </svg>
      <ContextMenuCapability menu={contextMenu}>{anchor}</ContextMenuCapability>
      {contextMenuButton}
      {compact ? (
        <div
          className="pointer-events-none relative z-10 grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-[var(--thread-context-menu-row-padding-right,0.5rem)] pl-2 md:min-h-0"
          data-thread-context-menu-content={contextMenu ? "true" : undefined}
        >
          <Icon className={`mr-1.5 size-3.5 ${statusClassName}`} />
          <span className={`${workbenchThreadListLabelClassName} truncate${selected ? " font-semibold text-text" : ""}`}>{entry.title}</span>
          <span className={`col-start-3 row-start-1 inline-flex items-center gap-1.5 text-[0.72rem] text-muted${hideCompactMetadata && !isDragActive ? " group-hover/thread-row:invisible group-focus-within/thread-row:invisible" : ""}`}>
            <span className="inline-flex size-4 items-center justify-center">{pinned ? <PinIcon className="size-3.5" /> : null}</span>
            <time dateTime={dateTime} title={exactTime}>{relativeTime}</time>
          </span>
          {actionButton}
        </div>
      ) : (
        <div
          className="pointer-events-none relative z-10 min-w-0 pr-[var(--thread-context-menu-row-padding-right,0.5rem)]"
          data-thread-context-menu-content={contextMenu ? "true" : undefined}
        >
          <div className="pointer-events-none grid min-w-0 grid-cols-[minmax(0,1fr)_auto] pr-0 pl-2 pt-1.5">
            <span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold text-text" : ""}`}>{entry.title}</span>
            {actionButton}
          </div>
          <div className="pointer-events-none mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 pr-0 pb-1.5 pl-2 text-[0.72rem] text-muted">
            <Icon className={`size-3.5 ${statusClassName}`} />
            <span className={`truncate ${statusClassName}`}>{status}</span>
            <span className="grid grid-cols-[auto_auto] items-center gap-1.5">
              {claimedFileCount ? <span data-role="thread-file-claim" className="inline-flex items-center gap-0.5" aria-hidden="true"><FlagIcon className="size-3.5" /><span>{claimedFileCount}</span></span> : null}
              {group === "snoozed" || pinned ? <span data-role="thread-priority-icon" className="inline-flex size-4 items-center justify-center">{group === "snoozed" ? <SnoozedThreadIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}</span> : null}
            </span>
            <time dateTime={dateTime} title={exactTime}>{relativeTime}</time>
          </div>
        </div>
      )}
    </li>
  );
}
