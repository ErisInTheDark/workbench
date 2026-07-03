/*
 * Exports:
 * - WORKBENCH_QUESTIONNAIRE_TOOL_NAME: stable dynamic-tool name used for rendered questionnaire history entries. Keywords: questionnaire, dynamic tool, thread history.
 * - SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX: item id prefix reserved for workbench-injected questionnaire history items. Keywords: synthetic, questionnaire, history.
 * - isSyntheticQuestionnaireHistoryItem: detect workbench-injected questionnaire history items in a turn. Keywords: synthetic, questionnaire, history, guard.
 * - applyQuestionnaireHistoryToThread: strip duplicate questionnaire items and reinsert persisted questionnaire history into supported thread turns. Keywords: questionnaire, thread, overlay, persisted history, codex, opencode.
 */

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload, WorkbenchQuestionnaireHistoryEntry } from "../../types";
import { areDeeplyEqual } from "../deep-equality";
import { isWorkbenchSyntheticSteerUserMessage } from "./thread-steer-history";

export const WORKBENCH_QUESTIONNAIRE_TOOL_NAME = "workbench_request_user_input";
export const SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX = "workbench:questionnaire-history:";
const OPENCODE_QUESTION_TOOL_NAMESPACE = "opencode";
const OPENCODE_QUESTION_TOOL_NAME = "question";

type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

type QuestionnaireHistoryAnchorResolution =
  | { index: number; type: "resolved" }
  | { type: "defer" }
  | { type: "fallback" };

function createSyntheticQuestionnaireHistoryItemId(threadId: string, requestKey: string) {
  return `${SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX}${threadId}:${requestKey}`;
}

export function isSyntheticQuestionnaireHistoryItem(item: ThreadItem): item is DynamicToolCallItem {
  return item.type === "dynamicToolCall"
    && item.id.startsWith(SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX);
}

function isWorkbenchQuestionnaireToolCallItem(item: ThreadItem): item is DynamicToolCallItem {
  return item.type === "dynamicToolCall"
    && item.tool === WORKBENCH_QUESTIONNAIRE_TOOL_NAME;
}

function isOpenCodeQuestionToolCallItem(item: ThreadItem): item is DynamicToolCallItem {
  return item.type === "dynamicToolCall"
    && item.namespace === OPENCODE_QUESTION_TOOL_NAMESPACE
    && item.tool === OPENCODE_QUESTION_TOOL_NAME;
}

function isQuestionnaireToolCallItem(item: ThreadItem): item is DynamicToolCallItem {
  return isWorkbenchQuestionnaireToolCallItem(item) || isOpenCodeQuestionToolCallItem(item);
}

function readQuestionnaireHistoryResponseText(item: DynamicToolCallItem) {
  const firstContentItem = item.contentItems?.[0];
  return item.contentItems?.length === 1 && firstContentItem?.type === "inputText"
    ? firstContentItem.text
    : null;
}

function isQuestionnaireHistoryResponseTextForEntry(item: DynamicToolCallItem, entry: WorkbenchQuestionnaireHistoryEntry) {
  return readQuestionnaireHistoryResponseText(item) === buildSyntheticQuestionnaireHistoryResponseText(entry);
}

function isMatchingPersistedQuestionnaireToolCallItem(
  item: DynamicToolCallItem,
  entry: WorkbenchQuestionnaireHistoryEntry,
) {
  if (entry.itemId && item.id === entry.itemId) {
    return true;
  }

  return areDeeplyEqual(item.arguments, entry.request)
    && isQuestionnaireHistoryResponseTextForEntry(item, entry);
}

function isRedundantPersistedQuestionnaireToolCallItem(
  item: ThreadItem,
  entries: WorkbenchQuestionnaireHistoryEntry[],
) {
  return isQuestionnaireToolCallItem(item)
    && item.status === "completed"
    && entries.some((entry) => isMatchingPersistedQuestionnaireToolCallItem(item, entry));
}

function stripQuestionnaireHistoryOverlayItems(
  items: ThreadItem[],
  entries: WorkbenchQuestionnaireHistoryEntry[],
) {
  const nextItems: ThreadItem[] = [];
  for (const item of items) {
    if (
      isSyntheticQuestionnaireHistoryItem(item)
      || isRedundantPersistedQuestionnaireToolCallItem(item, entries)
      || isWorkbenchSyntheticSteerUserMessage(item)
    ) {
      continue;
    }

    nextItems.push(item);
  }

  return nextItems;
}

function buildSyntheticQuestionnaireHistoryResponseText(entry: WorkbenchQuestionnaireHistoryEntry) {
  return JSON.stringify(entry.response, null, 2);
}

function isEquivalentSyntheticQuestionnaireHistoryItem(
  item: DynamicToolCallItem,
  entry: WorkbenchQuestionnaireHistoryEntry,
) {
  const firstContentItem = item.contentItems?.[0];
  return item.tool === WORKBENCH_QUESTIONNAIRE_TOOL_NAME
    && item.id === createSyntheticQuestionnaireHistoryItemId(entry.threadId, entry.requestKey)
    && item.status === "completed"
    && item.success === true
    && item.namespace === null
    && item.durationMs === null
    && areDeeplyEqual(item.arguments, entry.request)
    && item.contentItems?.length === 1
    && firstContentItem?.type === "inputText"
    && firstContentItem.text === buildSyntheticQuestionnaireHistoryResponseText(entry);
}

