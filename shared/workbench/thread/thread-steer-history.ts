/*
 * Exports:
 * - SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX: legacy reference conversion only.
 * - resolveSteerHistoryItemId: reuse admitted identity, with retained-history fallback.
 * - resolveSteerTranscriptSourceId: correlate delivered provider input or retained unsent history.
 * - isSyntheticSteerHistoryItem: detect Workbench-injected steer history user messages.
 * - isWorkbenchSyntheticSteerUserMessage: detect Workbench-only steer user messages that must not become durable anchors.
 * - isWorkbenchPendingSteerUserMessage: detect Workbench-only steer messages still queued for the active turn.
 * - applySteerHistoryToThread: strip prior synthetic steer items and reinsert persisted pending/unsent steer history.
 */

import type { ThreadItem, UserInput } from "./workbench-thread-items.ts";
import { areUserInputsEquivalentForUserMessageDedupe } from "./thread-item-normalization.ts";
import type { ThreadPayloadData, WorkbenchSteerHistoryEntry } from "../../types.ts";
import { projectWorkbenchThreadItemTimelines } from "./thread-item-timeline.ts";
import { getWorkbenchInputState, withWorkbenchInputState } from "./thread-input-item.ts";

export const SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX = "workbench:steer-history:";

type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

export function resolveSteerHistoryItemId(entry: WorkbenchSteerHistoryEntry) {
  return entry.itemId ?? `${SYNTHETIC_STEER_HISTORY_ITEM_ID_PREFIX}${entry.status}:${entry.threadId}:${entry.entryKey}`;
}

export function resolveSteerTranscriptSourceId(entry: WorkbenchSteerHistoryEntry) {
  return entry.status === "sent"
    ? entry.canonicalItemId ?? entry.clientUserMessageId ?? `workbench-steer:${entry.threadId}:${entry.entryKey}`
    : resolveSteerHistoryItemId(entry);
}

export function isSyntheticSteerHistoryItem(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return input?.kind === "steer" && input.status !== "sent";
}

export function isWorkbenchSyntheticSteerUserMessage(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return item.type === "userMessage"
    && (
      (input?.kind === "optimistic" && input.placement === "steer")
      || isSyntheticSteerHistoryItem(item)
    );
}

export function isWorkbenchPendingSteerUserMessage(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return item.type === "userMessage"
    && (
      (input?.kind === "optimistic" && input.placement === "steer" && input.status === "pending")
      || (input?.kind === "steer" && input.status === "pending")
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
  throw new Error("Unsupported steer history input.");
}

function findCanonicalUserMessage(items: ThreadItem[], entry: WorkbenchSteerHistoryEntry) {
  return items.find((item) => {
    if (item.type !== "userMessage" || isSyntheticSteerHistoryItem(item)) {
      return false;
    }

    if (entry.canonicalItemId || entry.clientUserMessageId) {
      return entry.canonicalItemId === item.id
        || entry.clientUserMessageId === item.clientId;
    }
    return areUserInputsEquivalentForUserMessageDedupe(item.content, entry.input);
  });
}

function shouldRenderSteerHistoryEntry(items: ThreadItem[], entry: WorkbenchSteerHistoryEntry) {
  if (entry.status === "sent") {
    return false;
  }

  return !findCanonicalUserMessage(items, entry);
}

function createSyntheticSteerHistoryItem(entry: WorkbenchSteerHistoryEntry): UserMessageItem {
  return withWorkbenchInputState({
    content: entry.input.map(cloneUserInput),
    id: resolveSteerHistoryItemId(entry),
    clientId: entry.clientUserMessageId ?? null,
    type: "userMessage",
  }, { kind: "steer", status: entry.status });
}

function sortSteerHistoryEntries(entries: WorkbenchSteerHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.dispatchSequence !== null && left.dispatchSequence !== undefined
      && right.dispatchSequence !== null && right.dispatchSequence !== undefined
      && left.dispatchSequence !== right.dispatchSequence) {
      return left.dispatchSequence - right.dispatchSequence;
    }

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

export function applySteerHistoryToThread<Payload extends ThreadPayloadData<string> & { isDraft: boolean }>(
  thread: Payload,
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

  const projected = didChange
    ? { ...thread, turns: nextTurns }
    : thread;
  return projectWorkbenchThreadItemTimelines(projected, (turn) => (
    (entriesByTurnId.get(turn.id) ?? []).flatMap((entry) => {
      const item = findCanonicalUserMessage(turn.items, entry)
        ?? turn.items.find((candidate) => candidate.id === resolveSteerHistoryItemId(entry));
      return item ? [{
        completedAt: null,
        firstSeenAt: entry.attemptedAt,
        itemId: item.id,
        lastSeenAt: null,
        startedAt: null,
      }] : [];
    })
  ));
}
