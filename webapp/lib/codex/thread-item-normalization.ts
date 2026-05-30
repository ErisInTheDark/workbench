/*
 * Exports:
 * - normalizeThreadItems: dedupe thread items, including cumulative reasoning snapshot segments. Keywords: thread, reasoning, dedupe, transcript.
 */
import type { ThreadItem } from "./generated/app-server/v2/ThreadItem";
import type { UserInput } from "./generated/app-server/v2/UserInput";

interface NormalizeThreadItemsOptions {
  mergeDuplicateItems?: (existingItem: ThreadItem, incomingItem: ThreadItem) => ThreadItem;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function normalizeUserInput(input: UserInput) {
  switch (input.type) {
    case "text":
      return stableStringify({
        text: input.text,
        text_elements: input.text_elements,
        type: input.type,
      });
    case "image":
      return stableStringify({
        type: input.type,
        url: input.url,
      });
    case "localImage":
      return stableStringify({
        path: input.path,
        type: input.type,
      });
    case "skill":
      return stableStringify({
        name: input.name,
        path: input.path,
        type: input.type,
      });
    case "mention":
      return stableStringify({
        name: input.name,
        path: input.path,
        type: input.type,
      });
  }
}

function normalizeUserInputs(inputs: UserInput[]) {
  return `[${inputs.map((input) => normalizeUserInput(input)).join(",")}]`;
}

function normalizeTextSegment(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function getTurnItemDedupeKey(item: ThreadItem) {
  switch (item.type) {
    case "userMessage":
      return `userMessage:${normalizeUserInputs(item.content)}`;
    case "hookPrompt":
      return `hookPrompt:${stableStringify(item.fragments)}`;
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
