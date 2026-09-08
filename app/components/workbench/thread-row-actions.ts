/*
 * Keywords: sidebar, row actions, completion, settlement, priority.
 * Exports:
 * - ThreadRowAction: intents available from a thread row.
 * - getThreadRowActions: choose ordinary and shift-only row intents without changing subagent authority.
 */
import {
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchSidebarThreadCompletionAvailable,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarGroup,
} from "workbench-shared/workbench/thread/thread-state";

export type ThreadRowAction = "archive" | "complete" | "discard" | "restore" | "settle" | "snooze" | "wake";

export function getThreadRowActions(
  entry: WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry,
  group: WorkbenchThreadSidebarGroup,
): { baseAction: ThreadRowAction | null; shiftAction: ThreadRowAction | null } {
  if (entry.entryKind === "draft") return { baseAction: "discard", shiftAction: null };
  const hasQuestionnaire = "canCompleteQuestionnaire" in entry
    ? entry.canCompleteQuestionnaire
    : "pendingQuestionnaire" in entry && Boolean(entry.pendingQuestionnaire);
  const canComplete = isWorkbenchSidebarThreadCompletionAvailable(entry)
    && entry.lifecycle.kind === "needsAttention"
    && (!entry.waitingFor || hasQuestionnaire);
  const settlementAvailable = isWorkbenchThreadSettlementAvailable(entry);
  const baseAction = group === "settled" || group === "archived" ? "restore" : group === "snoozed" ? "wake"
    : canComplete ? "complete" : settlementAvailable ? "settle" : null;
  const shiftAction = entry.entryKind === "subagent" ? null
    : group === "settled" ? "archive"
    : group !== "archived" && group !== "snoozed" && entry.lifecycle.kind === "needsAttention" ? "snooze"
    : null;
  return { baseAction, shiftAction };
}
