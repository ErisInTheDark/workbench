/*
 * Exports:
 * - default WorkbenchThreadList: render grouped sidebar threads with navigation, actions, and interactive detail tooltips. Keywords: workbench, threads, sidebar, tooltip.
 * - Local helpers: derive row targets and render the shared row and tooltip presentation. Keywords: thread, status, claim, file links.
 */
"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import type { WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import {
  getThreadSidebarGroup,
  isWorkbenchThreadStatusProviderOwned,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadTarget,
} from "../../lib/workbench/thread/thread-state";
import ContextMenuCapability from "./ContextMenuCapability";
import ProjectFilePath from "./ProjectFilePath";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import {
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";
import {
  CompletedThreadIcon,
  DiscardDraftIcon,
  DraftThreadIcon,
  FlagIcon,
  NeedsAttentionThreadIcon,
  PinIcon,
  ProposedCommitThreadIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  SparkleIcon,
  StoppedThreadIcon,
  UnsnoozeThreadIcon,
  WorkingThreadIcon,
} from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchTooltip from "./WorkbenchTooltip";

type ThreadStatusIcon = ComponentType<{ className?: string }>;
const SETTLED_THREAD_PAGE_SIZE = 50;

function ThreadTooltipContent({
  claimedPaths,
  dateTime,
  exactTime,
  Icon,
  pinned,
  projectId,
  relativeTime,
  snoozed,
  status,
  statusClassName,
  title,
}: {
  claimedPaths: readonly string[];
  dateTime: string;
  exactTime: string;
  Icon: ThreadStatusIcon;
  pinned: boolean;
  projectId: string;
  relativeTime: string;
  snoozed: boolean;
  status: string;
  statusClassName: string;
  title: string;
}) {
  return (
    <div data-thread-project-file-link-boundary="true" className="flex max-h-full min-w-0 max-w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
      <p className="m-0 break-words text-[0.9rem] font-medium leading-[1.45] text-text">{title}</p>
      <div className="flex min-w-0 items-center gap-1.5 text-[0.76rem] text-muted">
        <Icon className={`size-3.5 shrink-0 ${statusClassName}`} />
        <span className={`min-w-0 truncate ${statusClassName}`}>{status}</span>
        <span className="ml-auto" />
        {snoozed || pinned ? (
          <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-label={snoozed ? "Snoozed" : "Pinned"}>
            {snoozed ? <SnoozedThreadIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          </span>
        ) : null}
        <time className="shrink-0" dateTime={dateTime} title={exactTime}>{relativeTime}</time>
      </div>
      {claimedPaths.length ? (
        <div className="explorer-scrollbar flex max-h-56 min-h-0 flex-wrap content-start items-center gap-1 overflow-y-auto rounded-[0.65rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-2">
          <span className="inline-flex size-5 shrink-0 items-center justify-center text-muted" aria-hidden="true">
            <FlagIcon className="size-3.5" />
          </span>
          {claimedPaths.map((filePath) => (
            <ProjectFilePath
              className="max-w-full shrink"
              disambiguationPaths={claimedPaths}
              key={filePath}
              path={filePath}
              projectId={projectId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  const visibleEntries = entries.filter((entry) => getThreadSidebarGroup(entry) !== "hidden" && entry.entryKind !== "subagent");
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
  const [isOlderThreadsOpen, setIsOlderThreadsOpen] = useState(false);
  const [settledEntryLimit, setSettledEntryLimit] = useState(SETTLED_THREAD_PAGE_SIZE);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
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
  const groups = ["drafts", "needsAttention", "completed", "working", "snoozed"] as const;
  const primaryEntries = groups.flatMap((group) => visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === group));
  const displayedSettledEntries = settledEntries.slice(0, settledEntryLimit);
  const remainingSettledEntryCount = settledEntries.length - displayedSettledEntries.length;
  const nextSettledEntryCount = Math.min(SETTLED_THREAD_PAGE_SIZE, remainingSettledEntryCount);
  const navigableEntries = isOlderThreadsOpen ? [...primaryEntries, ...displayedSettledEntries] : primaryEntries;
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
    const claimedPaths = entry.entryKind === "draft" ? [] : entry.fileClaim?.claimedPaths ?? [];
    const claimedFileCount = claimedPaths.length;
    const hasProposedCommit = entry.entryKind !== "draft" && entry.fileClaim?.proposalStatus === "proposed";
    const baseStatus = entry.entryKind === "draft"
      ? "Draft"
      : lifecycle?.kind === "needsAttention" ? attentionLabel || "Needs attention" : lifecycle?.kind === "working" ? "Working" : lifecycle?.kind === "stopped" ? "Stopped" : "Completed";
    const status = hasProposedCommit ? "Proposed commit" : baseStatus;
    const pinned = isPinned(entry);
    const timestamp = new Date(entry.activityAt);
    const dateTime = timestamp.toISOString();
    const relativeTime = formatThreadRelativeTimestamp(entry.activityAt / 1000, nowMs);
    const exactTime = timestamp.toLocaleString();
    const canComplete = entry.entryKind === "thread" && !isWorkbenchThreadStatusProviderOwned(entry.lifecycle) && (entry.lifecycle.kind === "needsAttention" || entry.lifecycle.kind === "stopped");
    const baseAction = entry.entryKind === "draft" ? "discard" : group === "other" ? "restore" : group === "snoozed" ? "wake" : canComplete ? "complete" : lifecycle?.kind === "completed" && !lifecycle.settled && !entry.fileClaim ? "settle" : null;
    const canShiftSettle = canComplete && !entry.fileClaim;
    const action = canShiftSettle && isShiftPressed ? "settle" : baseAction;
    const Icon = entry.entryKind === "draft" ? DraftThreadIcon : hasProposedCommit ? ProposedCommitThreadIcon : lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : CompletedThreadIcon;
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
    const rowName = `${entry.title}, ${status}${claimedFileCount ? `, ${claimedFileCount} claimed ${claimedFileCount === 1 ? "file" : "files"}` : ""}${group === "snoozed" ? ", snoozed" : ""}${pinned ? ", pinned" : ""}, ${exactTime}`;
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
          <WorkbenchTooltip
            content={(
              <ThreadTooltipContent
                claimedPaths={claimedPaths}
                dateTime={dateTime}
                exactTime={exactTime}
                Icon={Icon}
                pinned={pinned}
                projectId={projectId}
                relativeTime={relativeTime}
                snoozed={group === "snoozed"}
                status={status}
                statusClassName={statusClassName}
                title={entry.title}
              />
            )}
            interactive
          >
            <a
              ref={(node) => { if (index >= 0) rowRefs.current[index] = node; }}
              href={getThreadHref(target)}
              role="tab"
              tabIndex={selected || (!navigableEntries.some((candidate) => targetSelected(targetForEntry(candidate))) && index === 0) ? 0 : -1}
              aria-selected={selected}
              aria-label={rowName}
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
          </WorkbenchTooltip>
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
              <span className="grid grid-cols-[auto_auto] items-center gap-1.5">
                {claimedFileCount ? (
                  <span data-role="thread-file-claim" className="inline-flex items-center gap-0.5" aria-hidden="true">
                    <FlagIcon className="size-3.5" />
                    <span>{claimedFileCount}</span>
                  </span>
                ) : null}
                {group === "snoozed" || pinned ? (
                  <span data-role="thread-priority-icon" className="inline-flex size-4 items-center justify-center">
                    {group === "snoozed" ? <SnoozedThreadIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
                  </span>
                ) : null}
              </span>
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
              {displayedSettledEntries.map(renderEntry)}
            </ul>
            {remainingSettledEntryCount > 0 ? (
              <button
                type="button"
                aria-label={`Load ${nextSettledEntryCount} more settled threads`}
                className={`${workbenchThreadListButtonClassName} mt-1 justify-center text-center text-[0.72rem] font-medium text-muted`}
                onClick={() => setSettledEntryLimit((current) => current + SETTLED_THREAD_PAGE_SIZE)}
              >
                Load {nextSettledEntryCount} more
              </button>
            ) : null}
          </ThreadDisclosure>
        ) : null}
      </div>
    </div>
  );
}
