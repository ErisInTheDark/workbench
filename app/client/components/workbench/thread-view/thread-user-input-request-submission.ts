/*
 * Exports:
 * - buildPendingUserInputRequestSubmissionOptions: derive durable questionnaire placement from the loaded transcript turns.
 */

import type {
  WorkbenchPendingUserInputRequest,
  WorkbenchSubmitUserInputRequestOptions,
} from "workbench-shared/types";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { isSyntheticQuestionnaireHistoryItem } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import { isWorkbenchMcpQuestionnaireRequestKey } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { isWorkbenchSyntheticSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import { isVisibleWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-recovery-message";

function isQuestionnaireFallbackAnchorItem(item: ThreadItem) {
  if (isWorkbenchSyntheticSteerUserMessage(item)) return false;
  switch (item.type) {
    case "agentMessage":
      return isVisibleWorkbenchAgentMessageText(item.text);
    case "hookPrompt":
    case "reasoning":
    case "userMessage":
      return true;
    default:
      return false;
  }
}

function getQuestionnaireFallbackAnchorIndex(items: readonly ThreadItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isQuestionnaireFallbackAnchorItem(items[index]!)) return index;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type !== "contextCompaction") return index;
  }
  return -1;
}

function isDurableQuestionnairePlacementItem(item: ThreadItem) {
  return !isSyntheticQuestionnaireHistoryItem(item)
    && !isWorkbenchSyntheticSteerUserMessage(item);
}

/** `turns` are the loaded turns with provider items, or null while they are not loaded. */
export function buildPendingUserInputRequestSubmissionOptions(
  turns: readonly Pick<Turn, "id" | "items">[] | null,
  pendingUserInputRequest: WorkbenchPendingUserInputRequest,
): WorkbenchSubmitUserInputRequestOptions {
  const insertAfterItemId = isWorkbenchMcpQuestionnaireRequestKey(pendingUserInputRequest.requestKey)
    ? null
    : pendingUserInputRequest.itemId?.trim() || null;
  if (!turns) {
    return {
      insertAfterItemId,
      insertAfterItemIndex: null,
      turnId: pendingUserInputRequest.turnId,
    };
  }

  const turn = pendingUserInputRequest.turnId
    ? turns.find((candidateTurn) => candidateTurn.id === pendingUserInputRequest.turnId) ?? null
    : turns.at(-1) ?? null;
  if (!turn) {
    return {
      insertAfterItemId,
      insertAfterItemIndex: null,
      turnId: pendingUserInputRequest.turnId,
    };
  }

  const visibleItems = turn.items.filter(isDurableQuestionnairePlacementItem);
  const requestedAnchorIndex = insertAfterItemId
    ? visibleItems.findIndex((item) => item.id === insertAfterItemId)
    : -1;
  const fallbackAnchorIndex = getQuestionnaireFallbackAnchorIndex(visibleItems);
  const resolvedAnchorIndex = requestedAnchorIndex >= 0 ? requestedAnchorIndex : fallbackAnchorIndex;
  const resolvedAnchorItem = resolvedAnchorIndex >= 0 ? visibleItems[resolvedAnchorIndex] : null;

  return {
    insertAfterItemId: resolvedAnchorItem?.id ?? insertAfterItemId,
    insertAfterItemIndex: resolvedAnchorIndex >= 0 ? resolvedAnchorIndex : null,
    turnId: pendingUserInputRequest.turnId ?? turn.id,
  };
}
