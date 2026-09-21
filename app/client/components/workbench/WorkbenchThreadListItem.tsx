/*
 * Exports:
 * - default WorkbenchThreadListItem: render a thread row or disclosure body with shared status, optional action slot, navigation and context menu.
 * Local helpers derive pinned-draft targets and render bounded tooltip details.
 */
"use client";

import type { ComponentType, DragEventHandler, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, ReactNode, Ref } from "react";

import type { WorkbenchHarness, WorkbenchProjectOption } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import {
  getThreadSidebarGroup,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import ContextMenuCapability from "./ContextMenuCapability";
import ProjectFilePath from "./ProjectFilePath";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import { workbenchThreadListLabelClassName } from "./workbench-class-names";
import {
  getNeedsAttentionThreadStatusTone,
  getWorkbenchThreadStatusClassName,
  type WorkbenchThreadStatusTone,
} from "./workbench-thread-status-colors";
import {
  ArchiveIcon,
  CompletedThreadIcon,
  ComposerDraftIcon,
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
  type IconProps,
} from "./workbench-icons";
import { useWorkbenchComposerDraftPresence } from "./WorkbenchComposerDraftPresenceProvider";
import { useWorkbenchContextMenu, type WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchTooltip from "./WorkbenchTooltip";
import WorkbenchThreadListFullRowContent from "./WorkbenchThreadListFullRowContent";
import WorkbenchThreadTitleHistory from "./WorkbenchThreadTitleHistory";
import { getThreadRowActions, type ThreadRowAction } from "./thread-row-actions";

type ThreadAction = ThreadRowAction;
type ThreadStatusIcon = ComponentType<IconProps>;
const THREAD_ACTIONS: Record<ThreadAction, { Icon: ThreadStatusIcon; label: string }> = {
  archive: { Icon: ArchiveIcon, label: "Archive" },
  complete: { Icon: SettleThreadIcon, label: "Completed" },
  discard: { Icon: DiscardDraftIcon, label: "Discard draft" },
  restore: { Icon: RestoreThreadIcon, label: "Restore" },
  settle: { Icon: SettleThreadIcon, label: "Settle" },
  snooze: { Icon: SnoozedThreadIcon, label: "Snooze" },
  wake: { Icon: UnsnoozeThreadIcon, label: "Wake" },
};
type ThreadListEntry = WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry;
type PinnedDraftSummaryEntry = Extract<WorkbenchPinnedThreadSummaryEntry, { entryKind: "draft" }>;

function isPinnedDraftSummaryEntry(entry: ThreadListEntry): entry is PinnedDraftSummaryEntry {
  return entry.entryKind === "draft" && "draftId" in entry;
}

function targetForEntry(entry: ThreadListEntry): WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function ThreadTooltipContent({
  claimedPaths,
  dateTime,
  exactTime,
  extraDetails,
  Icon,
  projectId,
  relativeTime,
  snoozed,
  status,
  statusClassName,
  stashed,
  title,
  identity,
}: {
  claimedPaths: readonly string[];
  dateTime: string;
  exactTime: string;
  extraDetails?: ReactNode;
  Icon: ThreadStatusIcon;
  projectId: ProjectId;
  relativeTime: string;
  snoozed: boolean;
  status: string;
  statusClassName: string;
  stashed: boolean;
  title: string;
  identity?: { harness: WorkbenchHarness; threadId: WorkbenchThreadId };
}) {
  return (
    <div data-thread-project-file-link-boundary="true" className="flex max-h-full min-w-0 max-w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
      <p className="m-0 truncate text-[0.9rem] font-medium leading-[1.45] text-text">{title}</p>
      {identity ? <WorkbenchThreadTitleHistory key={`${projectId}:${identity.harness}:${identity.threadId}`} projectId={projectId} harness={identity.harness} threadId={identity.threadId} /> : null}
      <div className="flex min-w-0 items-center gap-1.5 text-[0.76rem] text-fg/muted">
        <Icon className={`shrink-0 ${statusClassName}`} size={14} />
        <span className={`min-w-0 truncate ${statusClassName}`}>{status}</span>
        <span className="ml-auto" />
        {snoozed ? <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-label="Snoozed"><SnoozedThreadIcon size={14} /></span> : null}
        <time className="shrink-0" dateTime={dateTime} title={exactTime}>{relativeTime}</time>
      </div>
      {extraDetails}
      {claimedPaths.length ? (
        <div className="explorer-scrollbar flex max-h-56 min-h-0 flex-wrap content-start items-center gap-1 overflow-y-auto rounded-[0.65rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--thread-files-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] p-2">
          <div className="contents [--fg-bg:var(--thread-files-bg)]">
            <span className="inline-flex size-5 shrink-0 items-center justify-center text-fg/muted" aria-hidden="true">
              {stashed ? <ArchiveIcon size={14} /> : <FlagIcon size={14} />}
            </span>
            {claimedPaths.map((filePath) => (
              <ProjectFilePath className="max-w-full shrink" disambiguationPaths={claimedPaths} key={filePath} path={filePath} projectId={projectId} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function WorkbenchThreadListItem({
  action: actionOverride,
  anchorRef,
  attentionLabel = "",
  className = "",
  compact: compactOverride,
  contextMenu = null,
  dimmedOverride,
  draggable,
  dragTargets,
  entry,
  href,
  id,
  isDragActive = false,
  isShiftPressed = false,
  nowMs = Date.now(),
  onAction,
  onActivate,
  onDragStart,
  onKeyDown,
  onPointerDown,
  project,
  presentation = "row",
  projectId,
  role,
  selected = false,
  secondaryRow,
  showActions = false,
  showPinPriorityIcon = false,
  showTooltip = true,
  tabIndex,
  tooltipDetails,
}: {
  action?: { Icon: ThreadStatusIcon; label: string; href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };
  anchorRef?: Ref<HTMLAnchorElement>;
  attentionLabel?: string;
  className?: string;
  compact?: boolean;
  contextMenu?: WorkbenchContextMenuDefinition | null;
  dimmedOverride?: boolean;
  draggable?: boolean;
  dragTargets?: ReactNode;
  entry: ThreadListEntry;
  href: string | undefined;
  id?: string;
  isDragActive?: boolean;
  isShiftPressed?: boolean;
  nowMs?: number;
  onAction?: (action: ThreadAction) => void;
  onActivate?: (target: WorkbenchThreadTarget) => void;
  onDragStart?: DragEventHandler<HTMLAnchorElement>;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLAnchorElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLAnchorElement>) => void;
  project?: WorkbenchProjectOption;
  presentation?: "row" | "disclosure-summary";
  projectId: ProjectId;
  role?: "tab" | "option";
  selected?: boolean;
  secondaryRow?: ReactNode;
  showActions?: boolean;
  showPinPriorityIcon?: boolean;
  showTooltip?: boolean;
  tabIndex?: number;
  tooltipDetails?: ReactNode;
}) {
  const { openContextMenu } = useWorkbenchContextMenu();
  const hasComposerDraft = useWorkbenchComposerDraftPresence(
    projectId,
    entry.entryKind === "draft" ? null : entry.identity.threadId,
  );
  const target = targetForEntry(entry);
  const group = isPinnedDraftSummaryEntry(entry) ? "pinned" : getThreadSidebarGroup(entry);
  const lifecycle = entry.entryKind === "draft" ? null : entry.lifecycle;
  const gitArc = entry.entryKind === "draft" ? null : entry.gitArc ?? null;
  const hasActiveGitArc = gitArc?.phase === "active";
  const stashed = gitArc?.phase === "stashed";
  const claimedPaths = stashed ? gitArc.stashedPaths : gitArc?.claimedPaths ?? [];
  const claimedFileCount = claimedPaths.length;
  const showComposerDraft = claimedFileCount === 0 && hasComposerDraft;
  const hasProposedCommit = Boolean(gitArc?.proposals.some(({ status }) => status === "proposed"));
  const waiting = entry.entryKind !== "draft" && Boolean(entry.waitingFor)
    && !(entry.entryKind === "thread" && entry.metadata.snoozed && lifecycle?.kind === "needsAttention");
  const showProposedCommit = !waiting && lifecycle?.kind === "completed" && hasProposedCommit;
  const archived = entry.entryKind === "thread" && group === "archived";
  const status = waiting
    ? "Waiting"
    : showProposedCommit
    ? "Proposed commit"
    : entry.entryKind === "draft"
      ? "Draft"
      : lifecycle?.kind === "needsAttention" ? attentionLabel.trim() || "Needs attention" : lifecycle?.kind === "working" ? "Working" : lifecycle?.kind === "stopped" ? "Stopped" : "Completed";
  const hasAttentionDetails = entry.entryKind !== "draft" && Boolean(
    attentionLabel.trim() || hasProposedCommit
    || ("gitArcPlan" in entry && entry.gitArcPlan?.scopePaths.length)
    || ("pendingQuestionnaire" in entry && entry.pendingQuestionnaire)
    || ("canCompleteQuestionnaire" in entry && entry.canCompleteQuestionnaire)
    || (lifecycle?.kind === "needsAttention" && lifecycle.reason === "pendingInput")
  );
  const tooltipStatus = lifecycle?.kind === "needsAttention" && tooltipDetails && hasAttentionDetails ? "Needs attention" : status;
  const pinned = isPinnedDraftSummaryEntry(entry) ? true : entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
  const timestamp = new Date(entry.activityAt);
  const dateTime = timestamp.toISOString();
  const relativeTime = formatThreadRelativeTimestamp(entry.activityAt / 1000, nowMs);
  const exactTime = timestamp.toLocaleString();
  const { baseAction, shiftAction } = getThreadRowActions(entry, group);
  const action = isShiftPressed && shiftAction ? shiftAction : baseAction;
  const Icon = entry.entryKind === "draft" ? DraftThreadIcon : waiting ? WorkingThreadIcon : showProposedCommit ? ProposedCommitThreadIcon : lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : CompletedThreadIcon;
  const statusTone: WorkbenchThreadStatusTone = waiting
    ? "waiting"
    : lifecycle?.kind === "working"
      ? "working"
    : lifecycle?.kind === "needsAttention"
      ? getNeedsAttentionThreadStatusTone(entry.entryKind === "subagent" ? hasActiveGitArc : !entry.metadata.snoozed)
      : lifecycle?.kind === "stopped"
        ? "stopped"
        : "completed";
  const statusClassName = entry.entryKind === "draft" ? "text-fg/muted" : getWorkbenchThreadStatusClassName(statusTone);
  const priority = group === "snoozed" ? "snoozed" : showPinPriorityIcon && pinned ? "pinned" : null;
  const PriorityIcon = priority === "snoozed" ? SnoozedThreadIcon : priority === "pinned" ? PinIcon : null;
  const actionDisplay = action ? THREAD_ACTIONS[action] : null;
  const projectName = project ? `${project.name || project.id}, ${WorkbenchProjectLabel.getDisplayPath(project)}, ` : "";
  const rowName = `${projectName}${entry.title}, ${status}${claimedFileCount ? `, ${claimedFileCount} ${stashed ? "stashed" : "claimed"} ${claimedFileCount === 1 ? "file" : "files"}` : ""}${showComposerDraft ? ", unsent draft" : ""}${group === "snoozed" ? ", snoozed" : ""}${pinned ? ", pinned" : ""}, ${exactTime}`;
  const dimmed = !selected && (dimmedOverride ?? (group === "snoozed" || group === "settled" || archived));
  const hasDashedBorder = entry.entryKind === "draft" || (!waiting && (lifecycle?.kind === "needsAttention" || lifecycle?.kind === "stopped"));
  const strokeOpacity = entry.entryKind === "draft" ? 0.24 : 1;
  const compact = compactOverride ?? (group === "settled" || archived);
  const actionReplacesPriority = Boolean(actionOverride) || (showActions && Boolean(action));
  const visibleAction = actionOverride ?? (showActions ? actionDisplay : null);
  const actionClassName = `
      pointer-events-auto z-20 row-start-1 -mt-1 -mb-1 ml-0 mr-0 hidden cursor-pointer items-center rounded-lg text-fg/muted focus-visible:flex focus-visible:text-text
      ${isDragActive ? "" : "hover:text-text group-hover/thread-row:flex group-has-[:focus-visible]/thread-row:flex"}
      ${compact ? "col-start-3 self-center" : "col-start-2 self-start"}
      ${!actionOverride && action === "discard" ? "p-1" : "gap-1 px-1.5 py-1 text-[0.72rem] font-medium"}
    `;
  const actionContent = visibleAction ? <>
    <visibleAction.Icon className="size-4" />
    {!actionOverride && action === "discard" ? null : <span>{visibleAction.label}</span>}
  </> : null;
  const actionButton = actionOverride ? (
    <a href={actionOverride.href} aria-label={actionOverride.label} title={actionOverride.label}
      className={actionClassName} onPointerDown={event => event.stopPropagation()} onClick={event => {
        event.stopPropagation();
        actionOverride.onClick?.(event);
      }}>{actionContent}</a>
  ) : showActions && actionDisplay ? (
    <button type="button" aria-label={actionDisplay.label} title={actionDisplay.label} className={actionClassName} onClick={(event) => {
      event.stopPropagation();
      const selectedAction = event.shiftKey && shiftAction ? shiftAction : baseAction;
      if (selectedAction) onAction?.(selectedAction);
    }} onPointerDown={(event) => event.stopPropagation()}>
      {actionContent}
    </button>
  ) : null;
  const contextMenuButton = contextMenu ? (
    <button
      type="button"
      aria-label={`More actions for ${entry.title}`}
      className="pointer-events-auto absolute right-0 top-1/2 z-30 size-11 -translate-y-1/2 items-center justify-center rounded-lg text-fg/muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
      data-thread-context-menu-trigger="true"
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        openContextMenu({ menu: contextMenu, x: rect.right, y: rect.bottom });
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MoreVerticalIcon size={20} />
    </button>
  ) : null;
  const Container = presentation === "disclosure-summary" ? "div" : "li";
  return (
    <Container
      className={`
        group/thread-row relative isolate m-0 min-h-11 list-none md:min-h-0
        ${dimmed ? `opacity-50 ${isDragActive ? "" : "hover:opacity-100 has-[:focus-visible]:opacity-100"}` : ""}
        ${className}
      `}
      data-thread-status-tone={entry.entryKind === "draft" ? "draft" : statusTone}
      role={role === "option" ? "presentation" : undefined}
    >
      <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 size-full transition-opacity duration-75 ease-out ${statusClassName} ${selected ? "opacity-100" : `opacity-0${isDragActive ? "" : " group-hover/thread-row:opacity-100 group-has-[:focus-visible]/thread-row:opacity-100"}`}`}>
        <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="color-mix(in srgb, var(--text) 4%, transparent)" stroke="currentColor" strokeWidth="1" strokeOpacity={strokeOpacity} strokeDasharray={hasDashedBorder ? "6 4" : undefined} vectorEffect="non-scaling-stroke" />
      </svg>
      {presentation === "row" ? <ContextMenuCapability menu={contextMenu}>
        <WorkbenchTooltip
          content={<ThreadTooltipContent claimedPaths={claimedPaths} dateTime={dateTime} exactTime={exactTime} extraDetails={tooltipDetails} Icon={Icon} projectId={projectId} relativeTime={relativeTime} snoozed={group === "snoozed"} status={tooltipStatus} statusClassName={statusClassName} stashed={stashed} title={entry.title} identity={entry.entryKind === "draft" ? undefined : entry.identity} />}
          enabled={showTooltip && !isDragActive}
          interactive
        >
          <a
            data-workbench-sidebar-thread-link="true"
            ref={anchorRef}
            draggable={draggable}
            href={href}
            id={id}
            role={role}
            tabIndex={tabIndex}
            aria-selected={role ? selected : undefined}
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
        </WorkbenchTooltip>
      </ContextMenuCapability> : null}
      {dragTargets}
      {contextMenuButton}
      {compact ? (
        <div
          className="pointer-events-none relative z-10 grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-[var(--thread-context-menu-row-padding-right,0.5rem)] pl-2 md:min-h-0"
          data-thread-context-menu-content={contextMenu ? "true" : undefined}
        >
          <Icon className={`mr-1.5 ${statusClassName}`} size={14} />
          <span className={`${workbenchThreadListLabelClassName} truncate${selected ? " font-semibold text-text" : ""}`}>{entry.title}</span>
          <span className={`col-start-3 row-start-1 inline-flex items-center gap-1.5 text-[0.72rem] text-fg/muted${actionReplacesPriority && !isDragActive ? " group-hover/thread-row:invisible group-has-[:focus-visible]/thread-row:invisible" : ""}`}>
            {PriorityIcon ? <span data-role="thread-priority-icon" data-thread-priority={priority} className="inline-flex size-4 shrink-0 items-center justify-center"><PriorityIcon size={14} /></span> : null}
            <time dateTime={dateTime} title={exactTime}>{relativeTime}</time>
          </span>
          {actionButton}
          {secondaryRow ? <div className="col-span-3 row-start-2 min-w-0 pb-1 text-[0.9em]">{secondaryRow}</div> : null}
        </div>
      ) : (
        <WorkbenchThreadListFullRowContent
          action={(
            <>
              {PriorityIcon ? (
                <span
                  data-role="thread-priority-icon"
                  data-thread-priority={priority}
                  className={`col-start-2 row-start-1 inline-flex size-4 shrink-0 items-center justify-center self-center${actionReplacesPriority && !isDragActive ? " group-hover/thread-row:hidden group-has-[:focus-visible]/thread-row:hidden" : ""}`}
                >
                  <PriorityIcon size={14} />
                </span>
              ) : null}
              {actionButton}
            </>
          )}
          contextMenu={Boolean(contextMenu)}
          eyebrow={project ? <WorkbenchProjectLabel project={project} variant="thread" /> : undefined}
          metadata={(
            <span className="grid items-center">
              {claimedFileCount ? (
                <span data-role={stashed ? "thread-file-stash" : "thread-file-claim"} className="inline-flex items-center gap-0.5" aria-label={`${claimedFileCount} ${stashed ? "stashed" : "claimed"} ${claimedFileCount === 1 ? "file" : "files"}`}>
                  {stashed ? <ArchiveIcon size={14} /> : <FlagIcon size={14} />}<span>{claimedFileCount}</span>
                </span>
              ) : showComposerDraft ? (
                <span data-role="thread-composer-draft" className="inline-flex size-4 items-center justify-center" title="Unsent draft">
                  <ComposerDraftIcon size={14} />
                </span>
              ) : null}
            </span>
          )}
          statusIcon={<Icon className={statusClassName} size={14} />}
          statusLabel={<span className={`truncate ${statusClassName}`}>{status}</span>}
          timestamp={<time dateTime={dateTime} title={exactTime}>{relativeTime}</time>}
          title={<span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold text-text" : ""}`}>{entry.title}</span>}
        />
      )}
    </Container>
  );
}
