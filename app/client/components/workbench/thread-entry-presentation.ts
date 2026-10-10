/*
 * Exports:
 * - ThreadListEntry: a sidebar thread entry or pinned summary entry.
 * - isPinnedDraftSummaryEntry: identify pinned draft summaries, which carry no full draft.
 * - describeThreadWait: identify explicit compaction or ordinary waiting presentation.
 * - describeThreadEntry: derive a thread entry's group, lifecycle status, icon, tone, claims, and activity time.
 */
import type { ComponentType } from "react";
import {
  getThreadSidebarGroup,
  type WorkbenchPinnedThreadSummaryEntry,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { ThreadSummaryFacts } from "workbench-shared/workbench/thread/thread-summary";
import {
  getNeedsAttentionThreadStatusTone,
  getWorkbenchThreadStatusClassName,
  type WorkbenchThreadStatusTone,
} from "./workbench-thread-status-colors";
import {
  CompletedThreadIcon,
  DraftThreadIcon,
  NeedsAttentionThreadIcon,
  ProposedCommitThreadIcon,
  StoppedThreadIcon,
  WorkingThreadIcon,
  type IconProps,
} from "./workbench-icons";

export type ThreadListEntry = WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry;
type PinnedDraftSummaryEntry = Extract<WorkbenchPinnedThreadSummaryEntry, { entryKind: "draft" }>;

export function isPinnedDraftSummaryEntry(entry: ThreadListEntry): entry is PinnedDraftSummaryEntry {
  return entry.entryKind === "draft" && "draftId" in entry;
}

/** Compaction is a live summary fact; displays without the thread's summary read it as not compacting. */
export function describeThreadWait(entry: ThreadListEntry, facts: ThreadSummaryFacts = {}) {
  const compacting = entry.entryKind !== "draft" && Boolean(facts.compacting);
  const waiting = entry.entryKind !== "draft" && (Boolean(entry.waitingFor) || compacting);
  return { compacting, label: compacting ? "Compacting" : "Waiting", waiting };
}

/** `hasTooltipDetails` says whether the caller adds attention details, which name the tooltip status "Needs attention". */
export function describeThreadEntry(entry: ThreadListEntry, { attentionLabel = "", facts, hasTooltipDetails = false }: {
  attentionLabel?: string;
  /** The thread's live summary facts, when the display leases them. */
  facts?: ThreadSummaryFacts;
  hasTooltipDetails?: boolean;
} = {}) {
  const group = isPinnedDraftSummaryEntry(entry) ? "pinned" : getThreadSidebarGroup(entry);
  const lifecycle = entry.entryKind === "draft" ? null : entry.lifecycle;
  const gitArc = entry.entryKind === "draft" ? null : entry.gitArc ?? null;
  const hasActiveGitArc = gitArc?.phase === "active";
  const claimedPaths = gitArc?.claimedPaths ?? [];
  const stashedPaths = gitArc?.stashedPaths ?? [];
  const stashed = !claimedPaths.length && stashedPaths.length > 0;
  const hasProposedCommit = Boolean(gitArc?.proposals.some(({ status }) => status === "proposed"));
  const wait = describeThreadWait(entry, facts);
  const waiting = wait.waiting;
  const showProposedCommit = !waiting && lifecycle?.kind === "completed" && hasProposedCommit;
  const status = waiting
    ? wait.label
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
  const tooltipStatus = lifecycle?.kind === "needsAttention" && hasTooltipDetails && hasAttentionDetails ? "Needs attention" : status;
  const Icon: ComponentType<IconProps> = entry.entryKind === "draft" ? DraftThreadIcon : waiting ? WorkingThreadIcon : showProposedCommit ? ProposedCommitThreadIcon : lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : CompletedThreadIcon;
  const statusTone: WorkbenchThreadStatusTone = waiting
    ? "waiting"
    : lifecycle?.kind === "working"
      ? "working"
    : lifecycle?.kind === "needsAttention"
      ? getNeedsAttentionThreadStatusTone(entry.entryKind === "subagent" ? hasActiveGitArc : !entry.metadata.snoozed)
      : lifecycle?.kind === "stopped"
        ? "stopped"
        : "completed";
  return {
    activityAt: entry.activityAt,
    claimedPaths,
    group,
    Icon,
    lifecycle,
    showProposedCommit,
    stashed,
    stashedPaths,
    status,
    statusClassName: entry.entryKind === "draft" ? "text-fg/muted" : getWorkbenchThreadStatusClassName(statusTone),
    statusTone,
    tooltipStatus,
    waiting,
  };
}
