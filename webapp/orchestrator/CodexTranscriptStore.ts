/*
 * Exports:
 * - CodexTranscriptStore: persist, de-bloat, and hydrate Codex extended transcript data under .workbench/transcripts. Keywords: codex, transcript, questionnaire, pruning, image assets.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type { JsonValue } from "../lib/codex/generated/app-server/serde_json/JsonValue";
import { appendCommandOutputDelta, compactCommandOutputPayload } from "../lib/codex/thread-command-output";
import { areUserInputsEquivalentForUserMessageDedupe, normalizeThreadItems } from "../lib/codex/thread-item-normalization";
import type { WorkbenchBrowseScreenshotEntry, WorkbenchQuestionnaireHistoryEntry, WorkbenchSteerHistoryEntry, WorkbenchThreadHydrationRequest, WorkbenchThreadTurnHistoryEntry } from "../lib/types";
import AtomicJsonStore from "./AtomicJsonStore";
import { hydrateThreadWithStoredTurns } from "./codex-transcript-hydration";
import { shouldPersistRawNotificationToJournal } from "./codex-transcript-event-routing";
import { mergeThreadItem } from "./codex-transcript-item-merge";
import {
  asNumber,
  asRecord,
  asString,
  encodeTranscriptPathSegment,
  extractItem,
  extractThread,
  extractThreadId,
  extractTurn,
  extractTurnId,
  toSerializableJson,
} from "./codex-transcript-normalizers";
import {
  classifyThreadItemAsTimelineAnchor,
  classifyTimelineEvent,
  createDynamicToolCallItem,
  extractTimelineItemKey,
  normalizeTurnTimeline,
  orderMergedItemsByTimeline,
  rememberTimelineItem,
  type TimelineItemMetadata,
} from "./codex-transcript-timeline";
import type {
  CodexTranscriptOrphanEventsFile,
  CodexTranscriptRawEvent,
  CodexTranscriptThreadFile,
  CodexTranscriptTurnFile,
} from "./codex-transcript-types";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import externalizeCodexTranscriptInlineImages from "./codex-transcript-image-assets";
import { runCodexTranscriptMigrations } from "./codex-transcript-migrations";
import { queueCodexTranscriptRequestSidecarCleanup } from "./codex-transcript-migrations/v3";
import { queueCodexTranscriptImageAssetMigration } from "./codex-transcript-migrations/v4";
import { queueCodexTranscriptCommandOutputCompactionMigration } from "./codex-transcript-migrations/v5";
import { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "./codex-transcript-version";

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const THREAD_TOUCH_THROTTLE_MS = 30_000;
const SUPPORTED_CODEX_TRANSCRIPT_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, 5, CODEX_TRANSCRIPT_SCHEMA_VERSION]);

interface HydrateThreadResponseOptions {
  hydration?: WorkbenchThreadHydrationRequest | null;
  touchThread?: boolean;
}

function now() {
  return Date.now();
}

function createRawEvent(
  source: CodexTranscriptRawEvent["source"],
  payload: unknown,
  method: string | null,
  requestId: number | string | null,
) {
  const receivedAt = now();
  return {
    id: `${receivedAt}:${Math.random().toString(36).slice(2)}`,
    method,
    payload: toSerializableJson(payload),
    receivedAt,
    requestId,
    source,
  } satisfies CodexTranscriptRawEvent;
}

function sortQuestionnaireEntries(entries: WorkbenchQuestionnaireHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.resolvedAt !== right.resolvedAt) {
      return left.resolvedAt - right.resolvedAt;
    }

    return left.requestKey.localeCompare(right.requestKey);
  });
}

function sortSteerEntries(entries: WorkbenchSteerHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.attemptedAt !== right.attemptedAt) {
      return left.attemptedAt - right.attemptedAt;
    }

    return left.entryKey.localeCompare(right.entryKey);
  });
}

function sortBrowseScreenshotEntries(entries: WorkbenchBrowseScreenshotEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.recordedAt !== right.recordedAt) {
      return left.recordedAt - right.recordedAt;
    }

    if (left.actionIndex !== right.actionIndex) {
      return left.actionIndex - right.actionIndex;
    }

    return left.entryKey.localeCompare(right.entryKey);
  });
}

function readTextElements(value: unknown): Extract<UserInput, { type: "text" }>["text_elements"] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const elements: Extract<UserInput, { type: "text" }>["text_elements"] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const byteRange = asRecord(record?.byteRange);
    const start = asNumber(byteRange?.start);
    const end = asNumber(byteRange?.end);
    if (!record || start === null || end === null) {
      return null;
    }

    elements.push({
      byteRange: { end, start },
      placeholder: asString(record.placeholder) ?? "",
    });
  }

  return elements;
}

function readUserInput(value: unknown): UserInput | null {
  const record = asRecord(value);
  const type = asString(record?.type);
  if (!record || !type) {
    return null;
  }

  switch (type) {
    case "text": {
      const text = asString(record.text);
      const textElements = readTextElements(record.text_elements);
      return text !== null && textElements
        ? { text, text_elements: textElements, type }
        : null;
    }
    case "image": {
      const url = asString(record.url);
      return url !== null ? { type, url } : null;
    }
    case "localImage": {
      const path = asString(record.path);
      return path !== null ? { path, type } : null;
    }
    case "skill": {
      const name = asString(record.name);
      const path = asString(record.path);
      return name !== null && path !== null ? { name, path, type } : null;
    }
    case "mention": {
      const name = asString(record.name);
      const path = asString(record.path);
      return name !== null && path !== null ? { name, path, type } : null;
    }
    default:
      return null;
  }
}

function readUserInputArray(value: unknown): UserInput[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const inputs: UserInput[] = [];
  for (const entry of value) {
    const input = readUserInput(entry);
    if (!input) {
      return null;
    }

    inputs.push(input);
  }

  return inputs;
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
}

function createSteerHistoryEntryFromRequest(request: JsonRpcRequest): WorkbenchSteerHistoryEntry | null {
  if (request.method !== "turn/steer") {
    return null;
  }

  const params = asRecord(request.params);
  const threadId = asString(params?.threadId)?.trim() ?? "";
  const turnId = asString(params?.expectedTurnId)?.trim() || asString(params?.turnId)?.trim() || "";
  const input = readUserInputArray(params?.input);
  if (!threadId || !turnId || !input?.length) {
    return null;
  }

  const requestId = typeof request.id === "number" || typeof request.id === "string"
    ? String(request.id)
    : null;
  const attemptedAt = now();
  return {
    attemptedAt,
    canonicalItemId: null,
    entryKey: requestId ? `turn-steer:${requestId}` : `turn-steer:${attemptedAt}:${Math.random().toString(36).slice(2)}`,
    error: null,
    input: input.map(cloneUserInput),
    requestId,
    resolvedAt: null,
    status: "pending",
    threadId,
    turnId,
  };
}

function getJsonRpcErrorMessage(response: JsonRpcResponse) {
  const error = asRecord(response.error);
  return asString(error?.message) ?? (error ? "turn/steer failed." : null);
}

function updateSteerEntryStatus(
  entry: WorkbenchSteerHistoryEntry,
  status: WorkbenchSteerHistoryEntry["status"],
  resolvedAt: number,
  options: { canonicalItemId?: string | null; error?: string | null } = {},
): WorkbenchSteerHistoryEntry {
  return {
    ...entry,
    canonicalItemId: options.canonicalItemId ?? entry.canonicalItemId,
    error: options.error ?? entry.error,
    resolvedAt,
    status,
  };
}

function updateMatchingPendingSteerEntriesForUserMessage(
  entries: WorkbenchSteerHistoryEntry[],
  item: ThreadItem,
  resolvedAt: number,
) {
  if (item.type !== "userMessage") {
    return entries;
  }

  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (
      entry.status !== "pending"
      || !areUserInputsEquivalentForUserMessageDedupe(entry.input, item.content)
    ) {
      return entry;
    }

    changed = true;
    return updateSteerEntryStatus(entry, "sent", resolvedAt, { canonicalItemId: item.id, error: null });
  });

  return changed ? sortSteerEntries(nextEntries) : entries;
}

function updatePendingSteerEntriesForInterruptedTurn(
  entries: WorkbenchSteerHistoryEntry[],
  turn: Turn,
  resolvedAt: number,
) {
  if (turn.status !== "interrupted") {
    return entries;
  }

  const canonicalUserMessages = turn.items.filter((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (entry.status !== "pending") {
      return entry;
    }

    const canonicalMatch = canonicalUserMessages.find((item) => areUserInputsEquivalentForUserMessageDedupe(entry.input, item.content));
    if (canonicalMatch) {
      changed = true;
      return updateSteerEntryStatus(entry, "sent", resolvedAt, { canonicalItemId: canonicalMatch.id, error: null });
    }

    changed = true;
    return updateSteerEntryStatus(entry, "interrupted", resolvedAt, { error: "The turn stopped before this steer was delivered." });
  });

  return changed ? sortSteerEntries(nextEntries) : entries;
}

function getThreadTimestamp(thread: Thread | null) {
  return thread?.updatedAt ? thread.updatedAt * 1000 : now();
}

function createThreadFile(threadId: string): CodexTranscriptThreadFile {
  return {
    cliVersion: null,
    createdAt: now(),
    encodedThreadId: encodeTranscriptPathSegment(threadId),
    lastTouchedAt: now(),
    schemaVersion: CODEX_TRANSCRIPT_SCHEMA_VERSION,
    sourceThreadIds: [threadId],
    thread: null,
    threadId,
    turnIndex: [],
  };
}

function createCompactThreadSnapshot(thread: Thread): Thread {
  return {
    ...thread,
    turns: [],
  };
}

function createTurnIndexEntry(thread: Thread, turn: Turn): CodexTranscriptThreadFile["turnIndex"][number] {
  return {
    completedAt: turn.completedAt,
    itemCount: turn.items.length,
    itemIds: turn.items.map((item) => item.id),
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
    updatedAt: getThreadTimestamp(thread),
  };
}

function createTurnHistoryEntry(
  entry: CodexTranscriptThreadFile["turnIndex"][number],
  loadedTurnIds: Set<string>,
  missingTurnIds: Set<string>,
): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: entry.completedAt,
    durationMs: null,
    itemCount: entry.itemCount,
    ...(entry.itemIds ? { itemIds: entry.itemIds } : {}),
    loadState: missingTurnIds.has(entry.turnId)
      ? "missing"
      : loadedTurnIds.has(entry.turnId)
        ? "loaded"
        : "unloaded",
    startedAt: entry.startedAt,
    status: entry.status,
    turnId: entry.turnId,
  };
}

function mergeTurnIndexes(
  storedEntries: CodexTranscriptThreadFile["turnIndex"],
  upstreamTurns: Turn[],
  thread: Thread,
) {
  const upstreamEntriesById = new Map(upstreamTurns.map((turn) => [turn.id, createTurnIndexEntry(thread, turn)]));
  const seenTurnIds = new Set<string>();
  const entries = storedEntries.map((entry) => {
    seenTurnIds.add(entry.turnId);
    return upstreamEntriesById.get(entry.turnId) ?? entry;
  });

  for (const turn of upstreamTurns) {
    if (seenTurnIds.has(turn.id)) {
      continue;
    }

    entries.push(createTurnIndexEntry(thread, turn));
  }

  return entries;
}

function getLatestTurnId(entries: CodexTranscriptThreadFile["turnIndex"], upstreamTurns: Turn[]) {
  return upstreamTurns.at(-1)?.id ?? entries.at(-1)?.turnId ?? null;
}

function getPreviousTurnId(entries: CodexTranscriptThreadFile["turnIndex"], beforeTurnId: string) {
  const index = entries.findIndex((entry) => entry.turnId === beforeTurnId);
  if (index <= 0) {
    return null;
  }

  return entries[index - 1]?.turnId ?? null;
}

function createTurnFile(threadId: string, turnId: string): CodexTranscriptTurnFile {
  return {
    browseScreenshotEntries: [],
    itemOrder: [],
    itemTimeline: [],
    lastTouchedAt: now(),
    questionnaireEntries: [],
    schemaVersion: CODEX_TRANSCRIPT_SCHEMA_VERSION,
    steerEntries: [],
    threadId,
    turn: null,
    turnId,
  };
}

function createOrphanEventsFile(threadId: string): CodexTranscriptOrphanEventsFile {
  return {
    lastTouchedAt: now(),
    schemaVersion: CODEX_TRANSCRIPT_SCHEMA_VERSION,
    threadId,
  };
}

function mergeItemOrder(primaryItemIds: string[], secondaryItemIds: string[]) {
  return Array.from(new Set([
    ...primaryItemIds.filter(Boolean),
    ...secondaryItemIds.filter(Boolean),
  ]));
}

function rememberTurnItemIds(file: CodexTranscriptTurnFile, itemIds: string[]) {
  return mergeItemOrder(file.itemOrder ?? [], itemIds);
}

function readPayloadTimestamp(event: CodexTranscriptRawEvent, key: "completedAtMs" | "startedAtMs") {
  const payload = asRecord(event.payload);
  const params = asRecord(payload?.params);
  const timestamp = params?.[key];
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function createTimelineItemMetadata(event: CodexTranscriptRawEvent): TimelineItemMetadata {
  const receivedAt = event.receivedAt;
  return {
    completedAt: readPayloadTimestamp(event, "completedAtMs"),
    firstSeenAt: receivedAt,
    lastSeenAt: receivedAt,
    startedAt: readPayloadTimestamp(event, "startedAtMs"),
  };
}

function rememberTurnTimelineItem(
  file: CodexTranscriptTurnFile,
  itemId: string,
  item: ThreadItem | null,
  method: string | null,
  metadata: TimelineItemMetadata | null = null,
) {
  return rememberTimelineItem(file, itemId, classifyTimelineEvent(method, item), metadata);
}

function getTurnOrderingUpdate(
  file: CodexTranscriptTurnFile,
  itemId: string,
  item: ThreadItem | null,
  method: string | null,
  metadata: TimelineItemMetadata | null = null,
) {
  const itemOrder = rememberTurnItemIds(file, [itemId]);
  const itemTimeline = rememberTurnTimelineItem({ ...file, itemOrder }, itemId, item, method, metadata);
  return { itemOrder, itemTimeline };
}

function applyTurnTimeline(turn: Turn | null, file: Pick<CodexTranscriptTurnFile, "itemOrder" | "itemTimeline" | "turn">) {
  if (!turn) {
    return turn;
  }

  const normalizedTurn = {
    ...turn,
    items: normalizeThreadItems(turn.items, { mergeDuplicateItems: mergeThreadItem }),
  };
  return {
    ...normalizedTurn,
    items: orderMergedItemsByTimeline(normalizedTurn.items, normalizeTurnTimeline({ ...file, turn: normalizedTurn })),
  };
}

function getContextCompactionItems(turn: Turn | null) {
  return (turn?.items ?? []).filter((item): item is Extract<ThreadItem, { type: "contextCompaction" }> => (
    item.type === "contextCompaction"
  ));
}

function isGenericSnapshotItemId(itemId: string) {
  return /^item-\d+$/u.test(itemId);
}

function reconcileSnapshotContextCompactionItemIds(currentTurn: Turn | null, incomingTurn: Turn) {
  const currentCompactionItems = getContextCompactionItems(currentTurn);
  const incomingCompactionItems = getContextCompactionItems(incomingTurn);
  if (!currentCompactionItems.length || !incomingCompactionItems.length) {
    return {
      aliasesByItemId: new Map<string, string[]>(),
      turn: incomingTurn,
    };
  }

  const canonicalIdsByIncomingId = new Map<string, string>();
  const aliasesByItemId = new Map<string, string[]>();
  incomingCompactionItems.forEach((incomingItem, index) => {
    const currentItem = currentCompactionItems[index];
    if (
      !currentItem
      || currentItem.id === incomingItem.id
      || isGenericSnapshotItemId(currentItem.id)
      || !isGenericSnapshotItemId(incomingItem.id)
    ) {
      return;
    }

    canonicalIdsByIncomingId.set(incomingItem.id, currentItem.id);
    aliasesByItemId.set(currentItem.id, [incomingItem.id]);
  });

  if (!canonicalIdsByIncomingId.size) {
    return {
      aliasesByItemId,
      turn: incomingTurn,
    };
  }

  return {
    aliasesByItemId,
    turn: {
      ...incomingTurn,
      items: incomingTurn.items.map((item) => (
        item.type === "contextCompaction" && canonicalIdsByIncomingId.has(item.id)
          ? { ...item, id: canonicalIdsByIncomingId.get(item.id)! }
          : item
      )),
    },
  };
}

function cleanTurnTimeline(
  timeline: CodexTranscriptTurnFile["itemTimeline"],
  survivingItemIds: Set<string>,
) {
  const cleanedTimeline: CodexTranscriptTurnFile["itemTimeline"] = [];
  const removedAnchorRedirects = new Map<string, string | null>();
  let latestSurvivingAnchorId: string | null = null;

  for (const entry of [...timeline].sort((left, right) => left.sequence - right.sequence)) {
    const isSelfAnchor = entry.anchorItemId === entry.itemId;
    if (!survivingItemIds.has(entry.itemId)) {
      if (isSelfAnchor) {
        removedAnchorRedirects.set(entry.itemId, latestSurvivingAnchorId);
      }
      continue;
    }

    let anchorItemId = entry.anchorItemId;
    if (anchorItemId && !survivingItemIds.has(anchorItemId)) {
      anchorItemId = removedAnchorRedirects.get(anchorItemId) ?? latestSurvivingAnchorId;
    }
    if (isSelfAnchor) {
      anchorItemId = entry.itemId;
      latestSurvivingAnchorId = entry.itemId;
    }

    cleanedTimeline.push({
      aliases: entry.aliases,
      anchorItemId,
      completedAt: entry.completedAt,
      firstSeenAt: entry.firstSeenAt,
      itemId: entry.itemId,
      lastSeenAt: entry.lastSeenAt,
      sequence: cleanedTimeline.length + 1,
      startedAt: entry.startedAt,
    });
  }

  return cleanedTimeline;
}

function reindexTimeline(timeline: CodexTranscriptTurnFile["itemTimeline"]) {
  return [...timeline]
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry, index) => ({
      ...entry,
      sequence: index + 1,
    }));
}

function repairContextCompactionTimelineFromQuestionnaireAnchors(
  file: CodexTranscriptTurnFile,
  turn: Turn,
  timeline: CodexTranscriptTurnFile["itemTimeline"],
) {
  let nextTimeline = timeline;
  for (const contextCompactionItem of getContextCompactionItems(turn)) {
    const contextCompactionIndex = turn.items.findIndex((item) => item.id === contextCompactionItem.id);
    const earliestQuestionnaireAnchorIndex = Math.min(...file.questionnaireEntries
      .filter((entry) => entry.insertAfterItemId === contextCompactionItem.id)
      .map((entry) => entry.insertAfterItemIndex)
      .filter((index): index is number => index !== null && index >= 0));
    if (
      !Number.isFinite(earliestQuestionnaireAnchorIndex)
      || contextCompactionIndex < 0
      || contextCompactionIndex <= earliestQuestionnaireAnchorIndex
    ) {
      continue;
    }

    for (let index = Math.min(earliestQuestionnaireAnchorIndex, turn.items.length - 1); index >= 0; index -= 1) {
      const anchorItem = turn.items[index];
      if (!anchorItem || anchorItem.id === contextCompactionItem.id || !classifyThreadItemAsTimelineAnchor(anchorItem)) {
        continue;
      }

      const anchorEntry = nextTimeline.find((entry) => entry.itemId === anchorItem.id);
      if (!anchorEntry) {
        break;
      }

      nextTimeline = reindexTimeline(nextTimeline.map((entry) => (
        entry.itemId === contextCompactionItem.id
          ? {
            ...entry,
            anchorItemId: anchorItem.id,
            sequence: anchorEntry.sequence + 0.5,
          }
          : entry
      )));
      break;
    }
  }

  return nextTimeline;
}

function normalizeTurnFileSnapshot(file: CodexTranscriptTurnFile) {
  if (!file.turn) {
    return {
      ...file,
      browseScreenshotEntries: file.browseScreenshotEntries ?? [],
      itemOrder: file.itemOrder ?? [],
      itemTimeline: normalizeTurnTimeline(file),
      questionnaireEntries: file.questionnaireEntries ?? [],
      steerEntries: file.steerEntries ?? [],
    };
  }

  const normalizedTurn = applyTurnTimeline(file.turn, file);
  if (!normalizedTurn) {
    return {
      ...file,
      browseScreenshotEntries: file.browseScreenshotEntries ?? [],
      questionnaireEntries: file.questionnaireEntries ?? [],
      steerEntries: file.steerEntries ?? [],
    };
  }

  const survivingItemIds = new Set(normalizedTurn.items.map((item) => item.id));
  const normalizedTimeline = normalizeTurnTimeline({
    ...file,
    turn: normalizedTurn,
  });
  const repairedTimeline = repairContextCompactionTimelineFromQuestionnaireAnchors(file, normalizedTurn, normalizedTimeline);
  const cleanedTimeline = cleanTurnTimeline(repairedTimeline, survivingItemIds);

  return {
    ...file,
    browseScreenshotEntries: file.browseScreenshotEntries ?? [],
    itemOrder: normalizedTurn.items.map((item) => item.id),
    itemTimeline: cleanedTimeline,
    questionnaireEntries: file.questionnaireEntries ?? [],
    steerEntries: file.steerEntries ?? [],
    turn: {
      ...normalizedTurn,
      items: orderMergedItemsByTimeline(normalizedTurn.items, cleanedTimeline),
    },
  };
}

function orderTurnFilesByThreadIndex(threadFile: CodexTranscriptThreadFile, turnFiles: CodexTranscriptTurnFile[]) {
  const turnIndexesById = new Map(threadFile.turnIndex.map((entry, index) => [entry.turnId, index]));
  return [...turnFiles].sort((left, right) => {
    const leftIndex = turnIndexesById.get(left.turnId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = turnIndexesById.get(right.turnId) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.turnId.localeCompare(right.turnId);
  });
}

function mergeTurnItems(currentTurn: Turn | null, incomingTurn: Turn) {
  if (!currentTurn) {
    return {
      ...incomingTurn,
      items: normalizeThreadItems(incomingTurn.items, { mergeDuplicateItems: mergeThreadItem }),
    };
  }

  const incomingItemsById = new Map(incomingTurn.items.map((item) => [item.id, item]));
  const incomingOnlyItems = incomingTurn.items.filter((item) => !currentTurn.items.some((currentItem) => currentItem.id === item.id));
  const mergedCurrentItems = currentTurn.items.map((item) => {
    const incomingItem = incomingItemsById.get(item.id);
    return incomingItem ? mergeThreadItem(incomingItem, item) : item;
  });
  return {
    ...incomingTurn,
    items: normalizeThreadItems([...mergedCurrentItems, ...incomingOnlyItems], { mergeDuplicateItems: mergeThreadItem }),
    itemsView: incomingTurn.itemsView === "full" || currentTurn.itemsView !== "full"
      ? incomingTurn.itemsView
      : currentTurn.itemsView,
  };
}

function upsertItem(turn: Turn | null, item: ThreadItem, turnId: string): Turn {
  const baseTurn = turn ?? {
    completedAt: null,
    durationMs: null,
    error: null,
    id: turnId,
    items: [],
    itemsView: "full",
    startedAt: null,
    status: "inProgress",
  } satisfies Turn;
  const existingIndex = baseTurn.items.findIndex((existingItem) => existingItem.id === item.id);
  const nextItems = [...baseTurn.items];
  if (existingIndex >= 0) {
    nextItems[existingIndex] = mergeThreadItem(item, nextItems[existingIndex]!);
  } else {
    nextItems.push(item);
  }

  return {
    ...baseTurn,
    items: normalizeThreadItems(nextItems, { mergeDuplicateItems: mergeThreadItem }),
    itemsView: "full",
  };
}

function updateCommandOutput(turn: Turn | null, itemId: string, delta: string) {
  if (!turn) {
    return turn;
  }

  let changed = false;
  const items = turn.items.map((item) => {
    if (item.id !== itemId || item.type !== "commandExecution") {
      return item;
    }

    changed = true;
    return {
      ...item,
      aggregatedOutput: appendCommandOutputDelta(item.aggregatedOutput, delta),
    };
  });

  return changed ? { ...turn, items } : turn;
}

function createStreamingAgentMessageItem(itemId: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return {
    id: itemId,
    memoryCitation: null,
    phase: "commentary",
    text: "",
    type: "agentMessage",
  };
}

function createStreamingPlanItem(itemId: string): Extract<ThreadItem, { type: "plan" }> {
  return {
    id: itemId,
    text: "",
    type: "plan",
  };
}

function createStreamingReasoningItem(itemId: string): Extract<ThreadItem, { type: "reasoning" }> {
  return {
    content: [],
    id: itemId,
    summary: [],
    type: "reasoning",
  };
}

function appendIndexedText(values: string[], index: number, delta: string) {
  const nextValues = [...values];
  while (nextValues.length <= index) {
    nextValues.push("");
  }
  nextValues[index] = `${nextValues[index] ?? ""}${delta}`;
  return nextValues;
}

function ensureIndexedText(values: string[], index: number) {
  const nextValues = [...values];
  while (nextValues.length <= index) {
    nextValues.push("");
  }
  return nextValues;
}

function updateOrCreateItem(
  turn: Turn | null,
  turnId: string,
  itemId: string,
  createItem: () => ThreadItem,
  updater: (item: ThreadItem) => ThreadItem | null,
) {
  const baseTurn = turn ?? {
    completedAt: null,
    durationMs: null,
    error: null,
    id: turnId,
    items: [],
    itemsView: "full",
    startedAt: null,
    status: "inProgress",
  } satisfies Turn;
  const itemIndex = baseTurn.items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    const nextItem = updater(createItem());
    return nextItem
      ? {
        ...baseTurn,
        items: [...baseTurn.items, nextItem],
        itemsView: "full" as const,
      }
      : baseTurn;
  }

  let changed = false;
  const nextItems = baseTurn.items.map((item, index) => {
    if (index !== itemIndex) {
      return item;
    }

    const nextItem = updater(item);
    if (!nextItem) {
      return item;
    }

    changed = true;
    return nextItem;
  });
  return changed ? { ...baseTurn, items: nextItems, itemsView: "full" as const } : baseTurn;
}

function updateExistingItem(
  turn: Turn | null,
  itemId: string,
  updater: (item: ThreadItem) => ThreadItem | null,
) {
  if (!turn) {
    return turn;
  }

  let changed = false;
  const items = turn.items.map((item) => {
    if (item.id !== itemId) {
      return item;
    }

    const nextItem = updater(item);
    if (!nextItem) {
      return item;
    }

    changed = true;
    return nextItem;
  });
  return changed ? { ...turn, items } : turn;
}

function extractDelta(value: unknown) {
  const params = asRecord(asRecord(value)?.params);
  return asString(params?.delta);
}

function extractItemId(value: unknown) {
  const params = asRecord(asRecord(value)?.params);
  return asString(params?.itemId);
}

function extractNumberParam(value: unknown, key: string) {
  const params = asRecord(asRecord(value)?.params);
  const rawValue = params?.[key];
  return typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 0 ? rawValue : null;
}

function isTurnTerminalEvent(event: CodexTranscriptRawEvent) {
  return event.method === "turn/completed";
}

function canonicalizeJson(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]));
}

function stableJsonStringify(value: unknown) {
  return JSON.stringify(canonicalizeJson(value));
}

function withoutLastTouchedAt<TValue extends { lastTouchedAt?: unknown }>(value: TValue) {
  const { lastTouchedAt: _lastTouchedAt, ...rest } = value;
  return rest;
}

function preserveCurrentIfOnlyLastTouchedAtChanged<TValue extends { lastTouchedAt?: unknown }>(
  current: TValue,
  next: TValue,
) {
  return stableJsonStringify(withoutLastTouchedAt(current)) === stableJsonStringify(withoutLastTouchedAt(next))
    ? current
    : next;
}

export default class CodexTranscriptStore {
  private readonly getProtectedThreadIds: () => Iterable<string>;
  private lastPrunedAt = 0;
  private readonly json = new AtomicJsonStore();
  private readonly pruneTimer: NodeJS.Timeout;
  private readonly readyPromise: Promise<void>;
  private readonly throttledThreadTouches = new Map<string, number>();
  private readonly threadsDirectoryPath: string;

  constructor(projectRoot: string, getProtectedThreadIds: () => Iterable<string> = () => []) {
    this.getProtectedThreadIds = getProtectedThreadIds;
    this.threadsDirectoryPath = path.join(projectRoot, ".workbench", "transcripts", "codex", "threads");
    this.readyPromise = runCodexTranscriptMigrations(path.dirname(this.threadsDirectoryPath), this.json);
    this.pruneTimer = setInterval(() => {
      void this.pruneExpiredThreads(now(), this.getProtectedThreadIds()).catch(() => undefined);
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
    void this.pruneExpiredThreads(now(), this.getProtectedThreadIds()).catch(() => undefined);
    void this.readyPromise
      .then(async () => {
        const rootDirectoryPath = path.dirname(this.threadsDirectoryPath);
        await queueCodexTranscriptRequestSidecarCleanup(rootDirectoryPath);
        await queueCodexTranscriptImageAssetMigration(rootDirectoryPath);
        await queueCodexTranscriptCommandOutputCompactionMigration(rootDirectoryPath);
      })
      .catch(() => undefined);
  }

  async dispose() {
    clearInterval(this.pruneTimer);
    await this.readyPromise;
    await this.json.waitForIdle();
  }

  async recordClientRequest(request: JsonRpcRequest) {
    await this.ready();
    const steerEntry = createSteerHistoryEntryFromRequest(request);
    if (steerEntry) {
      await this.recordSteerHistoryEntry(steerEntry, createRawEvent("client-request", request, request.method, request.id ?? null));
      return;
    }

    return this.recordRawTraffic("client-request", request, null, request);
  }

  async recordUpstreamResponse(originalRequest: JsonRpcRequest | null, response: JsonRpcResponse) {
    await this.ready();
    if (originalRequest?.method === "turn/steer") {
      const errorMessage = getJsonRpcErrorMessage(response);
      if (errorMessage) {
        const steerEntry = createSteerHistoryEntryFromRequest(originalRequest);
        if (steerEntry) {
          const event = createRawEvent("upstream-response", response, originalRequest.method, response.id ?? null);
          await this.recordSteerHistoryEntry(updateSteerEntryStatus(
            steerEntry,
            "failed",
            event.receivedAt,
            { error: errorMessage },
          ), event);
          return;
        }
      }
    }

    await this.recordRawTraffic("upstream-response", response, originalRequest?.method ?? null, originalRequest);
  }

  async recordHydratedThreadSnapshot(response: JsonRpcResponse) {
    await this.ready();
    const thread = extractThread(response);
    if (thread) {
      await this.recordThreadSnapshot(thread);
    }
  }

  async recordUpstreamNotification(notification: JsonRpcNotification) {
    await this.ready();
    if (shouldPersistRawNotificationToJournal(notification.method)) {
      await this.recordRawTraffic("upstream-notification", notification);
    }

    const threadId = extractThreadId(notification);
    const turnId = extractTurnId(notification);
    const delta = extractDelta(notification);
    const itemId = extractItemId(notification);
    if (!threadId || !turnId || !itemId) {
      return;
    }

    switch (notification.method) {
      case "item/agentMessage/delta":
        if (delta !== null) {
          await this.updateAgentMessageDelta(threadId, turnId, itemId, notification.method, delta);
          return;
        }
        break;
      case "item/plan/delta":
        if (delta !== null) {
          await this.updatePlanDelta(threadId, turnId, itemId, notification.method, delta);
          return;
        }
        break;
      case "item/commandExecution/outputDelta":
        if (delta !== null) {
          await this.updateCommandOutputDelta(threadId, turnId, itemId, notification.method, delta);
          return;
        }
        break;
      case "item/fileChange/patchUpdated":
        await this.updateFileChangePatch(threadId, turnId, itemId, notification);
        return;
      case "item/reasoning/summaryPartAdded":
        await this.updateReasoningSummaryPart(threadId, turnId, itemId, notification);
        return;
      case "item/reasoning/summaryTextDelta":
        if (delta !== null) {
          await this.updateReasoningSummaryDelta(threadId, turnId, itemId, notification, delta);
          return;
        }
        break;
      case "item/reasoning/textDelta":
        if (delta !== null) {
          await this.updateReasoningTextDelta(threadId, turnId, itemId, notification, delta);
          return;
        }
        break;
    }

    if (classifyTimelineEvent(notification.method, null)) {
      await this.updateItemTimelineOnly(threadId, turnId, itemId, notification.method);
    }
  }

  async recordUpstreamNotifications(notifications: JsonRpcNotification[]) {
    await this.ready();
    for (const notification of notifications) {
      await this.recordUpstreamNotification(notification);
    }
  }

  async recordUpstreamServerRequest(request: JsonRpcRequest) {
    await this.ready();
    if (request.method === "item/tool/call") {
      const params = asRecord(request.params);
      const threadId = asString(params?.threadId);
      const turnId = asString(params?.turnId);
      const callId = asString(params?.callId);
      const tool = asString(params?.tool);
      if (threadId && turnId && callId && tool) {
        await this.recordTurnItem(threadId, turnId, createDynamicToolCallItem({
          arguments: (params?.arguments ?? null) as JsonValue,
          callId,
          namespace: asString(params?.namespace),
          threadId,
          tool,
          turnId,
        }), createRawEvent("upstream-server-request", request, request.method, request.id ?? null));
      }
    }
    return this.recordRawTraffic("upstream-server-request", request, null, request);
  }

  async recordQuestionnaireResolved(entry: WorkbenchQuestionnaireHistoryEntry) {
    await this.ready();
    const event = createRawEvent("workbench", entry, "questionnaire/respond", entry.requestKey);
    await this.updateTurnFile(entry.threadId, entry.turnId, (file) => ({
      ...file,
      lastTouchedAt: now(),
      questionnaireEntries: sortQuestionnaireEntries([
        ...file.questionnaireEntries.filter((existingEntry) => existingEntry.requestKey !== entry.requestKey),
        entry,
      ]),
    }));
    await this.appendTurnEvent(entry.threadId, entry.turnId, event);
    await this.touchThread(entry.threadId, null);
  }

  async recordSteerHistoryEntry(entry: WorkbenchSteerHistoryEntry, event: CodexTranscriptRawEvent) {
    await this.ready();
    await this.updateTurnFile(entry.threadId, entry.turnId, (file) => ({
      ...file,
      lastTouchedAt: now(),
      steerEntries: sortSteerEntries([
        ...(file.steerEntries ?? []).filter((existingEntry) => existingEntry.entryKey !== entry.entryKey),
        entry,
      ]),
    }));
    await this.appendTurnEvent(entry.threadId, entry.turnId, event);
    await this.touchThread(entry.threadId, null);
  }

  async recordBrowseScreenshotEntry(entry: WorkbenchBrowseScreenshotEntry) {
    await this.ready();
    await this.updateTurnFile(entry.threadId, entry.turnId, (file) => ({
      ...file,
      browseScreenshotEntries: sortBrowseScreenshotEntries([
        ...(file.browseScreenshotEntries ?? []).filter((existingEntry) => existingEntry.entryKey !== entry.entryKey),
        entry,
      ]),
      lastTouchedAt: now(),
    }));
    await this.touchThread(entry.threadId, null);
  }

  async updateSteerHistoryEntryStatus(
    threadId: string,
    turnId: string,
    entryKey: string,
    status: WorkbenchSteerHistoryEntry["status"],
    event: CodexTranscriptRawEvent,
    options: { canonicalItemId?: string | null; error?: string | null } = {},
  ) {
    await this.ready();
    await this.updateTurnFile(threadId, turnId, (file) => {
      const entries = file.steerEntries ?? [];
      let changed = false;
      const nextEntries = entries.map((entry) => {
        if (entry.entryKey !== entryKey) {
          return entry;
        }

        changed = true;
        return updateSteerEntryStatus(entry, status, event.receivedAt, options);
      });

      return {
        ...file,
        lastTouchedAt: now(),
        steerEntries: changed ? sortSteerEntries(nextEntries) : entries,
      };
    });
    await this.appendTurnEvent(threadId, turnId, event);
    await this.touchThread(threadId, null);
  }

  async listSteerHistory(threadId: string) {
    await this.ready();
    const turnFiles = await this.readTurnFiles(threadId);
    return sortSteerEntries(turnFiles.flatMap((file) => file.steerEntries ?? []));
  }

  async listQuestionnaireHistory(threadId: string) {
    await this.ready();
    const turnFiles = await this.readTurnFiles(threadId);
    return sortQuestionnaireEntries(turnFiles.flatMap((file) => file.questionnaireEntries));
  }

  async listBrowseScreenshotEntries(threadId: string) {
    await this.ready();
    const turnFiles = await this.readTurnFiles(threadId);
    return sortBrowseScreenshotEntries(turnFiles.flatMap((file) => file.browseScreenshotEntries ?? []));
  }

  async hydrateThreadResponse(
    originalRequest: JsonRpcRequest,
    response: JsonRpcResponse,
    options: HydrateThreadResponseOptions = {},
  ) {
    await this.ready();
    const method = asString(originalRequest.method);
    const originalParams = asRecord(originalRequest.params);
    if (!method || !["thread/read", "thread/resume", "thread/start", "thread/fork"].includes(method) || response.error) {
      return method === "thread/read" && response.error
        ? await this.hydrateStoredThreadReadResponse(asString(originalParams?.threadId), response, options.hydration ?? null)
        : response;
    }

    const result = asRecord(response.result);
    const thread = asRecord(result?.thread) as Thread | null;
    if (!thread?.id) {
      return response;
    }

    const hydratedThread = await this.hydrateSelectedThread(thread, options.hydration ?? null, {
      repair: options.touchThread !== false,
    });
    if (options.touchThread !== false) {
      await this.touchThread(thread.id, thread);
    }
    return hydratedThread === thread
      ? response
      : {
        ...response,
        result: {
          ...result,
          thread: hydratedThread,
        },
      };
  }

  private async hydrateStoredThreadReadResponse(
    threadId: string | null,
    response: JsonRpcResponse,
    hydration: WorkbenchThreadHydrationRequest | null,
  ) {
    if (!threadId) {
      return response;
    }

    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    const storedThread = threadFile?.thread ?? null;
    if (!storedThread) {
      return response;
    }

    const hydratedThread = await this.hydrateSelectedThread(storedThread, hydration, { repair: true, threadFile });
    return {
      id: response.id,
      result: {
        thread: hydratedThread,
      },
    } satisfies JsonRpcResponse;
  }

  private async hydrateSelectedThread(
    thread: Thread,
    hydration: WorkbenchThreadHydrationRequest | null,
    {
      repair,
      threadFile,
    }: {
      repair: boolean;
      threadFile?: CodexTranscriptThreadFile | null;
    },
  ) {
    const storedThreadFile = threadFile ?? await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(thread.id), null);
    const turnIndex = mergeTurnIndexes(storedThreadFile?.turnIndex ?? [], thread.turns, thread);

    if (hydration?.mode === "legacyFull") {
      const storedTurns = orderTurnFilesByThreadIndex(storedThreadFile ?? createThreadFile(thread.id), await this.readTurnFiles(thread.id, {
        repair,
        turnIds: turnIndex.map((entry) => entry.turnId),
      }))
        .filter((file) => file.turn !== null)
        .map((file) => ({
          itemTimeline: file.itemTimeline,
          turn: file.turn!,
        }));
      const legacyThread = hydrateThreadWithStoredTurns(thread, storedTurns);
      const compactedLegacyThread = compactCommandOutputPayload(legacyThread);
      return {
        ...compactedLegacyThread,
        workbenchTurnHistory: turnIndex.map((entry) => createTurnHistoryEntry(
          entry,
          new Set(compactedLegacyThread.turns.map((turn) => turn.id)),
          new Set(),
        )),
      };
    }

    const requestedTurnId = hydration?.mode === "previous"
      ? getPreviousTurnId(turnIndex, hydration.beforeTurnId)
      : getLatestTurnId(turnIndex, thread.turns);
    const selectedTurnIds = new Set(requestedTurnId ? [requestedTurnId] : []);
    const selectedUpstreamThread = {
      ...thread,
      turns: thread.turns.filter((turn) => selectedTurnIds.has(turn.id)),
    };
    const selectedStoredTurnFiles = requestedTurnId
      ? [await this.readTurnFile(thread.id, requestedTurnId, { repair })].filter((file): file is CodexTranscriptTurnFile => file !== null)
      : [];
    const storedTurns = selectedStoredTurnFiles
      .filter((file) => file.turn !== null)
      .map((file) => ({
        itemTimeline: file.itemTimeline,
        turn: file.turn!,
      }));
    const hydratedThread = compactCommandOutputPayload(hydrateThreadWithStoredTurns(selectedUpstreamThread, storedTurns));
    const loadedTurnIds = new Set(hydratedThread.turns.map((turn) => turn.id));
    const missingTurnIds = new Set<string>();
    if (requestedTurnId && !loadedTurnIds.has(requestedTurnId)) {
      missingTurnIds.add(requestedTurnId);
    }

    return {
      ...hydratedThread,
      workbenchTurnHistory: turnIndex.map((entry) => createTurnHistoryEntry(entry, loadedTurnIds, missingTurnIds)),
    };
  }

  async pruneExpiredThreads(timestamp = now(), protectedThreadIds: Iterable<string> = []) {
    await this.ready();
    if (timestamp - this.lastPrunedAt < PRUNE_INTERVAL_MS) {
      return;
    }

    this.lastPrunedAt = timestamp;
    const protectedIds = new Set(protectedThreadIds);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.threadsDirectoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const threadDirectoryPath = path.join(this.threadsDirectoryPath, entry);
      const threadFilePath = path.join(threadDirectoryPath, "thread.json");
      const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(threadFilePath, null);
      if (!threadFile || protectedIds.has(threadFile.threadId) || timestamp - threadFile.lastTouchedAt < PRUNE_AFTER_MS) {
        return;
      }

      const resolvedRoot = path.resolve(this.threadsDirectoryPath);
      const resolvedTarget = path.resolve(threadDirectoryPath);
      if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        return;
      }

      await fs.rm(resolvedTarget, { force: true, recursive: true });
    }));
  }

  private async recordRawTraffic(
    source: CodexTranscriptRawEvent["source"],
    payload: unknown,
    fallbackMethod: string | null = null,
    originalRequest: JsonRpcRequest | null = null,
  ) {
    const compactedPayload = compactCommandOutputPayload(payload);
    const originalParams = asRecord(originalRequest?.params);
    const payloadThread = extractThread(compactedPayload);
    const payloadThreadId = payloadThread?.id ?? extractThreadId(compactedPayload) ?? asString(originalParams?.threadId);
    const payloadForRecord = payloadThreadId
      ? (await this.externalizeInlineImages(payloadThreadId, compactedPayload)).value
      : compactedPayload;
    const method = asString(asRecord(payloadForRecord)?.method) ?? fallbackMethod;
    const requestId = asRecord(payloadForRecord)?.id;
    const normalizedRequestId = typeof requestId === "number" || typeof requestId === "string" ? requestId : null;
    const thread = extractThread(payloadForRecord);
    if (thread) {
      await this.recordThreadSnapshot(thread);
      return;
    }

    const event = createRawEvent(source, payloadForRecord, method, normalizedRequestId);
    const threadId = extractThreadId(payloadForRecord) ?? asString(originalParams?.threadId);
    if (!threadId) {
      return;
    }

    const turn = extractTurn(payloadForRecord);
    if (turn) {
      await this.recordTurnSnapshot(threadId, turn, event);
      return;
    }

    const turnId = extractTurnId(payloadForRecord) ?? asString(originalParams?.turnId) ?? asString(originalParams?.expectedTurnId);
    const item = extractItem(payloadForRecord);
    if (turnId && item) {
      await this.recordTurnItem(threadId, turnId, item, event);
      return;
    }

    if (turnId) {
      await this.updateTurnFile(threadId, turnId, (file) => ({
        ...file,
        lastTouchedAt: now(),
      }));
      await this.appendTurnEvent(threadId, turnId, event);
      await this.touchThread(threadId, null);
      return;
    }

    const requestKey = typeof requestId === "number" || typeof requestId === "string" ? String(requestId) : null;
    if (requestKey) {
      await this.touchThreadThrottled(threadId);
      return;
    }

    await this.updateOrphanEventsFile(threadId, (file) => ({
      ...file,
      lastTouchedAt: now(),
    }));
    await this.appendOrphanEvent(threadId, event);
    await this.touchThreadThrottled(threadId);
  }

  private async recordThreadSnapshot(thread: Thread) {
    await this.touchThread(thread.id, thread);
    await Promise.all(thread.turns.map((turn) => this.recordThreadSnapshotTurn(thread.id, turn)));
  }

  private async recordThreadSnapshotTurn(threadId: string, turn: Turn) {
    await this.updateTurnFile(threadId, turn.id, (file) => {
      const { aliasesByItemId, turn: reconciledTurn } = reconcileSnapshotContextCompactionItemIds(file.turn, turn);
      const itemOrder = reconciledTurn.items.map((item) => item.id);
      const nextItemOrder = mergeItemOrder(itemOrder, file.itemOrder ?? []);
      const nextItemTimeline = reconciledTurn.items.reduce(
        (timeline, item) => rememberTimelineItem(
          { ...file, itemOrder: nextItemOrder, itemTimeline: timeline },
          item.id,
          classifyTimelineEvent(null, item),
          { aliases: aliasesByItemId.get(item.id) },
        ),
        normalizeTurnTimeline(file),
      );
      return {
        ...file,
        itemOrder: nextItemOrder,
        itemTimeline: nextItemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(mergeTurnItems(file.turn, reconciledTurn), {
          ...file,
          itemOrder: nextItemOrder,
          itemTimeline: nextItemTimeline,
        }),
      };
    });
  }

  private async recordTurnSnapshot(threadId: string, turn: Turn, event: CodexTranscriptRawEvent) {
    await this.updateTurnFile(threadId, turn.id, (file) => {
      const { aliasesByItemId, turn: reconciledTurn } = reconcileSnapshotContextCompactionItemIds(file.turn, turn);
      const mergedTurn = mergeTurnItems(file.turn, reconciledTurn);
      const nextItemOrder = mergeItemOrder(reconciledTurn.items.map((item) => item.id), file.itemOrder ?? []);
      const nextItemTimeline = reconciledTurn.items.reduce(
        (timeline, item) => rememberTimelineItem(
          { ...file, itemOrder: nextItemOrder, itemTimeline: timeline },
          item.id,
          classifyTimelineEvent(event.method, item),
          { aliases: aliasesByItemId.get(item.id) },
        ),
        normalizeTurnTimeline(file),
      );
      return {
        ...file,
        itemOrder: nextItemOrder,
        itemTimeline: nextItemTimeline,
        lastTouchedAt: now(),
        steerEntries: updatePendingSteerEntriesForInterruptedTurn(file.steerEntries ?? [], mergedTurn, event.receivedAt),
        turn: applyTurnTimeline(mergedTurn, {
          ...file,
          itemOrder: nextItemOrder,
          itemTimeline: nextItemTimeline,
        }),
      };
    });
    await this.appendTurnEvent(threadId, turn.id, event);
    if (isTurnTerminalEvent(event)) {
      await this.compactTurnJournal(threadId, turn.id);
      await this.touchThread(threadId, null);
      return;
    }
    await this.touchThreadThrottled(threadId);
  }

  private async recordTurnItem(threadId: string, turnId: string, item: ThreadItem, event: CodexTranscriptRawEvent) {
    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, item.id, item, event.method, createTimelineItemMetadata(event));
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        steerEntries: updateMatchingPendingSteerEntriesForUserMessage(file.steerEntries ?? [], item, event.receivedAt),
        turn: applyTurnTimeline(upsertItem(file.turn, item, turnId), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.appendTurnEvent(threadId, turnId, event);
    await this.touchThreadThrottled(threadId);
  }

  private async updateItemTimelineOnly(threadId: string, turnId: string, itemId: string, method: string | null) {
    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, null, method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(file.turn, {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updateCommandOutputDelta(threadId: string, turnId: string, itemId: string, method: string | null, delta: string) {
    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, null, method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateCommandOutput(file.turn, itemId, delta), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updateAgentMessageDelta(threadId: string, turnId: string, itemId: string, method: string | null, delta: string) {
    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, createStreamingAgentMessageItem(itemId), method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingAgentMessageItem(itemId), (item) => (
          item.type === "agentMessage" ? { ...item, text: `${item.text}${delta}` } : null
        )), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updatePlanDelta(threadId: string, turnId: string, itemId: string, method: string | null, delta: string) {
    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, createStreamingPlanItem(itemId), method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingPlanItem(itemId), (item) => (
          item.type === "plan" ? { ...item, text: `${item.text}${delta}` } : null
        )), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updateReasoningSummaryPart(threadId: string, turnId: string, itemId: string, notification: JsonRpcNotification) {
    const summaryIndex = extractNumberParam(notification, "summaryIndex");
    if (summaryIndex === null) {
      return;
    }

    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, createStreamingReasoningItem(itemId), notification.method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingReasoningItem(itemId), (item) => (
          item.type === "reasoning" ? { ...item, summary: ensureIndexedText(item.summary, summaryIndex) } : null
        )), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updateReasoningSummaryDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    notification: JsonRpcNotification,
    delta: string,
  ) {
    const summaryIndex = extractNumberParam(notification, "summaryIndex");
    if (summaryIndex === null) {
      return;
    }

    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, createStreamingReasoningItem(itemId), notification.method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingReasoningItem(itemId), (item) => (
          item.type === "reasoning"
            ? { ...item, summary: appendIndexedText(item.summary, summaryIndex, delta) }
            : null
        )), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updateReasoningTextDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    notification: JsonRpcNotification,
    delta: string,
  ) {
    const contentIndex = extractNumberParam(notification, "contentIndex");
    if (contentIndex === null) {
      return;
    }

    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, createStreamingReasoningItem(itemId), notification.method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingReasoningItem(itemId), (item) => (
          item.type === "reasoning"
            ? { ...item, content: appendIndexedText(item.content, contentIndex, delta) }
            : null
        )), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async updateFileChangePatch(threadId: string, turnId: string, itemId: string, notification: JsonRpcNotification) {
    const changes = asRecord(notification.params)?.changes;
    if (!Array.isArray(changes)) {
      return;
    }

    await this.updateTurnFile(threadId, turnId, (file) => {
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, itemId, null, notification.method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(updateExistingItem(file.turn, itemId, (item) => (
          item.type === "fileChange"
            ? { ...item, changes: changes as Extract<ThreadItem, { type: "fileChange" }>["changes"] }
            : null
        )), {
          ...file,
          itemOrder,
          itemTimeline,
        }),
      };
    });
    await this.touchThreadThrottled(threadId);
  }

  private async touchThreadThrottled(threadId: string) {
    const timestamp = now();
    const lastTouchedAt = this.throttledThreadTouches.get(threadId) ?? 0;
    if (timestamp - lastTouchedAt < THREAD_TOUCH_THROTTLE_MS) {
      return;
    }

    this.throttledThreadTouches.set(threadId, timestamp);
    await this.touchThread(threadId, null);
  }

  private async touchThread(threadId: string, thread: Thread | null) {
    await this.updateThreadFile(threadId, (file) => {
      const nextThread = thread ?? file.thread;
      const turnIndex = thread
        ? mergeTurnIndexes(file.turnIndex, thread.turns, thread)
        : file.turnIndex;
      const nextStoredThread = nextThread ? createCompactThreadSnapshot(nextThread) : null;
      return {
        ...file,
        cliVersion: nextThread?.cliVersion ?? file.cliVersion,
        lastTouchedAt: now(),
        sourceThreadIds: Array.from(new Set([...file.sourceThreadIds, threadId])),
        thread: nextStoredThread,
        turnIndex,
      };
    });
  }

  private threadDirectoryPath(threadId: string) {
    return path.join(this.threadsDirectoryPath, encodeTranscriptPathSegment(threadId));
  }

  private externalizeInlineImages<TValue>(threadId: string, value: TValue) {
    return externalizeCodexTranscriptInlineImages(value, {
      encodedThreadId: encodeTranscriptPathSegment(threadId),
      threadDirectoryPath: this.threadDirectoryPath(threadId),
    });
  }

  private threadFilePath(threadId: string) {
    return path.join(this.threadDirectoryPath(threadId), "thread.json");
  }

  private turnFilePath(threadId: string, turnId: string) {
    return path.join(this.threadDirectoryPath(threadId), "turns", `${encodeTranscriptPathSegment(turnId)}.json`);
  }

  private orphanEventsFilePath(threadId: string) {
    return path.join(this.threadDirectoryPath(threadId), "orphan-events.json");
  }

  private turnJournalPath(threadId: string, turnId: string) {
    return path.join(this.threadDirectoryPath(threadId), "turns", `${encodeTranscriptPathSegment(turnId)}.ndjson`);
  }

  private orphanEventsJournalPath(threadId: string) {
    return path.join(this.threadDirectoryPath(threadId), "orphan-events.ndjson");
  }

  private updateThreadFile(threadId: string, updater: (file: CodexTranscriptThreadFile) => CodexTranscriptThreadFile) {
    return this.json.updateIfChanged(this.threadFilePath(threadId), createThreadFile(threadId), async (file) => (
      preserveCurrentIfOnlyLastTouchedAtChanged(file, await updater(file))
    ));
  }

  private updateTurnFile(
    threadId: string,
    turnId: string,
    updater: (file: CodexTranscriptTurnFile) => CodexTranscriptTurnFile | Promise<CodexTranscriptTurnFile>,
  ) {
    return this.json.updateIfChanged(this.turnFilePath(threadId, turnId), createTurnFile(threadId, turnId), async (file) => {
      const normalizedFile = normalizeTurnFileSnapshot(await updater(file));
      const compactedFile = compactCommandOutputPayload(normalizedFile);
      const externalizedFile = (await this.externalizeInlineImages(threadId, compactedFile)).value;
      return preserveCurrentIfOnlyLastTouchedAtChanged(file, externalizedFile);
    });
  }

  private updateOrphanEventsFile(threadId: string, updater: (file: CodexTranscriptOrphanEventsFile) => CodexTranscriptOrphanEventsFile) {
    return this.json.updateIfChanged(this.orphanEventsFilePath(threadId), createOrphanEventsFile(threadId), async (file) => (
      preserveCurrentIfOnlyLastTouchedAtChanged(file, await updater(file))
    ));
  }

  private async appendTurnEvent(threadId: string, turnId: string, event: CodexTranscriptRawEvent) {
    const compactedEvent = compactCommandOutputPayload(event);
    const externalizedEvent = (await this.externalizeInlineImages(threadId, compactedEvent)).value;
    return this.json.appendLine(this.turnJournalPath(threadId, turnId), externalizedEvent);
  }

  private async appendOrphanEvent(threadId: string, event: CodexTranscriptRawEvent) {
    const compactedEvent = compactCommandOutputPayload(event);
    const externalizedEvent = (await this.externalizeInlineImages(threadId, compactedEvent)).value;
    return this.json.appendLine(this.orphanEventsJournalPath(threadId), externalizedEvent);
  }

  private async compactJournal(filePath: string) {
    await this.json.compactJsonLines<CodexTranscriptRawEvent>(filePath);
  }

  private compactTurnJournal(threadId: string, turnId: string) {
    return this.compactJournal(this.turnJournalPath(threadId, turnId));
  }

  private async ready() {
    await this.readyPromise;
  }

  private async readTurnFile(threadId: string, turnId: string, options: { repair?: boolean } = {}) {
    const filePath = this.turnFilePath(threadId, turnId);
    const file = await this.json.read<CodexTranscriptTurnFile | null>(filePath, null);
    if (!file || !SUPPORTED_CODEX_TRANSCRIPT_SCHEMA_VERSIONS.has(file.schemaVersion)) {
      return null;
    }

    const normalizedFile = normalizeTurnFileSnapshot(file);
    const compactedFile = compactCommandOutputPayload(normalizedFile);
    const externalizedFile = (await this.externalizeInlineImages(threadId, compactedFile)).value;
    if (options.repair && stableJsonStringify(file) !== stableJsonStringify(externalizedFile)) {
      await this.json.updateIfChanged(filePath, externalizedFile, () => externalizedFile);
    }

    return externalizedFile;
  }

  private async readTurnFiles(threadId: string, options: { repair?: boolean; turnIds?: Iterable<string> } = {}) {
    const turnsDirectoryPath = path.join(this.threadDirectoryPath(threadId), "turns");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(turnsDirectoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
      return [];
    }

    const allowedEntries = options.turnIds
      ? new Set(Array.from(options.turnIds, (turnId) => `${encodeTranscriptPathSegment(turnId)}.json`))
      : null;
    const files = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .filter((entry) => !allowedEntries || allowedEntries.has(entry))
      .map(async (entry) => {
        const filePath = path.join(turnsDirectoryPath, entry);
        return {
          file: await this.json.read<CodexTranscriptTurnFile | null>(filePath, null),
          filePath,
        };
      }));
    return await Promise.all(files
      .filter((entry): entry is { file: CodexTranscriptTurnFile; filePath: string } => (
        entry.file !== null && SUPPORTED_CODEX_TRANSCRIPT_SCHEMA_VERSIONS.has(entry.file.schemaVersion)
      ))
      .map(async ({ file, filePath }) => {
        const normalizedFile = normalizeTurnFileSnapshot(file);
        const compactedFile = compactCommandOutputPayload(normalizedFile);
        const externalizedFile = (await this.externalizeInlineImages(threadId, compactedFile)).value;
        if (options.repair && stableJsonStringify(file) !== stableJsonStringify(externalizedFile)) {
          await this.json.updateIfChanged(filePath, externalizedFile, () => externalizedFile);
        }
        return externalizedFile;
      }));
  }
}
