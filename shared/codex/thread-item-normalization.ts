/*
 * Exports:
 * - normalizeThreadItems: dedupe thread items, including cumulative reasoning snapshot segments and context-compaction lifecycle aliases. Keywords: thread, reasoning, compaction, dedupe, transcript.
 * - mergeThreadItem: merge same-id thread items without losing richer stored history. Keywords: thread, item, merge, history.
 * - reconcileCompleteThreadItems: reconcile one complete provider snapshot with directly recorded canonical items. Keywords: thread, provider, snapshot, identity, replacement.
 * - ReconciledCompleteThreadItem: one complete-scope result and its incoming identity evidence. Keywords: thread, provider, alias, identity.
 * - areUserInputsEquivalentForUserMessageDedupe: compare user inputs for duplicate user-message pruning. Keywords: thread, user message, image, equality.
 */
import type { ThreadItem } from "./generated/app-server/v2/ThreadItem.ts";
import type { UserInput } from "./generated/app-server/v2/UserInput.ts";
import { compactCommandOutput } from "./thread-command-output.ts";
import { mergeWorkbenchToolOutput } from "../workbench/thread/thread-tool-output.ts";
import { mergeWorkbenchFileChange } from "../workbench/thread/workbench-file-change.ts";

interface NormalizeThreadItemsOptions {
  mergeDuplicateItems?: (existingItem: ThreadItem, incomingItem: ThreadItem) => ThreadItem;
}

export interface ReconciledCompleteThreadItem {
  aliases: string[];
  incomingItemId: string;
  item: ThreadItem;
}

function isNonEmptyArray<TValue>(value: TValue[] | null | undefined): value is TValue[] {
  return Array.isArray(value) && value.length > 0;
}

function preferValue<TValue>(incoming: TValue, stored: TValue, isRicher: (value: TValue) => boolean) {
  return isRicher(incoming) ? incoming : stored;
}

function mergeStatus(incoming: string, stored: string) {
  const rank = (status: string) => {
    switch (status) {
      case "failed":
        return 4;
      case "declined":
        return 3;
      case "completed":
        return 2;
      case "inProgress":
        return 1;
      default:
        return 0;
    }
  };
  return rank(stored) > rank(incoming) ? stored : incoming;
}

function mergeText(incoming: string, stored: string) {
  return stored.length > incoming.length ? stored : incoming;
}

function mergeTextArray(incoming: string[], stored: string[]) {
  const length = Math.max(incoming.length, stored.length);
  return Array.from({ length }, (_, index) => mergeText(incoming[index] ?? "", stored[index] ?? ""));
}

