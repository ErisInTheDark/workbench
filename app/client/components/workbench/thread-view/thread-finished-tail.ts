/*
 * Exports:
 * - default getFinishedThreadTailHiddenItemIds: hide terminal reasoning at the end of a finished thread.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

export default function getFinishedThreadTailHiddenItemIds({
  hideReasoning,
  itemGroups,
}: {
  hideReasoning: boolean;
  itemGroups: readonly (readonly ThreadItem[])[];
}) {
  const hiddenItemIds = new Set<string>();
  if (!hideReasoning) return hiddenItemIds;
  for (let groupIndex = itemGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const items = itemGroups[groupIndex]!;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]!;
      if (item.type !== "reasoning") return hiddenItemIds;
      hiddenItemIds.add(item.id);
    }
  }
  return hiddenItemIds;
}
