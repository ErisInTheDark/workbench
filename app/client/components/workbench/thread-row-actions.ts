/*
 * Exports:
 * - ThreadRowAction: intents available from a thread row.
 * - getThreadRowActions: choose ordinary and shift-only row intents without changing subagent authority; launching drafts take none.
 * - getThreadStopIntent: carry the sidebar's current interruption evidence to the stop owner.
 */
import {
  getWorkbenchLifecycleTurnId,
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchThreadSnoozeAvailable,
  isWorkbenchSidebarThreadCompletionAvailable,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadSidebarGroup,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";

export type ThreadRowAction = "archive" | "complete" | "discard" | "restore" | "settle" | "snooze" | "wake";

export function getThreadStopIntent(entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>) {
  const requestKey = entry.pendingQuestionnaire?.requestKey;
  if (requestKey) return { kind: "stop" as const, requestKey };
  const turnId = entry.lifecycle.kind === "working" ? getWorkbenchLifecycleTurnId(entry.lifecycle) : null;
  return turnId ? { kind: "stop" as const, turnId } : { kind: "stop" as const };
}

export function getThreadRowActions(
  entry: WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry,
  group: WorkbenchThreadSidebarGroup,
  /** The thread's summary facts, whose required todos and addressed feedback hold settlement. */
  facts: Parameters<typeof isWorkbenchThreadSettlementAvailable>[1] = {},
): { baseAction: ThreadRowAction | null; shiftAction: ThreadRowAction | null } {
  if (entry.entryKind === "draft") {
    return { baseAction: "draft" in entry && entry.draft.launching ? null : "discard", shiftAction: null };
  }
  const hasQuestionnaire = "canCompleteQuestionnaire" in entry
    ? entry.canCompleteQuestionnaire
    : "pendingQuestionnaire" in entry && Boolean(entry.pendingQuestionnaire);
  const canComplete = isWorkbenchSidebarThreadCompletionAvailable(entry)
    && entry.lifecycle.kind === "needsAttention"
    && (!entry.waitingFor || hasQuestionnaire);
  const settlementAvailable = isWorkbenchThreadSettlementAvailable(entry, facts);
  const canSnooze = isWorkbenchThreadSnoozeAvailable(entry);
  const baseAction = group === "settled" || group === "archived" ? "restore" : group === "snoozed" ? "wake"
    : (canComplete || entry.lifecycle.kind === "working") && canSnooze ? "snooze" : settlementAvailable ? "settle" : null;
  const shiftAction = entry.entryKind === "subagent" ? null
    : group === "settled" ? "archive"
    : group === "snoozed" && entry.lifecycle.kind === "completed" && settlementAvailable ? "settle"
    : group !== "archived" && group !== "snoozed" && entry.lifecycle.kind === "needsAttention" ? canComplete ? "complete" : canSnooze ? "snooze" : null
    : group !== "archived" && group !== "snoozed" && entry.lifecycle.kind === "completed" && canSnooze ? "snooze"
    : null;
  return { baseAction, shiftAction };
}
