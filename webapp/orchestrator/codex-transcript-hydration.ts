/*
 * Exports:
 * - hydrateThreadWithStoredTurns: merge disk transcript turns into an upstream thread snapshot. Keywords: codex, transcript, hydration, turns.
 * - mergeStoredTurnIntoUpstreamTurn: preserve richer stored items and backfill omitted lifecycle facts without replacing provider truth. Keywords: turn merge, itemsView, lifecycle.
 */
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { normalizeThreadItems } from "workbench-shared/codex/thread-item-normalization";
import type { CodexTranscriptTurnTimelineEntry } from "./codex-transcript-types";
import { mergeThreadItem } from "./codex-transcript-item-merge";
import { orderMergedItemsByTimeline } from "./codex-transcript-timeline";

export interface StoredTurnWithTimeline {
  itemTimeline: CodexTranscriptTurnTimelineEntry[];
  turn: Turn;
}

interface MergeTurnItemListsOptions {
  pruneSecondarySnapshotNarrativeArtifacts?: boolean;
}

function isGenericSnapshotItemId(itemId: string) {
  return /^item-\d+$/u.test(itemId);
}

function hasContextCompactionItem(items: ThreadItem[]) {
  return items.some((item) => item.type === "contextCompaction");
}

function isGenericSnapshotNarrativeArtifact(item: ThreadItem) {
  return isGenericSnapshotItemId(item.id)
    && (item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning");
}

function getNarrativeTextForSnapshotDedupe(item: ThreadItem) {
  switch (item.type) {
    case "agentMessage":
    case "plan":
      return item.text;
    case "reasoning":
      return [...item.summary, ...item.content].join("\n");
    default:
      return null;
  }
}

function normalizeNarrativeTextForSnapshotDedupe(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .replace(/[^\p{L}\p{N}\s#`./:-]+/gu, "")
    .trim()
    .toLowerCase();
}

function getNarrativeSnapshotDedupeKeyFromText(text: string) {
  const normalizedText = normalizeNarrativeTextForSnapshotDedupe(text);
  return normalizedText.length >= 40 ? normalizedText.slice(0, 120) : null;
}

function getNarrativeSnapshotDedupeKey(item: ThreadItem) {
  const text = getNarrativeTextForSnapshotDedupe(item);
  return text ? getNarrativeSnapshotDedupeKeyFromText(text) : null;
}

function createNarrativeSnapshotDedupeKeys(items: ThreadItem[]) {
  return new Set(items
    .map(getNarrativeSnapshotDedupeKey)
    .filter((key): key is string => key !== null));
}

function isDuplicateGenericSnapshotNarrativeArtifact(item: ThreadItem, primaryNarrativeDedupeKeys: ReadonlySet<string>) {
  if (!isGenericSnapshotNarrativeArtifact(item)) {
    return false;
  }

  const dedupeKey = getNarrativeSnapshotDedupeKey(item);
  return !!dedupeKey && primaryNarrativeDedupeKeys.has(dedupeKey);
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

function chooseRicherTurnItem(left: ThreadItem, right: ThreadItem) {
  return mergeThreadItem(left, right);
}

function mergeTurnItemLists(
  primaryItems: ThreadItem[],
  secondaryItems: ThreadItem[],
  timeline: CodexTranscriptTurnTimelineEntry[],
  options: MergeTurnItemListsOptions = {},
) {
  const secondaryItemsById = new Map(secondaryItems.map((item) => [item.id, item]));
  const primaryIds = new Set(primaryItems.map((item) => item.id));
  const mergedPrimaryItems = primaryItems.map((item) => {
    const secondaryItem = secondaryItemsById.get(item.id);
    return secondaryItem ? chooseRicherTurnItem(item, secondaryItem) : item;
  });
  const shouldPruneSecondarySnapshotNarrativeDuplicates = !!options.pruneSecondarySnapshotNarrativeArtifacts
    && hasContextCompactionItem(primaryItems);
  const primaryNarrativeDedupeKeys = shouldPruneSecondarySnapshotNarrativeDuplicates
    ? createNarrativeSnapshotDedupeKeys(primaryItems)
    : null;
  const secondaryOnlyItems = secondaryItems.filter((item) => {
    if (primaryIds.has(item.id)) {
      return false;
    }

    return !(
      primaryNarrativeDedupeKeys
      && isDuplicateGenericSnapshotNarrativeArtifact(item, primaryNarrativeDedupeKeys)
    );
  });
  return orderMergedItemsByTimeline(normalizeThreadItems([...mergedPrimaryItems, ...secondaryOnlyItems], { mergeDuplicateItems: mergeThreadItem }), timeline);
}

export function mergeStoredTurnIntoUpstreamTurn(upstreamTurn: Turn, storedTurn: StoredTurnWithTimeline) {
  const storedTurnValue = storedTurn.turn;
  const isTerminal = upstreamTurn.status !== "inProgress";
  const startedAt = upstreamTurn.startedAt ?? storedTurnValue.startedAt;
  const completedAt = isTerminal
    ? upstreamTurn.completedAt ?? storedTurnValue.completedAt
    : upstreamTurn.completedAt;
  const durationMs = isTerminal
    ? upstreamTurn.durationMs ?? storedTurnValue.durationMs
    : upstreamTurn.durationMs;
  const mergedLifecycleTurn = startedAt === upstreamTurn.startedAt
      && completedAt === upstreamTurn.completedAt
      && durationMs === upstreamTurn.durationMs
    ? upstreamTurn
    : { ...upstreamTurn, completedAt, durationMs, startedAt };
  if (!shouldUseStoredItems(mergedLifecycleTurn, storedTurnValue)) {
    const items = mergeTurnItemLists(mergedLifecycleTurn.items, storedTurnValue.items, storedTurn.itemTimeline);
    return items === mergedLifecycleTurn.items ? mergedLifecycleTurn : { ...mergedLifecycleTurn, items };
  }

  return {
    ...mergedLifecycleTurn,
    items: mergeTurnItemLists(storedTurnValue.items, mergedLifecycleTurn.items, storedTurn.itemTimeline, {
      pruneSecondarySnapshotNarrativeArtifacts: true,
    }),
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
      items: orderMergedItemsByTimeline(normalizeThreadItems(storedTurn.turn.items, { mergeDuplicateItems: mergeThreadItem }), storedTurn.itemTimeline),
    });
    changed = true;
  }

  return changed ? { ...thread, turns } : thread;
}
