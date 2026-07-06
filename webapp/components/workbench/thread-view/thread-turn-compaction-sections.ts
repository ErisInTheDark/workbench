/*
 * Exports:
 * - ThreadTurnCompactionCollapsedSection/ThreadTurnCompactionRenderPlan: render plan for context-compaction-windowed turns. Keywords: thread, compaction, collapse.
 * - createThreadTurnCompactionRenderPlan: split raw turn items into lazy older context and visible current context sections. Keywords: thread, context compaction, performance.
 */

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import {
  getThreadItemTimelineDurationMs,
  type WorkbenchThreadItemTimelineEntry,
} from "../../../lib/workbench/thread/thread-item-timeline";

export interface ThreadTurnCompactionCollapsedSection {
  durationMs: number | null;
  id: string;
  items: ThreadItem[];
}

export interface ThreadTurnCompactionRenderPlan {
  collapsedEarlierSection: ThreadTurnCompactionCollapsedSection | null;
  visibleItems: ThreadItem[];
}

function getContextCompactionIndexes(items: readonly ThreadItem[]) {
  const indexes: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "contextCompaction") {
      indexes.push(index);
    }
  }

  return indexes;
}

function filterPinnedItems(items: readonly ThreadItem[], pinnedItemIds: ReadonlySet<string>) {
  if (!pinnedItemIds.size) {
    return [...items];
  }

  return items.filter((item) => !pinnedItemIds.has(item.id));
}

function createCollapsedSectionId(items: readonly ThreadItem[]) {
  const firstItemId = items[0]?.id ?? "start";
  const lastItemId = items.at(-1)?.id ?? "end";
  return `collapsed-context:${firstItemId}:${lastItemId}`;
}

export function createThreadTurnCompactionRenderPlan({
  itemTimeline,
  items,
  pinnedItemIds,
}: {
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  items: readonly ThreadItem[];
  pinnedItemIds?: ReadonlySet<string>;
}): ThreadTurnCompactionRenderPlan | null {
  const contextCompactionIndexes = getContextCompactionIndexes(items);
  if (contextCompactionIndexes.length <= 1) {
    return null;
  }

  const effectivePinnedItemIds = pinnedItemIds ?? new Set<string>();
  const previousContextStartIndex = contextCompactionIndexes.at(-2) ?? 0;
  const collapsedItems = filterPinnedItems(items.slice(0, previousContextStartIndex), effectivePinnedItemIds);
  const visibleItems = filterPinnedItems(items.slice(previousContextStartIndex), effectivePinnedItemIds);
  const collapsedEarlierSection = collapsedItems.length
    ? {
      durationMs: getThreadItemTimelineDurationMs(collapsedItems.map((item) => item.id), itemTimeline),
      id: createCollapsedSectionId(collapsedItems),
      items: collapsedItems,
    }
    : null;

  return {
    collapsedEarlierSection,
    visibleItems,
  };
}
