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
) {
  const timeline = normalizeTurnTimeline(file);
  if (!classification || timeline.some((entry) => entry.itemId === itemId)) {
    return timeline;
  }

  return [
    ...timeline,
    {
      anchorItemId: classification === "anchor" ? itemId : findLatestAnchorId(timeline),
      itemId,
      sequence: nextTimelineSequence(timeline),
    },
  ];
}

export function orderMergedItemsByTimeline(items: ThreadItem[], timeline: CodexTranscriptTurnTimelineEntry[]) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const emittedIds = new Set<string>();
  const orderedItems: ThreadItem[] = [];
  const sortedTimeline = [...timeline].sort((left, right) => left.sequence - right.sequence);

  const emit = (itemId: string) => {
    const item = itemsById.get(itemId);
    if (!item || emittedIds.has(itemId)) {
      return;
    }
    emittedIds.add(itemId);
    orderedItems.push(item);
  };

  for (const entry of sortedTimeline.filter((candidate) => candidate.anchorItemId === null)) {
    emit(entry.itemId);
  }

  for (const anchorEntry of sortedTimeline.filter((entry) => entry.anchorItemId === entry.itemId)) {
    emit(anchorEntry.itemId);
    for (const childEntry of sortedTimeline) {
      if (childEntry.anchorItemId === anchorEntry.itemId && childEntry.itemId !== anchorEntry.itemId) {
        emit(childEntry.itemId);
      }
    }
  }

  for (const entry of sortedTimeline) {
    emit(entry.itemId);
  }

  for (const item of items) {
    emit(item.id);
  }

  return orderedItems;
}
