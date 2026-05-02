/*
 * Exports:
 * - WORKBENCH_QUESTIONNAIRE_TOOL_NAME: stable dynamic-tool name used for rendered questionnaire history entries. Keywords: questionnaire, dynamic tool, thread history.
 * - SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX: item id prefix reserved for workbench-injected questionnaire history items. Keywords: synthetic, questionnaire, history.
 * - applyQuestionnaireHistoryToThread: strip prior synthetic questionnaire items and reinsert persisted questionnaire history into Codex thread turns. Keywords: questionnaire, thread, overlay, persisted history.
 */

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload, WorkbenchQuestionnaireHistoryEntry } from "../../types";

export const WORKBENCH_QUESTIONNAIRE_TOOL_NAME = "workbench_request_user_input";
export const SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX = "workbench:questionnaire-history:";

type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

function createSyntheticQuestionnaireHistoryItemId(threadId: string, requestKey: string) {
  return `${SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX}${threadId}:${requestKey}`;
}

function isSyntheticQuestionnaireHistoryItem(item: ThreadItem) {
  return item.type === "dynamicToolCall"
    && item.id.startsWith(SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX);
}

function stripSyntheticQuestionnaireHistoryItems(items: ThreadItem[]) {
  return items.filter((item) => !isSyntheticQuestionnaireHistoryItem(item));
}

function createSyntheticQuestionnaireHistoryItem(entry: WorkbenchQuestionnaireHistoryEntry): DynamicToolCallItem {
  return {
    arguments: entry.request as unknown as DynamicToolCallItem["arguments"],
    contentItems: [{
      text: JSON.stringify(entry.response, null, 2),
      type: "inputText",
    }],
    durationMs: null,
    id: createSyntheticQuestionnaireHistoryItemId(entry.threadId, entry.requestKey),
    namespace: null,
    status: "completed",
    success: true,
    tool: WORKBENCH_QUESTIONNAIRE_TOOL_NAME,
    type: "dynamicToolCall",
  };
}

function getFinalAgentMessageInsertIndex(items: ThreadItem[]) {
  let fallbackIndex = -1;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "agentMessage" || !item.text.trim()) {
      continue;
    }

    if (item.phase === "final_answer") {
      return index;
    }

    if (fallbackIndex === -1) {
      fallbackIndex = index;
    }
  }

  return fallbackIndex;
}

function sortQuestionnaireHistoryEntries(entries: WorkbenchQuestionnaireHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.resolvedAt !== right.resolvedAt) {
      return left.resolvedAt - right.resolvedAt;
    }

    return left.requestKey.localeCompare(right.requestKey);
  });
}

function applyQuestionnaireHistoryToItems(
  items: ThreadItem[],
  entries: WorkbenchQuestionnaireHistoryEntry[],
) {
  const nextItems = stripSyntheticQuestionnaireHistoryItems(items);

  for (const entry of sortQuestionnaireHistoryEntries(entries)) {
    const syntheticItem = createSyntheticQuestionnaireHistoryItem(entry);
    const anchorIndex = entry.insertAfterItemId
      ? nextItems.findIndex((item) => item.id === entry.insertAfterItemId)
      : -1;

    if (anchorIndex >= 0) {
      nextItems.splice(anchorIndex + 1, 0, syntheticItem);
      continue;
    }

    const finalAgentMessageIndex = getFinalAgentMessageInsertIndex(nextItems);
    const insertIndex = finalAgentMessageIndex >= 0 ? finalAgentMessageIndex : nextItems.length;
    nextItems.splice(insertIndex, 0, syntheticItem);
  }

  return nextItems;
}

export function applyQuestionnaireHistoryToThread(
  thread: ThreadPayload,
  entries: WorkbenchQuestionnaireHistoryEntry[],
) {
  if (thread.harness !== "codex") {
    return thread;
  }

  const entriesByTurnId = new Map<string, WorkbenchQuestionnaireHistoryEntry[]>();
  for (const entry of entries) {
    if (entry.threadId !== thread.id) {
      continue;
    }

    const turnEntries = entriesByTurnId.get(entry.turnId) ?? [];
    turnEntries.push(entry);
    entriesByTurnId.set(entry.turnId, turnEntries);
  }

  return {
    ...thread,
    turns: thread.turns.map((turn) => ({
      ...turn,
      items: applyQuestionnaireHistoryToItems(turn.items, entriesByTurnId.get(turn.id) ?? []),
    })),
  };
}
