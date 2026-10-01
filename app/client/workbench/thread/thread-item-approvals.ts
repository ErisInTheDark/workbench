/*
 * Exports:
 * - ThreadItemApprovalState: the approval glyph a tool item shows, from its live request or recorded outcome.
 * - deriveThreadItemApprovals: index one thread's outcomes and live pending approval by tool item.
 * - ThreadItemApprovalsContext/useThreadItemApproval: thread-scoped lookup for tool summary lines.
 */
import { createContext, useContext } from "react";
import type { WorkbenchPendingUserInputRequest } from "workbench-shared/types";
import type { WorkbenchApprovalOutcome, WorkbenchApprovalOutcomeEntry } from "workbench-shared/workbench/provider/provider-approval";
import { isWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-user-input-requests";

export type ThreadItemApprovalState = "pending" | WorkbenchApprovalOutcome;

const EMPTY: ReadonlyMap<string, ThreadItemApprovalState> = new Map();

export function deriveThreadItemApprovals(
  entries: readonly WorkbenchApprovalOutcomeEntry[],
  pending: WorkbenchPendingUserInputRequest | null,
): ReadonlyMap<string, ThreadItemApprovalState> {
  const pendingItemId = pending?.itemId && isWorkbenchApprovalRequest(pending.request) ? pending.itemId : null;
  if (!entries.length && !pendingItemId) return EMPTY;
  const states = new Map<string, ThreadItemApprovalState>(entries.map(entry => [entry.itemId, entry.outcome]));
  // A live request outranks an earlier outcome for the same item: the tool is asking again.
  if (pendingItemId) states.set(pendingItemId, "pending");
  return states;
}

export const ThreadItemApprovalsContext = createContext<ReadonlyMap<string, ThreadItemApprovalState>>(EMPTY);

export function useThreadItemApproval(itemId: string): ThreadItemApprovalState | null {
  return useContext(ThreadItemApprovalsContext).get(itemId) ?? null;
}
