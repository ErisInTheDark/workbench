/*
 * Keywords: sidebar, row actions, completion, settlement, priority.
 * Exports:
 * - ThreadRowAction: intents available from a thread row.
 * - getThreadRowActions: choose the primary intent and whether modified activation may settle.
 */
import {
  gitArcPreventsThreadSettlement,
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchSidebarThreadCompletionAvailable,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarGroup,
} from "workbench-shared/workbench/thread/thread-state";

export type ThreadRowAction = "complete" | "discard" | "restore" | "settle" | "wake";

export function getThreadRowActions(
  entry: WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry,
  group: WorkbenchThreadSidebarGroup,
): { baseAction: ThreadRowAction | null; canShiftSettle: boolean } {
  if (entry.entryKind === "draft") return { baseAction: "discard", canShiftSettle: false };
  const hasQuestionnaire = "canCompleteQuestionnaire" in entry
    ? entry.canCompleteQuestionnaire
    : "pendingQuestionnaire" in entry && Boolean(entry.pendingQuestionnaire);
  const canComplete = isWorkbenchSidebarThreadCompletionAvailable(entry)
    && entry.lifecycle.kind === "needsAttention"
    && (!entry.waitingFor || hasQuestionnaire);
  const settlementAvailable = isWorkbenchThreadSettlementAvailable(entry);
  const baseAction = group === "settled" ? "restore" : group === "snoozed" ? "wake"
    : canComplete ? "complete" : settlementAvailable ? "settle" : null;
  return { baseAction, canShiftSettle: canComplete && !hasQuestionnaire && !gitArcPreventsThreadSettlement(entry.gitArc) };
}
