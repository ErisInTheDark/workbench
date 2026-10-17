/*
 * Exports:
 * - default WorkbenchThreadListItem: render a thread row or disclosure body with shared status (optionally led by a label), optional action slot, navigation and context menu.
 * - WorkbenchPendingThreadListItem: render a placed row's title and activity with a loading status until its summary lands.
 * Status derivation is shared through thread-entry-presentation.
 */
"use client";

import type { ComponentType, DragEventHandler, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, ReactNode, Ref } from "react";

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { ProjectId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import ContextMenuCapability from "./ContextMenuCapability";
import ThreadTooltipContent from "./WorkbenchThreadTooltipContent";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import { describeThreadEntry, isPinnedDraftSummaryEntry, type ThreadListEntry } from "./thread-entry-presentation";
import { workbenchThreadListLabelClassName } from "./workbench-class-names";
import {
  ArchiveIcon,
  DiscardDraftIcon,
  MoreVerticalIcon,
  PinIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  UnsnoozeThreadIcon,
  type IconProps,
} from "./workbench-icons";
import { useWorkbenchComposerDraftPresence } from "./WorkbenchComposerDraftPresenceProvider";
import WorkbenchThreadEntryBadge from "./WorkbenchThreadEntryBadge";
import { useThread } from "./use-thread";
import WorkbenchDraftTitleIcons from "./WorkbenchDraftTitleIcons";
import { useWorkbenchSubagentClaims } from "./use-workbench-subagent-claims";
import { useWorkbenchContextMenu, type WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import Tooltip from "../ui/Tooltip";
import WorkbenchRelativeTime from "./WorkbenchRelativeTime";
import { formatLongTimestamp } from "./thread-view/thread-view-formatters";
import WorkbenchThreadListFullRowContent from "./WorkbenchThreadListFullRowContent";
import LoaderIcon from "./LoaderIcon";
import { getThreadRowActions, type ThreadRowAction } from "./thread-row-actions";

/**
 * A placed row whose thread summary has not landed: its title and activity show at once, a spinner holds the status
 * slot, and badges, actions and tooltip details wait for the summary.
 */
export function WorkbenchPendingThreadListItem({ activityAt, href, project, title }: {
  activityAt: number;
  href?: string;
  project?: WorkbenchProjectOption | WorkbenchLogicalProject;
  title: string;
}) {
  return (
    <li className="group/thread-row relative isolate m-0 min-h-11 list-none md:min-h-0" aria-busy="true">
      <a
        data-workbench-sidebar-thread-link="true"
        href={href}
        tabIndex={-1}
        aria-label={`${project ? `${"matchKey" in project ? project.label : project.id}, ` : ""}${title}, loading`}
        className="absolute inset-0 z-10 cursor-pointer rounded-[0.8rem] border border-transparent outline-none"
      />
      <div className="pointer-events-none relative z-10 grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-2 pl-2 md:min-h-8">
        <LoaderIcon className="mr-1.5 text-fg/muted" size={16} />
        <span className={`${workbenchThreadListLabelClassName} min-w-0 truncate text-fg/muted`}>{title}</span>
        <span className="ml-2 text-[0.72rem] text-fg/muted"><WorkbenchRelativeTime timestampMs={activityAt} tooltip={false} /></span>
      </div>
    </li>
  );
}

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

function targetForEntry(entry: ThreadListEntry): WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
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
  onAction,
  onActivate,
  onDragStart,
  onKeyDown,
  onPointerDown,
  project,
  projectSource,
  presentation = "row",
  projectId,
  role,
  selected = false,
  secondaryRow,
  showActions = false,
  showFrame = true,
  showPinPriorityIcon = false,
  showTooltip = true,
  statusLeading,
  tabIndex,
  tooltipDetails,
  trailing,
}: {
  action?: { Icon: ThreadStatusIcon; label: string; href: string };
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
  onAction?: (action: ThreadAction) => void;
  onActivate?: (target: WorkbenchThreadTarget) => void;
  onDragStart?: DragEventHandler<HTMLAnchorElement>;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLAnchorElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLAnchorElement>) => void;
  project?: WorkbenchProjectOption | WorkbenchLogicalProject;
  projectSource?: ProjectLocationReference;
  presentation?: "row" | "disclosure-summary";
  projectId: ProjectId;
  role?: "tab" | "option";
  selected?: boolean;
  secondaryRow?: ReactNode;
  /** Replaces the activity timestamp, such as a figure the surrounding list is ranked by. */
  trailing?: ReactNode;
  showActions?: boolean;
  /** Draw the status-coloured hover/selected outline; hosts that draw their own status border turn it off. */
  showFrame?: boolean;
  showPinPriorityIcon?: boolean;
  showTooltip?: boolean;
  /** Full layout only: shown before the status, such as a coloured subagent name. */
  statusLeading?: ReactNode;
  tabIndex?: number;
  tooltipDetails?: ReactNode;
}) {
  const { openContextMenu } = useWorkbenchContextMenu();
  const hasComposerDraft = useWorkbenchComposerDraftPresence(
    projectId,
    entry.entryKind === "draft" ? null : entry.identity.threadId,
  );
  const target = targetForEntry(entry);
  const facts = useThread.summary(entry.entryKind === "draft" ? null : entry.identity.threadId)?.summary.facts;
  const requiredTodoCount = facts?.requiredTodoCount ?? 0;
  const {
    activityAt, claimedPaths, group, Icon, lifecycle, showProposedCommit,
    stashed, stashedPaths, status, statusClassName, statusTone, tooltipStatus, waiting,
  } = describeThreadEntry(entry, { attentionLabel, facts, hasTooltipDetails: Boolean(tooltipDetails) });
  // Row text is pointer-transparent under the link overlay; the row tooltip's own time carries the full form.
  const rowTime = <WorkbenchRelativeTime timestampMs={activityAt} tooltip={false} />;
  const subagentClaims = useWorkbenchSubagentClaims(projectId, entry.entryKind === "thread" ? entry.identity.threadId : null);
  const activeClaimCount = claimedPaths.length + subagentClaims.reduce((total, child) => total + child.claimedPaths.length, 0);
  const proposalCount = entry.entryKind === "draft"
    ? 0
    : entry.gitArc?.proposals.filter(({ status: proposalStatus }) => proposalStatus === "proposed").length ?? 0;
  const stashedClaimCount = stashedPaths.length;
  const feedbackCount = entry.entryKind === "thread" && lifecycle?.kind === "completed"
    ? facts?.addressedFeedbackCount ?? 0
    : 0;
  const hasDraftImages = entry.entryKind === "draft"
    && (isPinnedDraftSummaryEntry(entry) ? entry.hasAttachments : entry.draft.attachments.length > 0);
  const draftReferenceKinds = entry.entryKind !== "draft" ? []
    : isPinnedDraftSummaryEntry(entry) ? entry.referenceKinds : entry.draft.referenceKinds;
  const titleContent = <span className="inline-flex min-w-0 items-center gap-1">
    <WorkbenchDraftTitleIcons hasImages={hasDraftImages} referenceKinds={draftReferenceKinds} />
    <span className="truncate">{entry.title}</span>
  </span>;
  const archived = entry.entryKind === "thread" && group === "archived";
  const pinned = isPinnedDraftSummaryEntry(entry) ? true : entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
  const { baseAction, shiftAction } = getThreadRowActions(entry, group, { requiredTodoCount });
  const action = isShiftPressed && shiftAction ? shiftAction : baseAction;
  const priority = group === "snoozed" ? "snoozed" : showPinPriorityIcon && pinned ? "pinned" : null;
  const PriorityIcon = priority === "snoozed" ? SnoozedThreadIcon : priority === "pinned" ? PinIcon : null;
  const actionDisplay = action ? THREAD_ACTIONS[action] : null;
  const projectName = project ? "matchKey" in project ? `${project.label}, `
    : `${project.name || project.id}, ${WorkbenchProjectLabel.getDisplayPath(project)}, ` : "";
  const gitWorkLabels = [
    hasComposerDraft ? "unsent draft" : "",
    requiredTodoCount ? `${requiredTodoCount} required ${requiredTodoCount === 1 ? "todo" : "todos"}` : "",
    feedbackCount ? `${feedbackCount} addressed feedback ${feedbackCount === 1 ? "report" : "reports"}` : "",
    proposalCount ?`${proposalCount} ${proposalCount === 1 ? "proposal" : "proposals"}` : "",
    activeClaimCount ? `${activeClaimCount} claimed ${activeClaimCount === 1 ? "file" : "files"}` : "",
    stashedClaimCount ? `${stashedClaimCount} stashed ${stashedClaimCount === 1 ? "file" : "files"}` : "",
  ].filter(Boolean);
  const rowName = `${projectName}${entry.title}${hasDraftImages ? ", includes image" : ""}, ${status}${gitWorkLabels.length ? `, ${gitWorkLabels.join(", ")}` : ""}${group === "snoozed" ? ", snoozed" : ""}${pinned ? ", pinned" : ""}, ${formatLongTimestamp(activityAt)}`;
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
      className={actionClassName} onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}>{actionContent}</a>
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
      className="pointer-events-auto absolute right-0 top-1/2 z-30 hidden size-11 -translate-y-1/2 items-center justify-center rounded-lg text-fg/muted transition coarse-touch:inline-flex hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
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
      {showFrame ? <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 size-full transition-opacity duration-75 ease-out ${statusClassName} ${selected ? "opacity-100" : `opacity-0${isDragActive ? "" : " group-hover/thread-row:opacity-100 group-has-[:focus-visible]/thread-row:opacity-100"}`}`}>
        <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="color-mix(in srgb, var(--text) 4%, transparent)" stroke="currentColor" strokeWidth="1" strokeOpacity={strokeOpacity} strokeDasharray={hasDashedBorder ? "6 4" : undefined} vectorEffect="non-scaling-stroke" />
      </svg> : null}
      {presentation === "row" ? <ContextMenuCapability menu={contextMenu}>
        <Tooltip
          content={showTooltip
            ? <ThreadTooltipContent activityAt={activityAt} claimedPaths={claimedPaths} extraDetails={tooltipDetails} Icon={Icon} projectId={projectId} snoozed={group === "snoozed"} status={tooltipStatus} statusClassName={statusClassName} stashed={stashed} subagentClaims={subagentClaims} title={entry.title} identity={entry.entryKind === "draft" ? undefined : entry.identity} />
            // Without the rich tooltip, the row still offers the full time its pointer-transparent timestamp cannot.
            : <span className="whitespace-nowrap">Last activity: {formatLongTimestamp(activityAt)}</span>}
          enabled={!isDragActive && (showTooltip || trailing === undefined)}
          interactive={showTooltip}
          placement={showTooltip ? "right" : "top"}
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
            onKeyDown={(event) => {
              // Rows are tabs and options, so Space activates them like Enter does; a click follows the row's href.
              if ((onActivate || href) && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                if (onActivate) onActivate(target);
                else event.currentTarget.click();
                return;
              }
              onKeyDown?.(event);
            }}
            onDragStart={onDragStart}
            onPointerDown={onPointerDown}
          />
        </Tooltip>
      </ContextMenuCapability> : null}
      {dragTargets}
      {contextMenuButton}
      {compact ? (
        <div
          className={`
            pointer-events-none relative z-10 grid min-h-11 min-w-0
            grid-cols-[auto minmax(0, 1fr) auto] items-center py-1 pr-2 pl-2 md:min-h-0
            ${contextMenu ? "coarse-touch:pr-12" : ""}
          `}
        >
          <Icon className={`mr-1.5 ${statusClassName}`} size={16} />
          <span className={`${workbenchThreadListLabelClassName} min-w-0 truncate${selected ? " font-semibold text-text" : ""}`}>{titleContent}</span>
          <span className={`col-start-3 row-start-1 ml-2 inline-flex items-center gap-1.5 text-[0.72rem] text-fg/muted${actionReplacesPriority && !isDragActive ? " group-hover/thread-row:invisible group-has-[:focus-visible]/thread-row:invisible" : ""}`}>
            <WorkbenchThreadEntryBadge claimedCount={activeClaimCount} feedbackCount={feedbackCount} hasComposerDraft={hasComposerDraft} proposalCount={proposalCount} stashedCount={stashedClaimCount} requiredTodoCount={requiredTodoCount} />
            {PriorityIcon ? <span data-role="thread-priority-icon" data-thread-priority={priority} className="inline-flex size-4 shrink-0 items-center justify-center"><PriorityIcon size={16} /></span> : null}
            {trailing ?? rowTime}
          </span>
          {actionButton}
          {secondaryRow ? <div className="col-span-3 row-start-2 min-w-0 pb-1 text-[0.9em]">{secondaryRow}</div> : null}
        </div>
      ) : (<>
        <WorkbenchThreadListFullRowContent
          action={(
            <>
              {PriorityIcon ? (
                <span
                  data-role="thread-priority-icon"
                  data-thread-priority={priority}
                  className={`col-start-2 row-start-1 inline-flex size-4 shrink-0 items-center justify-center self-center${actionReplacesPriority && !isDragActive ? " group-hover/thread-row:hidden group-has-[:focus-visible]/thread-row:hidden" : ""}`}
                >
                  <PriorityIcon size={16} />
                </span>
              ) : null}
              {actionButton}
            </>
          )}
          contextMenu={Boolean(contextMenu)}
          eyebrow={project ? (
            <span className="flex min-w-0 items-center gap-2">
              {project ? <WorkbenchProjectLabel project={project} source={projectSource} variant="thread" /> : null}
            </span>
          ) : undefined}
          metadata={(
            <span className="grid items-center">
              <WorkbenchThreadEntryBadge claimedCount={activeClaimCount} feedbackCount={feedbackCount} hasComposerDraft={hasComposerDraft} proposalCount={proposalCount} stashedCount={stashedClaimCount} requiredTodoCount={requiredTodoCount} />
            </span>
          )}
          statusIcon={<Icon className={statusClassName} size={16} />}
          statusLabel={<span className={`truncate ${statusClassName}`}>{status}</span>}
          statusLeading={statusLeading}
          timestamp={trailing ?? rowTime}
          title={<span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold text-text" : ""}`}>{titleContent}</span>}
        />
        {secondaryRow ? <div className="pointer-events-none relative z-10 min-w-0 px-2 pb-1.5 text-[0.72rem] text-fg/muted">{secondaryRow}</div> : null}
      </>)}
    </Container>
  );
}
