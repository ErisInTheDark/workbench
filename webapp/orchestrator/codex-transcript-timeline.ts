/*
 * Exports:
 * - classifyThreadItemAsTimelineAnchor: identify narrative anchor items. Keywords: codex, transcript, timeline.
 * - createDynamicToolCallItem: build compact dynamic-tool items from server requests. Keywords: dynamic tool, callId.
 * - extractTimelineItemKey: extract timeline item keys from app-server messages. Keywords: itemId, callId.
 * - normalizeTurnTimeline/orderMergedItemsByTimeline: normalize and apply compact turn item ordering. Keywords: hydration, ordering.
 */
import type { DynamicToolCallParams } from "../lib/codex/generated/app-server/v2/DynamicToolCallParams";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { CodexTranscriptTurnFile, CodexTranscriptTurnTimelineEntry } from "./codex-transcript-types";

type TimelineClassification = "anchor" | "non-anchor" | null;
export type TimelineItemMetadata = Partial<Pick<
  CodexTranscriptTurnTimelineEntry,
  "aliases" | "completedAt" | "firstSeenAt" | "lastSeenAt" | "startedAt"
>>;

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function classifyThreadItemAsTimelineAnchor(item: Pick<ThreadItem, "type">) {
  return item.type === "userMessage"
    || item.type === "hookPrompt"
    || item.type === "agentMessage"
    || item.type === "reasoning"
    || item.type === "plan";
}

export function classifyTimelineEvent(method: string | null, item: ThreadItem | null): TimelineClassification {
  if (item) {
    return classifyThreadItemAsTimelineAnchor(item) ? "anchor" : "non-anchor";
  }

  switch (method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return "anchor";
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
    case "item/tool/call":
      return "non-anchor";
    default:
      return null;
  }
}

export function extractTimelineItemKey(value: unknown) {
  const record = asRecord(value);
  const params = asRecord(record?.params);
  const item = asRecord(params?.item);
  return asString(item?.id) ?? asString(params?.itemId) ?? asString(params?.callId);
}

export function createDynamicToolCallItem(params: DynamicToolCallParams): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  return {
    arguments: params.arguments,
    contentItems: null,
    durationMs: null,
    id: params.callId,
    namespace: params.namespace ?? null,
    status: "inProgress",
    success: null,
    tool: params.tool,
    type: "dynamicToolCall",
  };
}

function nextTimelineSequence(timeline: CodexTranscriptTurnTimelineEntry[]) {
  return Math.max(0, ...timeline.map((entry) => entry.sequence)) + 1;
}

function mergeNullableTimestamp(left: number | null | undefined, right: number | null | undefined, mode: "earliest" | "latest") {
  if (left === null || left === undefined) {
    return right ?? null;
  }
  if (right === null || right === undefined) {
    return left;
  }
  return mode === "earliest" ? Math.min(left, right) : Math.max(left, right);
}

function mergeTimelineAliases(left: string[] | undefined, right: string[] | undefined) {
  const aliases = Array.from(new Set([...(left ?? []), ...(right ?? [])].filter(Boolean)));
  return aliases.length ? aliases : undefined;
}

function mergeTimelineEntryMetadata(
  entry: CodexTranscriptTurnTimelineEntry,
  metadata: TimelineItemMetadata | null | undefined,
): CodexTranscriptTurnTimelineEntry {
  if (!metadata) {
    return entry;
  }

  return {
    ...entry,
    aliases: mergeTimelineAliases(entry.aliases, metadata.aliases),
    completedAt: mergeNullableTimestamp(entry.completedAt, metadata.completedAt, "latest"),
    firstSeenAt: mergeNullableTimestamp(entry.firstSeenAt, metadata.firstSeenAt, "earliest"),
    lastSeenAt: mergeNullableTimestamp(entry.lastSeenAt, metadata.lastSeenAt, "latest"),
    startedAt: mergeNullableTimestamp(entry.startedAt, metadata.startedAt, "earliest"),
  };
}