function createSyntheticQuestionnaireHistoryItem(
  entry: WorkbenchQuestionnaireHistoryEntry,
  existingItem: DynamicToolCallItem | null = null,
): DynamicToolCallItem {
  if (existingItem && isEquivalentSyntheticQuestionnaireHistoryItem(existingItem, entry)) {
    return existingItem;
  }

  return {
    arguments: entry.request as unknown as DynamicToolCallItem["arguments"],
    contentItems: [{
      text: buildSyntheticQuestionnaireHistoryResponseText(entry),
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

function isQuestionnaireHistoryAnchorItem(item: ThreadItem) {
  if (isWorkbenchSyntheticSteerUserMessage(item)) {
    return false;
  }

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

function sortQuestionnaireHistoryEntries(entries: WorkbenchQuestionnaireHistoryEntry[]) {
  return entries.filter((entry) => !entry.hidden).sort((left, right) => {
    if (left.resolvedAt !== right.resolvedAt) {
      return left.resolvedAt - right.resolvedAt;
    }

    return left.requestKey.localeCompare(right.requestKey);
  });
}

function areThreadItemArraysIdentical(left: ThreadItem[], right: ThreadItem[]) {
  return left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function collectSyntheticQuestionnaireHistoryItems(items: ThreadItem[]) {
  const syntheticItemsById = new Map<string, DynamicToolCallItem>();
  for (const item of items) {
    if (!isSyntheticQuestionnaireHistoryItem(item)) {
      continue;
    }

    syntheticItemsById.set(item.id, item);
  }
  return syntheticItemsById;
}

function hasQuestionnaireHistoryAnchorMetadata(entry: WorkbenchQuestionnaireHistoryEntry) {
  return Boolean(entry.insertAfterItemId)
    || (entry.insertAfterItemIndex !== null && entry.insertAfterItemIndex >= 0);
}

function resolveQuestionnaireHistoryAnchor(
  nextItems: ThreadItem[],
  baseItems: ThreadItem[],
  entry: WorkbenchQuestionnaireHistoryEntry,
  itemsView: ThreadPayload["turns"][number]["itemsView"],
): QuestionnaireHistoryAnchorResolution {
  if (entry.insertAfterItemId) {
    const anchorIndex = nextItems.findIndex((item) => item.id === entry.insertAfterItemId);
    if (anchorIndex >= 0 && isQuestionnaireHistoryAnchorItem(nextItems[anchorIndex]!)) {
      return { index: anchorIndex, type: "resolved" };
    }

    if (itemsView !== "full") {
      return { type: "defer" };
    }
  }

  if (
    entry.insertAfterItemIndex !== null
    && entry.insertAfterItemIndex >= 0
    && entry.insertAfterItemIndex < baseItems.length
  ) {
    for (let baseIndex = entry.insertAfterItemIndex; baseIndex >= 0; baseIndex -= 1) {
      const baseAnchorItem = baseItems[baseIndex];
      if (!baseAnchorItem || !isQuestionnaireHistoryAnchorItem(baseAnchorItem)) {
        continue;
      }

      const anchorIndex = nextItems.findIndex((item) => item.id === baseAnchorItem.id);
      if (anchorIndex >= 0 && isQuestionnaireHistoryAnchorItem(nextItems[anchorIndex]!)) {
        return { index: anchorIndex, type: "resolved" };
      }
    }
  }

  return hasQuestionnaireHistoryAnchorMetadata(entry)
    ? { type: "defer" }
    : { type: "fallback" };
}

function applyQuestionnaireHistoryToItems(
  items: ThreadItem[],
  entries: WorkbenchQuestionnaireHistoryEntry[],
  itemsView: ThreadPayload["turns"][number]["itemsView"],
) {
  const syntheticItemsById = collectSyntheticQuestionnaireHistoryItems(items);
  const baseItems = stripQuestionnaireHistoryOverlayItems(items, entries);
  const nextItems = [...baseItems];

  for (const entry of sortQuestionnaireHistoryEntries(entries)) {
    const syntheticItem = createSyntheticQuestionnaireHistoryItem(
      entry,
      syntheticItemsById.get(createSyntheticQuestionnaireHistoryItemId(entry.threadId, entry.requestKey)) ?? null,
    );
    const anchorResolution = resolveQuestionnaireHistoryAnchor(nextItems, baseItems, entry, itemsView);

    if (anchorResolution.type === "resolved") {
      nextItems.splice(anchorResolution.index + 1, 0, syntheticItem);
      continue;
    }

    if (anchorResolution.type === "defer") {
      continue;
    }

    const finalAgentMessageIndex = getFinalAgentMessageInsertIndex(nextItems);
    const insertIndex = finalAgentMessageIndex >= 0 ? finalAgentMessageIndex : nextItems.length;
    nextItems.splice(insertIndex, 0, syntheticItem);
  }

  return areThreadItemArraysIdentical(items, nextItems)
    ? items
    : nextItems;
}

export function applyQuestionnaireHistoryToThread(
  thread: ThreadPayload,
  entries: WorkbenchQuestionnaireHistoryEntry[],
) {
  if (thread.harness !== "codex" && thread.harness !== "opencode") {
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

  let didChange = false;
  const nextTurns = thread.turns.map((turn) => {
    const nextItems = applyQuestionnaireHistoryToItems(turn.items, entriesByTurnId.get(turn.id) ?? [], turn.itemsView);
    if (nextItems === turn.items) {
      return turn;
    }

    didChange = true;
    return {
      ...turn,
      items: nextItems,
    };
  });

  if (!didChange) {
    return thread;
  }

  return {
    ...thread,
    turns: nextTurns,
  };
}
