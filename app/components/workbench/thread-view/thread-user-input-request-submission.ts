/*
 * Exports:
 * - buildPendingUserInputRequestSubmissionOptions: derive durable questionnaire placement from an optional loaded thread and the pending request identity. Keywords: questionnaire, submission, transcript, placement.
 */

import { getCurrentInProgressTurn } from "workbench-shared/codex/thread-state";
import type {
  ThreadPayload,
  WorkbenchPendingUserInputRequest,
  WorkbenchSubmitUserInputRequestOptions,
} from "workbench-shared/types";
import { isSyntheticQuestionnaireHistoryItem } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import { isWorkbenchSyntheticSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";

function isQuestionnaireFallbackAnchorItem(item: ThreadPayload["turns"][number]["items"][number]) {
  if (isWorkbenchSyntheticSteerUserMessage(item)) return false;
  switch (item.type) {
    case "agentMessage":
      return Boolean(item.text.trim());
    case "hookPrompt":
    case "plan":
    case "reasoning":
    case "userMessage":
      return true;
    default:
      return false;
  }
}

function getQuestionnaireFallbackAnchorIndex(items: ThreadPayload["turns"][number]["items"]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isQuestionnaireFallbackAnchorItem(items[index]!)) return index;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type !== "contextCompaction") return index;
  }
  return -1;
}

function isDurableQuestionnairePlacementItem(item: ThreadPayload["turns"][number]["items"][number]) {
  return !isSyntheticQuestionnaireHistoryItem(item)
    && !isWorkbenchSyntheticSteerUserMessage(item);
}

export function buildPendingUserInputRequestSubmissionOptions(
  thread: ThreadPayload | null,
  pendingUserInputRequest: WorkbenchPendingUserInputRequest,
): WorkbenchSubmitUserInputRequestOptions {
  const insertAfterItemId = pendingUserInputRequest.itemId?.trim() || null;
  if (!thread) {
    return {
      insertAfterItemId,
      insertAfterItemIndex: null,
      turnId: pendingUserInputRequest.turnId,
    };
  }

  const turn = pendingUserInputRequest.turnId
    ? thread.turns.find((candidateTurn) => candidateTurn.id === pendingUserInputRequest.turnId) ?? null
    : getCurrentInProgressTurn(thread) ?? thread.turns.at(-1) ?? null;
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