function findLatestAnchorId(timeline: CodexTranscriptTurnTimelineEntry[]) {
  return [...timeline]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((entry) => entry.anchorItemId === entry.itemId)
    .at(-1)?.itemId ?? null;
}

export function normalizeTurnTimeline(file: Pick<CodexTranscriptTurnFile, "itemOrder" | "itemTimeline" | "turn">) {
  const timeline = [...(file.itemTimeline ?? [])];
  const timelineIds = new Set(timeline.map((entry) => entry.itemId));
  const itemsById = new Map((file.turn?.items ?? []).map((item) => [item.id, item]));

  for (const itemId of file.itemOrder ?? []) {
    if (timelineIds.has(itemId)) {
      continue;
    }
    const item = itemsById.get(itemId);
    if (!item) {
      continue;
    }
    const isAnchor = classifyThreadItemAsTimelineAnchor(item);
    timeline.push({
      anchorItemId: isAnchor ? itemId : findLatestAnchorId(timeline),
      itemId,
      sequence: nextTimelineSequence(timeline),
    });
    timelineIds.add(itemId);
  }

  return timeline.sort((left, right) => left.sequence - right.sequence);
}

export function rememberTimelineItem(
  file: Pick<CodexTranscriptTurnFile, "itemOrder" | "itemTimeline" | "turn">,
  itemId: string,
  classification: TimelineClassification,
  metadata: TimelineItemMetadata | null = null,
) {
  const timeline = normalizeTurnTimeline(file);
  const existingEntryIndex = timeline.findIndex((entry) => entry.itemId === itemId || entry.aliases?.includes(itemId));
  if (existingEntryIndex >= 0) {
    return timeline.map((entry, index) => (
      index === existingEntryIndex
        ? mergeTimelineEntryMetadata(entry, {
          ...metadata,
          aliases: itemId === entry.itemId ? metadata?.aliases : mergeTimelineAliases(metadata?.aliases, [itemId]),
        })
        : entry
    ));
  }

  if (!classification) {
    return timeline;
  }

  return [
    ...timeline,
    mergeTimelineEntryMetadata({
      anchorItemId: classification === "anchor" ? itemId : findLatestAnchorId(timeline),
      itemId,
      sequence: nextTimelineSequence(timeline),
    }, metadata),
  ];
}

export function orderMergedItemsByTimeline(items: ThreadItem[], timeline: CodexTranscriptTurnTimelineEntry[]) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const emittedIds = new Set<string>();
  const orderedItems: ThreadItem[] = [];
  const sortedTimeline = [...timeline].sort((left, right) => left.sequence - right.sequence);

  const emit = (itemId: string, aliases: string[] = []) => {
    const item = [itemId, ...aliases].map((candidateId) => itemsById.get(candidateId)).find(Boolean);
    if (!item || emittedIds.has(itemId)) {
      return;
    }
    emittedIds.add(itemId);
    for (const alias of aliases) {
      emittedIds.add(alias);
    }
    emittedIds.add(item.id);
    orderedItems.push(item);
  };

  for (const entry of sortedTimeline.filter((candidate) => candidate.anchorItemId === null)) {
    emit(entry.itemId, entry.aliases);
  }

  for (const anchorEntry of sortedTimeline.filter((entry) => entry.anchorItemId === entry.itemId)) {
    emit(anchorEntry.itemId, anchorEntry.aliases);
    for (const childEntry of sortedTimeline) {
      if (childEntry.anchorItemId === anchorEntry.itemId && childEntry.itemId !== anchorEntry.itemId) {
        emit(childEntry.itemId, childEntry.aliases);
      }
    }
  }

  for (const entry of sortedTimeline) {
    emit(entry.itemId, entry.aliases);
  }

  for (const item of items) {
    emit(item.id);
  }

  return orderedItems;
}
