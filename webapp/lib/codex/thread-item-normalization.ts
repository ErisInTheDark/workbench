/*
 * Exports:
 * - normalizeThreadItems: dedupe thread items, including cumulative reasoning snapshot segments. Keywords: thread, reasoning, dedupe, transcript.
 */
import type { ThreadItem } from "./generated/app-server/v2/ThreadItem";

interface NormalizeThreadItemsOptions {
  mergeDuplicateItems?: (existingItem: ThreadItem, incomingItem: ThreadItem) => ThreadItem;
}

function normalizeUserInput(value: unknown) {
  return JSON.stringify(value);
}

function normalizeTextSegment(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function getTurnItemDedupeKey(item: ThreadItem) {
  switch (item.type) {
    case "userMessage":
      return `userMessage:${normalizeUserInput(item.content)}`;
    case "hookPrompt":
      return `hookPrompt:${JSON.stringify(item.fragments)}`;
    case "agentMessage":
      return item.text.trim() ? `agentMessage:${item.text.trim()}` : null;
    case "plan":
      return item.text.trim() ? `plan:${item.text.trim()}` : null;
    default:
      return null;
  }
}

function isGenericSnapshotItemId(itemId: string) {
  return /^item-\d+$/u.test(itemId);
}

function shouldPreferReasoningOwner(
  currentOwner: Extract<ThreadItem, { type: "reasoning" }>,
  candidateOwner: Extract<ThreadItem, { type: "reasoning" }>,
) {
  const currentIsGeneric = isGenericSnapshotItemId(currentOwner.id);
  const candidateIsGeneric = isGenericSnapshotItemId(candidateOwner.id);
  if (currentIsGeneric !== candidateIsGeneric) {
    return currentIsGeneric && !candidateIsGeneric;
  }

  return false;
}

function shouldRemoveReasoningSegmentFromItem(
  item: Extract<ThreadItem, { type: "reasoning" }>,
  segment: string,
  ownersBySegment: Map<string, Extract<ThreadItem, { type: "reasoning" }>>,
) {
  const normalizedSegment = normalizeTextSegment(segment);
  if (!normalizedSegment) {
    return false;
  }

  return isGenericSnapshotItemId(item.id)
    && ownersBySegment.get(normalizedSegment)?.id !== item.id;
}

function removeDuplicateReasoningSegments(
  item: Extract<ThreadItem, { type: "reasoning" }>,
  ownersBySegment: Map<string, Extract<ThreadItem, { type: "reasoning" }>>,
) {
  let changed = false;
  const summary = item.summary.map((segment) => {
    if (!shouldRemoveReasoningSegmentFromItem(item, segment, ownersBySegment)) {
      return segment;
    }

    changed = true;
    return "";
  });
  const content = item.content.map((segment) => {
    if (!shouldRemoveReasoningSegmentFromItem(item, segment, ownersBySegment)) {
      return segment;
    }

    changed = true;
    return "";
  });

  return changed ? { ...item, content, summary } : item;
}

export function normalizeThreadItems(items: ThreadItem[], options: NormalizeThreadItemsOptions = {}): ThreadItem[] {
  const dedupedItems: ThreadItem[] = [];
  const dedupedIndexesByKey = new Map<string, number>();
  const reasoningSegmentOwners = new Map<string, Extract<ThreadItem, { type: "reasoning" }>>();
  let changed = false;

  for (const item of items) {
    if (item.type === "reasoning") {
      dedupedItems.push(item);
      for (const segment of [...item.summary, ...item.content]) {
        const normalizedSegment = normalizeTextSegment(segment);
        if (!normalizedSegment) {
          continue;
        }

        const currentOwner = reasoningSegmentOwners.get(normalizedSegment);
        if (!currentOwner || shouldPreferReasoningOwner(currentOwner, item)) {
          reasoningSegmentOwners.set(normalizedSegment, item);
        }
      }
      continue;
    }

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
    dedupedItems[existingIndex] = options.mergeDuplicateItems
      ? options.mergeDuplicateItems(dedupedItems[existingIndex]!, item)
      : dedupedItems[existingIndex]!;
  }

  const normalizedItems: ThreadItem[] = [];
  for (const item of dedupedItems) {
    if (item.type !== "reasoning") {
      normalizedItems.push(item);
      continue;
    }

    const originalNonEmptySegmentCount = [...item.summary, ...item.content]
      .filter((segment) => normalizeTextSegment(segment))
      .length;
    if (!originalNonEmptySegmentCount) {
      normalizedItems.push(item);
      continue;
    }

    const nextItem = removeDuplicateReasoningSegments(item, reasoningSegmentOwners);
    const summary = nextItem.summary;
    const content = nextItem.content;
    const nextNonEmptySegmentCount = [...summary, ...content]
      .filter((segment) => normalizeTextSegment(segment))
      .length;
    if (!nextNonEmptySegmentCount) {
      changed = true;
      continue;
    }

    if (nextItem !== item) {
      changed = true;
      normalizedItems.push(nextItem);
      continue;
    }

    normalizedItems.push(item);
  }

  return changed ? normalizedItems : items;
}
