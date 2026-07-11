/*
 * Exports:
 * - SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX: item id prefix reserved for workbench-injected steer history items. Keywords: synthetic, steer, history.
 * - isSyntheticSteerHistoryItem: detect Workbench-injected steer history user messages. Keywords: synthetic, steer, guard.
 * - isWorkbenchSyntheticSteerUserMessage: detect Workbench-only steer user messages that must not become durable anchors. Keywords: optimistic, synthetic, steer, anchor.
 * - isWorkbenchPendingSteerUserMessage: detect Workbench-only steer messages still queued for the active turn. Keywords: optimistic, synthetic, steer, pending.
 * - applySteerHistoryToThread: strip prior synthetic steer items and reinsert persisted pending/unsent steer history. Keywords: steer, thread, overlay, persisted history.
 */

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import { areUserInputsEquivalentForUserMessageDedupe } from "../../codex/thread-item-normalization";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "../../types";

export const SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX = "workbench:steer-history:";

type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

function createSyntheticSteerHistoryItemId(entry: WorkbenchSteerHistoryEntry) {
  return `${SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX}${entry.status}:${entry.threadId}:${entry.entryKey}`;
}

export function isSyntheticSteerHistoryItem(item: ThreadItem) {
  return item.type === "userMessage"
    && item.id.startsWith(SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX);
}

export function isWorkbenchSyntheticSteerUserMessage(item: ThreadItem) {
  return item.type === "userMessage"
    && (
      item.id.startsWith("optimistic-user-message:steer:")
      || item.id.startsWith(SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX)
    );
}

export function isWorkbenchPendingSteerUserMessage(item: ThreadItem) {
  return item.type === "userMessage"
    && (
      item.id.startsWith("optimistic-user-message:steer:pending:")
      || item.id.startsWith(`${SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX}pending:`)
    );
}

function stripSyntheticSteerHistoryItems(items: ThreadItem[]) {
  return items.filter((item) => !isSyntheticSteerHistoryItem(item));
}

function cloneUserInput(input: UserInput): UserInput {
  switch (input.type) {
    case "text":
      return {
        text: input.text,
        text_elements: input.text_elements.map((element) => ({
          byteRange: { ...element.byteRange },
          placeholder: element.placeholder,
        })),
        type: input.type,
      };
    case "image":
      return { type: input.type, url: input.url };
    case "localImage":
      return { path: input.path, type: input.type };
    case "skill":
      return { name: input.name, path: input.path, type: input.type };
    case "mention":
      return { name: input.name, path: input.path, type: input.type };
  }
}

function hasCanonicalUserMessage(items: ThreadItem[], entry: WorkbenchSteerHistoryEntry) {
  return items.some((item) => {
    if (item.type !== "userMessage" || isSyntheticSteerHistoryItem(item)) {
      return false;
    }

    return areUserInputsEquivalentForUserMessageDedupe(item.content, entry.input);
  });
}

function shouldRenderSteerHistoryEntry(items: ThreadItem[], entry: WorkbenchSteerHistoryEntry) {
  if (entry.status === "sent") {
    return false;
  }

  return !hasCanonicalUserMessage(items, entry);
}

function createSyntheticSteerHistoryItem(entry: WorkbenchSteerHistoryEntry): UserMessageItem {
  return {
    content: entry.input.map(cloneUserInput),
    id: createSyntheticSteerHistoryItemId(entry),
    clientId: null,
    type: "userMessage",
  };
}

function sortSteerHistoryEntries(entries: WorkbenchSteerHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.attemptedAt !== right.attemptedAt) {
      return left.attemptedAt - right.attemptedAt;
    }

    return left.entryKey.localeCompare(right.entryKey);
  });
}

function applySteerHistoryToItems(items: ThreadItem[], entries: WorkbenchSteerHistoryEntry[]) {
  const baseItems = stripSyntheticSteerHistoryItems(items);
  const syntheticItems = sortSteerHistoryEntries(entries)
    .filter((entry) => shouldRenderSteerHistoryEntry(baseItems, entry))
    .map(createSyntheticSteerHistoryItem);
  if (!syntheticItems.length) {
    return baseItems.length === items.length ? items : baseItems;
  }

  return [
    ...baseItems,
    ...syntheticItems,
  ];
}

export function applySteerHistoryToThread(
  thread: ThreadPayload,
  entries: WorkbenchSteerHistoryEntry[],
) {
  if (thread.harness !== "codex") {
    return thread;
  }

  const entriesByTurnId = new Map<string, WorkbenchSteerHistoryEntry[]>();
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
    const nextItems = applySteerHistoryToItems(turn.items, entriesByTurnId.get(turn.id) ?? []);
    if (nextItems === turn.items) {
      return turn;
    }

    didChange = true;
    return {
      ...turn,
      items: nextItems,
    };
  });

  return didChange
    ? { ...thread, turns: nextTurns }
    : thread;
}