export function mergeThreadItem(incoming: ThreadItem, stored: ThreadItem): ThreadItem {
  if (incoming.id !== stored.id || incoming.type !== stored.type) {
    return incoming;
  }

  switch (incoming.type) {
    case "functionCallOutput":
      return mergeWorkbenchToolOutput(incoming, stored as Extract<ThreadItem, { type: "functionCallOutput" }>);
    case "agentMessage": {
      const storedItem = stored as Extract<ThreadItem, { type: "agentMessage" }>;
      return {
        ...incoming,
        memoryCitation: incoming.memoryCitation ?? storedItem.memoryCitation,
        text: mergeText(incoming.text, storedItem.text),
      };
    }
    case "reasoning": {
      const storedItem = stored as Extract<ThreadItem, { type: "reasoning" }>;
      return {
        ...incoming,
        content: mergeTextArray(incoming.content, storedItem.content),
        summary: mergeTextArray(incoming.summary, storedItem.summary),
      };
    }
    case "plan": {
      const storedItem = stored as Extract<ThreadItem, { type: "plan" }>;
      return {
        ...incoming,
        text: mergeText(incoming.text, storedItem.text),
      };
    }
    case "commandExecution": {
      const storedItem = stored as Extract<ThreadItem, { type: "commandExecution" }>;
      const aggregatedOutput = compactCommandOutput(preferValue(incoming.aggregatedOutput, storedItem.aggregatedOutput, (value) => Boolean(value?.length)));
      return {
        ...incoming,
        aggregatedOutput,
        commandActions: preferValue(incoming.commandActions, storedItem.commandActions, isNonEmptyArray),
        durationMs: incoming.durationMs ?? storedItem.durationMs,
        exitCode: incoming.exitCode ?? storedItem.exitCode,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    case "fileChange": {
      const storedItem = stored as Extract<ThreadItem, { type: "fileChange" }>;
      return mergeWorkbenchFileChange({
        ...incoming,
        changes: preferValue(incoming.changes, storedItem.changes, isNonEmptyArray),
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      }, storedItem);
    }
    case "mcpToolCall": {
      const storedItem = stored as Extract<ThreadItem, { type: "mcpToolCall" }>;
      return {
        ...incoming,
        durationMs: incoming.durationMs ?? storedItem.durationMs,
        error: incoming.error ?? storedItem.error,
        result: incoming.result ?? storedItem.result,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    case "dynamicToolCall": {
      const storedItem = stored as Extract<ThreadItem, { type: "dynamicToolCall" }>;
      return {
        ...incoming,
        contentItems: incoming.contentItems ?? storedItem.contentItems,
        durationMs: incoming.durationMs ?? storedItem.durationMs,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
        success: incoming.success ?? storedItem.success,
      };
    }
    case "collabAgentToolCall": {
      const storedItem = stored as Extract<ThreadItem, { type: "collabAgentToolCall" }>;
      return {
        ...incoming,
        agentsStates: Object.keys(incoming.agentsStates).length ? incoming.agentsStates : storedItem.agentsStates,
        model: incoming.model ?? storedItem.model,
        prompt: incoming.prompt ?? storedItem.prompt,
        reasoningEffort: incoming.reasoningEffort ?? storedItem.reasoningEffort,
        receiverThreadIds: incoming.receiverThreadIds.length ? incoming.receiverThreadIds : storedItem.receiverThreadIds,
        senderThreadId: incoming.senderThreadId || storedItem.senderThreadId,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    default:
      return incoming;
  }
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

function isInlineDataImageUrl(value: string) {
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/iu.test(value.trim());
}

function isWorkbenchTranscriptAssetUrl(value: string) {
  return /^\/api\/transcript-assets\//u.test(value.trim());
}

function areUserImageUrlsEquivalentForDedupe(left: string, right: string) {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  return normalizedLeft === normalizedRight
    || (isInlineDataImageUrl(normalizedLeft) && isWorkbenchTranscriptAssetUrl(normalizedRight))
    || (isWorkbenchTranscriptAssetUrl(normalizedLeft) && isInlineDataImageUrl(normalizedRight));
}

function areTextElementsEquivalent(left: Extract<UserInput, { type: "text" }>["text_elements"], right: Extract<UserInput, { type: "text" }>["text_elements"]) {
  return left.length === right.length
    && left.every((element, index) => {
      const rightElement = right[index];
      return !!rightElement
        && element.placeholder === rightElement.placeholder
        && element.byteRange.start === rightElement.byteRange.start
        && element.byteRange.end === rightElement.byteRange.end;
    });
}

function areUserInputsEquivalentForDedupe(left: UserInput, right: UserInput) {
  if (left.type !== right.type) {
    return false;
  }

  switch (left.type) {
    case "text":
      return right.type === "text"
        && left.text.trim() === right.text.trim()
        && areTextElementsEquivalent(left.text_elements, right.text_elements);
    case "image":
      return right.type === "image"
        && areUserImageUrlsEquivalentForDedupe(left.url, right.url);
    case "localImage":
      return right.type === "localImage"
        && left.path === right.path;
    case "skill":
      return right.type === "skill"
        && left.name === right.name
        && left.path === right.path;
    case "mention":
      return right.type === "mention"
        && left.name === right.name
        && left.path === right.path;
  }
}

export function areUserInputsEquivalentForUserMessageDedupe(left: UserInput[], right: UserInput[]) {
  return left.length === right.length
    && left.every((input, index) => {
      const rightInput = right[index];
      return !!rightInput && areUserInputsEquivalentForDedupe(input, rightInput);
    });
}

function areUserMessagesEquivalentForDedupe(
  left: Extract<ThreadItem, { type: "userMessage" }>,
  right: Extract<ThreadItem, { type: "userMessage" }>,
) {
  if (left.id === right.id) {
    return true;
  }

  if (left.clientId && right.clientId) {
    return left.clientId === right.clientId;
  }

  if (!areUserInputsEquivalentForUserMessageDedupe(left.content, right.content)) {
    return false;
  }

  const hasConflictingClientIds = Boolean(left.clientId && right.clientId && left.clientId !== right.clientId);
  if (hasConflictingClientIds) {
    return false;
  }

  const leftIsGeneric = isGenericSnapshotItemId(left.id);
  const rightIsGeneric = isGenericSnapshotItemId(right.id);
  if (leftIsGeneric !== rightIsGeneric) {
    return true;
  }

  const leftIsOptimistic = left.id.startsWith("optimistic-user-message:");
  const rightIsOptimistic = right.id.startsWith("optimistic-user-message:");
  return leftIsOptimistic !== rightIsOptimistic;
}

function normalizeTextSegment(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function getTurnItemDedupeKey(item: ThreadItem) {
  switch (item.type) {
    case "functionCallOutput":
      return `functionCallOutput:${item.id}`;
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

function nonEmptyReasoningSegments(item: Extract<ThreadItem, { type: "reasoning" }>) {
  return [...item.summary, ...item.content]
    .map(normalizeTextSegment)
    .filter(Boolean);
}

function reasoningItemsOverlap(
  left: Extract<ThreadItem, { type: "reasoning" }>,
  right: Extract<ThreadItem, { type: "reasoning" }>,
) {
  const rightSegments = new Set(nonEmptyReasoningSegments(right));
  return nonEmptyReasoningSegments(left).some((segment) => rightSegments.has(segment));
}

function hasReasoningContent(item: Extract<ThreadItem, { type: "reasoning" }>) {
  return nonEmptyReasoningSegments(item).length > 0;
}

function preferCanonicalEquivalentItem(currentItem: ThreadItem, incomingItem: ThreadItem) {
  if (isGenericSnapshotItemId(currentItem.id) && !isGenericSnapshotItemId(incomingItem.id)) {
    return incomingItem;
  }
  return currentItem;
}

function mergeSameIdItem(
  currentItem: ThreadItem,
  incomingItem: ThreadItem,
  options: NormalizeThreadItemsOptions,
) {
  return options.mergeDuplicateItems?.(incomingItem, currentItem) ?? incomingItem;
}

function findEquivalentCurrentItem(
  currentItems: readonly ThreadItem[],
  incomingItem: ThreadItem,
  usedCurrentItemIds: ReadonlySet<string>,
) {
  return currentItems.find((currentItem) => {
    if (usedCurrentItemIds.has(currentItem.id) || currentItem.type !== incomingItem.type) {
      return false;
    }
    if (currentItem.id === incomingItem.id) {
      return true;
    }
    if (currentItem.type === "userMessage" && incomingItem.type === "userMessage") {
      return areUserMessagesEquivalentForDedupe(currentItem, incomingItem);
    }
    if (
      (currentItem.type === "agentMessage" || currentItem.type === "plan")
      && (incomingItem.type === "agentMessage" || incomingItem.type === "plan")
    ) {
      const currentKey = getTurnItemDedupeKey(currentItem);
      return currentKey !== null && currentKey === getTurnItemDedupeKey(incomingItem);
    }
    return false;
  });
}

export function reconcileCompleteThreadItems(
  currentItems: readonly ThreadItem[],
  incomingItems: readonly ThreadItem[],
  options: NormalizeThreadItemsOptions = {},
): ReconciledCompleteThreadItem[] {
  const current = normalizeThreadItems([...currentItems], options);
  const incoming = normalizeThreadItems([...incomingItems], options);
  const currentById = new Map(current.map((item) => [item.id, item]));
  const usedCurrentItemIds = new Set<string>();
  const results: ReconciledCompleteThreadItem[] = [];
  const currentCompactions = current.filter((
    item,
  ): item is Extract<ThreadItem, { type: "contextCompaction" }> => item.type === "contextCompaction");
  let incomingCompactionIndex = 0;

  const emit = (item: ThreadItem, incomingItemId: string, aliases: string[] = []) => {
    results.push({
      aliases: aliases.filter((alias) => alias !== item.id),
      incomingItemId,
      item,
    });
  };

  for (const incomingItem of incoming) {
    const exactCurrentItem = currentById.get(incomingItem.id);
    if (exactCurrentItem && !usedCurrentItemIds.has(exactCurrentItem.id)) {
      usedCurrentItemIds.add(exactCurrentItem.id);
      emit(mergeSameIdItem(exactCurrentItem, incomingItem, options), incomingItem.id);
      if (incomingItem.type === "contextCompaction") incomingCompactionIndex += 1;
      continue;
    }

    if (incomingItem.type === "reasoning" && isGenericSnapshotItemId(incomingItem.id)) {
      const representedCurrentItems = current.filter((
        currentItem,
      ): currentItem is Extract<ThreadItem, { type: "reasoning" }> => (
        currentItem.type === "reasoning"
        && !isGenericSnapshotItemId(currentItem.id)
        && reasoningItemsOverlap(currentItem, incomingItem)
      ));
      for (const currentItem of representedCurrentItems) {
        if (usedCurrentItemIds.has(currentItem.id)) continue;
        usedCurrentItemIds.add(currentItem.id);
        emit(
          currentItem,
          incomingItem.id,
          representedCurrentItems.length === 1 ? [incomingItem.id] : [],
        );
      }
      const reasoningOwners = new Map<string, Extract<ThreadItem, { type: "reasoning" }>>();
      for (const segment of nonEmptyReasoningSegments(incomingItem)) {
        reasoningOwners.set(segment, incomingItem);
      }
      for (const currentItem of representedCurrentItems) {
        for (const segment of nonEmptyReasoningSegments(currentItem)) {
          reasoningOwners.set(segment, currentItem);
        }
      }
      const residualItem = removeDuplicateReasoningSegments(incomingItem, reasoningOwners);
      if (hasReasoningContent(residualItem)) {
        emit(residualItem, incomingItem.id);
      }
      continue;
    }

    if (incomingItem.type === "contextCompaction") {
      const currentItem = currentCompactions[incomingCompactionIndex];
      incomingCompactionIndex += 1;
      if (currentItem && !usedCurrentItemIds.has(currentItem.id)) {
        usedCurrentItemIds.add(currentItem.id);
        const item = preferCanonicalEquivalentItem(currentItem, incomingItem);
        emit(item, incomingItem.id, [item.id === currentItem.id ? incomingItem.id : currentItem.id]);
        continue;
      }
    }

    const equivalentCurrentItem = findEquivalentCurrentItem(current, incomingItem, usedCurrentItemIds);
    if (equivalentCurrentItem) {
      usedCurrentItemIds.add(equivalentCurrentItem.id);
      const item = preferCanonicalEquivalentItem(equivalentCurrentItem, incomingItem);
      emit(item, incomingItem.id, [
        item.id === equivalentCurrentItem.id ? incomingItem.id : equivalentCurrentItem.id,
      ]);
      continue;
    }

    emit(incomingItem, incomingItem.id);
  }

  return results;
}

function mergeContextCompactionDedupeItem(
  existingItem: Extract<ThreadItem, { type: "contextCompaction" }>,
  incomingItem: Extract<ThreadItem, { type: "contextCompaction" }>,
) {
  return !isGenericSnapshotItemId(incomingItem.id) || isGenericSnapshotItemId(existingItem.id)
    ? incomingItem
    : existingItem;
}

function findContextCompactionDedupeIndex(items: ThreadItem[], incomingItem: Extract<ThreadItem, { type: "contextCompaction" }>) {
  const previousItem = items.at(-1);
  if (previousItem?.type === "contextCompaction") {
    return items.length - 1;
  }

  const incomingIdIsGeneric = isGenericSnapshotItemId(incomingItem.id);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "contextCompaction") {
      continue;
    }

    if (isGenericSnapshotItemId(item.id) !== incomingIdIsGeneric) {
      return index;
    }
  }

  return -1;
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

    if (item.type === "contextCompaction") {
      const existingIndex = findContextCompactionDedupeIndex(dedupedItems, item);
      if (existingIndex === -1) {
        dedupedItems.push(item);
        continue;
      }

      const existingItem = dedupedItems[existingIndex];
      if (existingItem?.type !== "contextCompaction") {
        dedupedItems.push(item);
        continue;
      }

      changed = true;
      dedupedItems[existingIndex] = mergeContextCompactionDedupeItem(existingItem, item);
      continue;
    }

    if (item.type === "userMessage") {
      const existingIndex = dedupedItems.findIndex((candidate) => (
        candidate.type === "userMessage"
        && areUserMessagesEquivalentForDedupe(candidate, item)
      ));
      if (existingIndex === -1) {
        dedupedItems.push(item);
        continue;
      }

      changed = true;
      const mergedItem = options.mergeDuplicateItems
        ? options.mergeDuplicateItems(dedupedItems[existingIndex]!, item)
        : item;
      if (dedupedItems[existingIndex]?.id === item.id) {
        dedupedItems[existingIndex] = mergedItem;
        continue;
      }
      dedupedItems.splice(existingIndex, 1);
      dedupedItems.push(mergedItem);
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
