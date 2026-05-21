/*
 * Exports:
 * - hydrateThreadWithStoredTurns: merge disk transcript turns into an upstream thread snapshot. Keywords: codex, transcript, hydration, turns.
 * - mergeStoredTurnIntoUpstreamTurn: preserve richer stored turn items while keeping volatile upstream metadata. Keywords: turn merge, itemsView, live metadata.
 */
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { CodexTranscriptTurnTimelineEntry } from "./codex-transcript-types";
import { mergeThreadItem } from "./codex-transcript-item-merge";
import { orderMergedItemsByTimeline } from "./codex-transcript-timeline";

export interface StoredTurnWithTimeline {
  itemTimeline: CodexTranscriptTurnTimelineEntry[];
  turn: Turn;
}

function getItemsViewRank(itemsView: Turn["itemsView"]) {
  switch (itemsView) {
    case "full":
      return 2;
    case "summary":
      return 1;
    case "notLoaded":
      return 0;
  }
}

function countStructuredItems(items: ThreadItem[]) {
  return items.reduce((total, item) => {
    switch (item.type) {
      case "commandExecution":
      case "dynamicToolCall":
      case "mcpToolCall":
      case "fileChange":
      case "collabAgentToolCall":
      case "webSearch":
      case "imageView":
      case "imageGeneration":
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction":
        return total + 1;
      default:
        return total;
    }
  }, 0);
}

function shouldUseStoredItems(upstreamTurn: Turn, storedTurn: Turn) {
  const upstreamRank = getItemsViewRank(upstreamTurn.itemsView);
  const storedRank = getItemsViewRank(storedTurn.itemsView);
  if (storedRank !== upstreamRank) {
    return storedRank > upstreamRank;
  }

  if (storedTurn.items.length !== upstreamTurn.items.length) {
    return storedTurn.items.length > upstreamTurn.items.length;
  }

  return countStructuredItems(storedTurn.items) > countStructuredItems(upstreamTurn.items);
}

function getTurnItemDedupeKey(item: ThreadItem) {
  switch (item.type) {
    case "userMessage":
      return `userMessage:${JSON.stringify(item.content)}`;
    case "hookPrompt":
      return `hookPrompt:${JSON.stringify(item.fragments)}`;
    case "agentMessage":
      return item.text.trim() ? `agentMessage:${item.text.trim()}` : null;
    case "plan":
      return item.text.trim() ? `plan:${item.text.trim()}` : null;
    case "reasoning": {
      const text = [...item.summary, ...item.content].join("\n").trim();
      return text ? `reasoning:${text}` : null;
    }
    default:
      return null;
  }
}

function chooseRicherTurnItem(left: ThreadItem, right: ThreadItem) {
  return mergeThreadItem(left, right);
}

function normalizeMergedTurnItems(items: ThreadItem[]) {
  const dedupedItems: ThreadItem[] = [];
  const dedupedIndexesByKey = new Map<string, number>();
  let changed = false;

  for (const item of items) {
    const dedupeKey = getTurnItemDedupeKey(item);
    if (!dedupeKey) {
      dedupedItems.push(item);
      continue;
    }

    const existingIndex = dedupedIndexesByKey.get(dedupeKey);
    if (existingIndex === undefined) {
      dedupedIndexesByKey.set(dedupeKey, dedupedItems.length);
      dedupedItems.push(item);
      continue;
    }

    changed = true;
    dedupedItems[existingIndex] = chooseRicherTurnItem(dedupedItems[existingIndex]!, item);
  }

  return changed ? dedupedItems : items;
}

function mergeTurnItemLists(primaryItems: ThreadItem[], secondaryItems: ThreadItem[], timeline: CodexTranscriptTurnTimelineEntry[]) {
  const secondaryItemsById = new Map(secondaryItems.map((item) => [item.id, item]));
  const primaryIds = new Set(primaryItems.map((item) => item.id));
  const mergedPrimaryItems = primaryItems.map((item) => {
    const secondaryItem = secondaryItemsById.get(item.id);
    return secondaryItem ? chooseRicherTurnItem(item, secondaryItem) : item;
  });
  const secondaryOnlyItems = secondaryItems.filter((item) => !primaryIds.has(item.id));
  return orderMergedItemsByTimeline(normalizeMergedTurnItems([...mergedPrimaryItems, ...secondaryOnlyItems]), timeline);
}

export function mergeStoredTurnIntoUpstreamTurn(upstreamTurn: Turn, storedTurn: StoredTurnWithTimeline) {
  const storedTurnValue = storedTurn.turn;
  if (!shouldUseStoredItems(upstreamTurn, storedTurnValue)) {
    const items = mergeTurnItemLists(upstreamTurn.items, storedTurnValue.items, storedTurn.itemTimeline);
    return items === upstreamTurn.items ? upstreamTurn : { ...upstreamTurn, items };
  }

  return {
    ...upstreamTurn,
    items: mergeTurnItemLists(storedTurnValue.items, upstreamTurn.items, storedTurn.itemTimeline),
    itemsView: storedTurnValue.itemsView,
  };
}

export function hydrateThreadWithStoredTurns(thread: Thread, storedTurns: StoredTurnWithTimeline[]) {
  if (!storedTurns.length) {
    return thread;
  }

  const storedTurnsById = new Map(storedTurns.map((turn) => [turn.turn.id, turn]));
  const upstreamTurnIds = new Set(thread.turns.map((turn) => turn.id));
  let changed = false;
  const turns = thread.turns.map((turn) => {
    const storedTurn = storedTurnsById.get(turn.id);
    if (!storedTurn) {
      return turn;
    }

    const mergedTurn = mergeStoredTurnIntoUpstreamTurn(turn, storedTurn);
    if (mergedTurn !== turn) {
      changed = true;
    }
    return mergedTurn;
  });

  for (const storedTurn of storedTurns) {
    if (upstreamTurnIds.has(storedTurn.turn.id)) {
      continue;
    }

    turns.push({
      ...storedTurn.turn,
      items: orderMergedItemsByTimeline(storedTurn.turn.items, storedTurn.itemTimeline),
    });
    changed = true;
  }

  return changed ? { ...thread, turns } : thread;
}
