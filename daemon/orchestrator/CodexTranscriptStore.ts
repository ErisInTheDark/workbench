/*
 * Keywords: transcript persistence, runtime version, native images, turn ownership.
 * Exports:
 * - CodexTranscriptStore: persist, de-bloat, hydrate, and expose retained turn usage from Codex compatibility transcripts. Keywords: codex, transcript, questionnaire, pruning, usage, image assets.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";
import { compactCommandOutputPayload } from "workbench-shared/codex/thread-command-output";
import { normalizeThreadItems } from "workbench-shared/codex/thread-item-normalization";
import { WORKBENCH_TOOL_CONTEXT_METHOD, type WorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkbenchThreadHydrationRequest } from "../lib/codex/thread-hydration";
import type { WorkbenchBrowseResultEntry, WorkbenchQuestionnaireHistoryEntry, WorkbenchSteerHistoryEntry, WorkbenchThreadContextReadResponse, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import { mergeQuestionnaireHistoryEntries } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { normalizeWorkbenchThreadItemTimeline } from "workbench-shared/workbench/thread/thread-item-timeline";
import AtomicJsonStore from "./AtomicJsonStore";
import { hydrateThreadWithStoredTurns } from "./codex-transcript-hydration";
import { shouldRecordDurableTranscriptNotification } from "./codex-transcript-event-routing";
import { createFirstTurnItemOwners } from "./codex-transcript-item-ownership";
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
import {
  createSteerHistoryEntryFromRequest,
  getJsonRpcErrorMessage,
  getNextSteerDispatchSequence,
  hasNativeSteerReconciliationEvidence,
  reconcileNativeSteerEntriesForTurns,
  sortSteerEntries,
  updateMatchingPendingSteerEntriesForUserMessage,
  updateNativeSteerEntriesForUserMessage,
  updatePendingSteerEntriesForInterruptedTurn,
  updateSteerEntryStatus,
} from "./codex-transcript-steer-history";
import { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "./codex-transcript-version";
import { logError } from "./process-helpers";
import type { OrchestratorTranscriptShadowLog } from "./orchestrator-runtime-objects";

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

function sortBrowseResultEntries(entries: WorkbenchBrowseResultEntry[]) {
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
    nextSteerDispatchSequence: 0,
    sourceThreadIds: [threadId],
    steerEntries: [],
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

function createTurnIndexEntry(thread: Thread | null, turn: Turn): CodexTranscriptThreadFile["turnIndex"][number] {
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
  itemTimeline?: CodexTranscriptTurnFile["itemTimeline"],
): WorkbenchThreadTurnHistoryEntry {
  const normalizedItemTimeline = normalizeWorkbenchThreadItemTimeline(itemTimeline);
  return {
    completedAt: entry.completedAt,
    durationMs: null,
    itemCount: entry.itemCount,
    ...(entry.itemIds ? { itemIds: entry.itemIds } : {}),
    ...(normalizedItemTimeline.length ? { itemTimeline: normalizedItemTimeline } : {}),
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
  thread: Thread | null,
) {
  const upstreamEntriesById = new Map(upstreamTurns.map((turn) => [turn.id, createTurnIndexEntry(thread, turn)]));
  const seenTurnIds = new Set<string>();
  const entries = storedEntries.map((entry) => {
    seenTurnIds.add(entry.turnId);
    const upstreamEntry = upstreamEntriesById.get(entry.turnId);
    if (!upstreamEntry || !entry.itemIds?.length) {
      return upstreamEntry
        ? {
          ...upstreamEntry,
          ...(entry.previousCursor !== undefined ? { previousCursor: entry.previousCursor } : {}),
        }
        : entry;
    }

    const itemIds = Array.from(new Set([...entry.itemIds, ...(upstreamEntry.itemIds ?? [])]));
    return {
      ...upstreamEntry,
      itemCount: Math.max(entry.itemCount, upstreamEntry.itemCount, itemIds.length),
      itemIds,
      ...(entry.previousCursor !== undefined ? { previousCursor: entry.previousCursor } : {}),
    };
  });

  for (const turn of upstreamTurns) {
    if (seenTurnIds.has(turn.id)) {
      continue;
    }

    entries.push(createTurnIndexEntry(thread, turn));
  }

  return hasCrossTurnItemOwners(storedEntries) ? entries : keepFirstTurnItemOwners(entries);
}

function keepFirstTurnItemOwners(entries: CodexTranscriptThreadFile["turnIndex"]) {
  const itemOwners = createFirstTurnItemOwners(entries);
  return entries.flatMap((entry) => {
    if (!entry.itemIds) {
      return [entry];
    }

    const itemIds = entry.itemIds.filter((itemId) => itemOwners.get(itemId) === entry.turnId);
    if (entry.itemCount > 0 && itemIds.length === 0) {
      return [];
    }

    return itemIds.length === entry.itemIds.length
      ? [entry]
      : [{ ...entry, itemCount: itemIds.length, itemIds }];
  });
}

function hasCrossTurnItemOwners(entries: CodexTranscriptThreadFile["turnIndex"]) {
  const ownedItemIds = new Set<string>();
  for (const entry of entries) {
    for (const itemId of entry.itemIds ?? []) {
      if (ownedItemIds.has(itemId)) {
        return true;
      }
      ownedItemIds.add(itemId);
    }
  }
  return false;
}

function reconcileTurnIndexItemIds(
  entries: CodexTranscriptThreadFile["turnIndex"],
  turnFiles: CodexTranscriptTurnFile[],
  upstreamTurns: Turn[] = [],
) {
  const turnFilesById = new Map(turnFiles.map((file) => [file.turnId, file]));
  const upstreamTurnsById = new Map(upstreamTurns.map((turn) => [turn.id, turn]));
  return keepFirstTurnItemOwners(entries.map((entry) => {
    const turnFile = turnFilesById.get(entry.turnId);
    if (!turnFile) {
      return entry;
    }

    const storedItemIds = turnFile.itemTimeline.length
      ? turnFile.itemTimeline.map((item) => item.itemId)
      : turnFile.turn?.items.map((item) => item.id) ?? turnFile.itemOrder;
    const upstreamItemIds = upstreamTurnsById.get(entry.turnId)?.items.map((item) => item.id) ?? [];
    const itemIds = Array.from(new Set([...storedItemIds, ...upstreamItemIds]));
    return { ...entry, itemCount: itemIds.length, itemIds };
  }));
}

function keepTurnOwnedItems(turn: Turn, itemOwners: ReadonlyMap<string, string>) {
  const items = turn.items.filter((item) => {
    const ownerTurnId = itemOwners.get(item.id);
    return !ownerTurnId || ownerTurnId === turn.id;
  });
  return items.length === turn.items.length ? turn : { ...turn, items };
}

function keepIndexedTurns(thread: Thread, entries: CodexTranscriptThreadFile["turnIndex"]) {
  const indexedTurnIds = new Set(entries.map((entry) => entry.turnId));
  const itemOwners = createFirstTurnItemOwners(entries);
  const turns = thread.turns.flatMap((turn) => (
    indexedTurnIds.has(turn.id) ? [keepTurnOwnedItems(turn, itemOwners)] : []
  ));
  return turns.length === thread.turns.length
    && turns.every((turn, index) => turn === thread.turns[index])
    ? thread
    : { ...thread, turns };
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
    browseResultEntries: [],
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
      browseResultEntries: file.browseResultEntries ?? [],
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
      browseResultEntries: file.browseResultEntries ?? [],
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
    browseResultEntries: file.browseResultEntries ?? [],
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

function extractItemId(value: unknown) {
  const params = asRecord(asRecord(value)?.params);
  return asString(params?.itemId);
}

function isTurnTerminalEvent(event: CodexTranscriptRawEvent) {
  return event.method === "turn/completed";
}

function isTurnLifecycleEvent(event: CodexTranscriptRawEvent) {
  return event.method === "turn/started" || isTurnTerminalEvent(event);
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

  constructor(
    projectRoot: string,
    getProtectedThreadIds: () => Iterable<string> = () => [],
    transcriptShadowLog?: OrchestratorTranscriptShadowLog,
    private readonly getRuntimeUserAgent: () => string | null = () => null,
  ) {
    this.getProtectedThreadIds = getProtectedThreadIds;
    this.threadsDirectoryPath = path.join(projectRoot, ".workbench", "transcripts", "codex", "threads");
    this.readyPromise = runCodexTranscriptMigrations(
      path.dirname(this.threadsDirectoryPath),
      this.json,
      transcriptShadowLog,
    );
    this.pruneTimer = setInterval(() => {
      void this.pruneExpiredThreads(now(), this.getProtectedThreadIds()).catch(() => undefined);
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
    void this.pruneExpiredThreads(now(), this.getProtectedThreadIds()).catch(() => undefined);
    void this.readyPromise
      .then(async () => {
        const rootDirectoryPath = path.dirname(this.threadsDirectoryPath);
        await queueCodexTranscriptRequestSidecarCleanup(rootDirectoryPath, transcriptShadowLog);
      })
      .catch(() => undefined);
  }

  async dispose() {
    clearInterval(this.pruneTimer);
    await this.readyPromise;
    await this.json.waitForIdle();
  }

  async recordClientRequest(
    request: JsonRpcRequest,
    admittedSteer: WorkbenchSteerHistoryEntry | null | undefined = undefined,
    originatingTurnId: string | null = null,
  ) {
    await this.ready();
    const steerEntry = admittedSteer === undefined
      ? createSteerHistoryEntryFromRequest(request)
      : admittedSteer;
    if (steerEntry) {
      const event = createRawEvent("client-request", request, request.method, request.id ?? null);
      if (steerEntry.clientUserMessageId) {
        await this.admitNativeSteerHistoryEntry(steerEntry, event);
      } else {
        await this.recordSteerHistoryEntry(steerEntry, event);
      }
      return;
    }

    return this.recordRawTraffic("client-request", request, null, request, originatingTurnId);
  }

  async recordUpstreamResponse(originalRequest: JsonRpcRequest | null, response: JsonRpcResponse, originatingTurnId: string | null = null) {
    await this.ready();
    if (originalRequest?.method === "turn/steer") {
      const steerEntry = createSteerHistoryEntryFromRequest(originalRequest);
      const errorMessage = getJsonRpcErrorMessage(response);
      if (steerEntry?.clientUserMessageId) {
        const event = createRawEvent("upstream-response", response, originalRequest.method, response.id ?? null);
        const acknowledgedTurnId = asString(asRecord(response.result)?.turnId)?.trim() ?? "";
        await this.updateNativeSteerAdmissionResult(
          steerEntry,
          acknowledgedTurnId,
          errorMessage ?? (acknowledgedTurnId ? null : "turn/steer returned an empty turn id."),
          event,
        );
        return;
      }

      if (errorMessage && steerEntry) {
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

    await this.recordRawTraffic("upstream-response", response, originalRequest?.method ?? null, originalRequest, originatingTurnId);
  }

  async recordWorkbenchToolContext(threadId: string, turnId: string, item: WorkbenchToolOutput) {
    await this.ready();
    const externalized = (await this.externalizeInlineImages(threadId, item)).value;
    await this.recordTurnItem(threadId, turnId, externalized, createRawEvent(
      "workbench", { item: externalized, threadId, turnId }, WORKBENCH_TOOL_CONTEXT_METHOD, item.id,
    ));
    return externalized;
  }

  async recordWorkbenchFileChange(threadId: string, turnId: string, item: ThreadItem) {
    await this.ready();
    await this.recordTurnItem(threadId, turnId, item, createRawEvent(
      "workbench", { item, threadId, turnId }, "workbench/patch/findings", item.id,
    ));
  }

  async recordClientRequestFailure(request: JsonRpcRequest, errorMessage: string) {
    await this.ready();
    const steerEntry = createSteerHistoryEntryFromRequest(request);
    if (!steerEntry?.clientUserMessageId) {
      return;
    }

    await this.updateNativeSteerAdmissionResult(
      steerEntry,
      "",
      errorMessage,
      createRawEvent("workbench", { error: errorMessage }, request.method ?? null, request.id ?? null),
    );
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
    if (!shouldRecordDurableTranscriptNotification(notification.method)) return;
    await this.recordRawTraffic("upstream-notification", notification);

    const threadId = extractThreadId(notification);
    const turnId = extractTurnId(notification);
    const itemId = extractItemId(notification);
    if (!threadId || !turnId || !itemId) {
      return;
    }

    if (classifyTimelineEvent(notification.method, null)) {
      await this.updateItemTimelineOnly(threadId, turnId, itemId, notification.method);
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
      questionnaireEntries: sortQuestionnaireEntries(
        mergeQuestionnaireHistoryEntries(file.questionnaireEntries, [entry]),
      ),
    }));
    await this.appendTurnEvent(entry.threadId, entry.turnId, event);
    await this.touchThread(entry.threadId, null);
  }

  async recordSteerHistoryEntry(entry: WorkbenchSteerHistoryEntry, event: CodexTranscriptRawEvent) {
    await this.ready();
    await this.updateTurnFile(entry.threadId, entry.turnId, (file) => {
      const entries = file.steerEntries ?? [];
      const existing = entries.find((candidate) => candidate.entryKey === entry.entryKey);
      const nextEntry = existing?.status === "sent" && entry.status !== "sent" ? existing : entry;
      return {
        ...file,
        lastTouchedAt: now(),
        steerEntries: sortSteerEntries([
          ...entries.filter((candidate) => candidate.entryKey !== entry.entryKey),
          nextEntry,
        ]),
      };
    });
    await this.appendTurnEvent(entry.threadId, entry.turnId, event);
    await this.touchThread(entry.threadId, null);
  }

  private async admitNativeSteerHistoryEntry(entry: WorkbenchSteerHistoryEntry, event: CodexTranscriptRawEvent) {
    let duplicateRequestId: string | null = null;
    await this.updateThreadFile(entry.threadId, (file) => {
      const entries = file.steerEntries ?? [];
      const existing = entries.find((candidate) => candidate.entryKey === entry.entryKey);
      if (existing) {
        if (existing.requestId !== entry.requestId) {
          duplicateRequestId = entry.requestId;
        }
        return file;
      }

      const dispatchSequence = getNextSteerDispatchSequence(file);
      return {
        ...file,
        lastTouchedAt: now(),
        nextSteerDispatchSequence: dispatchSequence + 1,
        steerEntries: sortSteerEntries([...entries, { ...entry, dispatchSequence }]),
      };
    });
    if (duplicateRequestId) {
      logError(
        "codex-transcript",
        `ignored duplicate native steer id for thread ${entry.threadId} from upstream request ${duplicateRequestId}`,
      );
    }
    await this.appendTurnEvent(entry.threadId, entry.turnId, event);
    await this.touchThread(entry.threadId, null);
  }

  private async updateNativeSteerAdmissionResult(
    requestedEntry: WorkbenchSteerHistoryEntry,
    acknowledgedTurnId: string,
    errorMessage: string | null,
    event: CodexTranscriptRawEvent,
  ) {
    await this.updateThreadFile(requestedEntry.threadId, (file) => {
      const entries = file.steerEntries ?? [];
      let changed = false;
      const nextEntries = entries.map((entry) => {
        if (entry.entryKey !== requestedEntry.entryKey || entry.requestId !== requestedEntry.requestId) {
          return entry;
        }

        if (entry.status === "sent" || (entry.status === "interrupted" && errorMessage)) {
          return entry;
        }

        if (errorMessage) {
          changed = true;
          return updateSteerEntryStatus(entry, "failed", event.receivedAt, { error: errorMessage });
        }

        if (entry.status === "pending" && acknowledgedTurnId && entry.turnId !== acknowledgedTurnId) {
          changed = true;
          return { ...entry, turnId: acknowledgedTurnId };
        }

        return entry;
      });
      return changed
        ? { ...file, lastTouchedAt: now(), steerEntries: sortSteerEntries(nextEntries) }
        : file;
    });
    await this.appendTurnEvent(requestedEntry.threadId, requestedEntry.turnId, event);
    await this.touchThread(requestedEntry.threadId, null);
  }

  async recordBrowseResultEntry(entry: WorkbenchBrowseResultEntry) {
    await this.ready();
    await this.updateTurnFile(entry.threadId, entry.turnId, (file) => ({
      ...file,
      browseResultEntries: sortBrowseResultEntries([
        ...(file.browseResultEntries ?? []).filter((existingEntry) => existingEntry.entryKey !== entry.entryKey),
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

  async recordSteerSettlements(entries: readonly WorkbenchSteerHistoryEntry[]) {
    await this.ready();
    for (const entry of entries) {
      const event = createRawEvent("workbench", entry, "steer/settled", entry.requestId);
      if (!entry.clientUserMessageId) {
        await this.recordSteerHistoryEntry(entry, event);
        continue;
      }
      await this.updateThreadFile(entry.threadId, (file) => {
        const existing = (file.steerEntries ?? []).find((candidate) => candidate.entryKey === entry.entryKey);
        const dispatchSequence = entry.dispatchSequence
          ?? existing?.dispatchSequence
          ?? getNextSteerDispatchSequence(file);
        const nextEntry = { ...entry, dispatchSequence };
        return {
          ...file,
          lastTouchedAt: now(),
          nextSteerDispatchSequence: Math.max(
            file.nextSteerDispatchSequence ?? 0,
            dispatchSequence + 1,
          ),
          steerEntries: sortSteerEntries([
            ...(file.steerEntries ?? []).filter((candidate) => candidate.entryKey !== entry.entryKey),
            nextEntry,
          ]),
        };
      });
      await this.appendTurnEvent(entry.threadId, entry.turnId, event);
      await this.touchThread(entry.threadId, null);
    }
  }

  async readThreadContextEntries(
    threadId: string,
    options: { turnIds?: Iterable<string> } = {},
  ): Promise<Pick<WorkbenchThreadContextReadResponse, "browseResultEntries" | "questionnaireEntries" | "steerEntries">> {
    await this.ready();
    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    const scopedTurnIds = options.turnIds ? new Set(options.turnIds) : null;
    const turnFiles = await this.readTurnFiles(threadId, scopedTurnIds ? { turnIds: scopedTurnIds } : {});
    const entriesByKey = new Map<string, WorkbenchSteerHistoryEntry>();
    for (const entry of threadFile?.steerEntries ?? []) {
      if (scopedTurnIds && !scopedTurnIds.has(entry.turnId)) {
        continue;
      }
      entriesByKey.set(`native:${entry.entryKey}`, entry);
    }
    for (const entry of turnFiles.flatMap((file) => file.steerEntries ?? [])) {
      const key = entry.clientUserMessageId
        ? `native:${entry.entryKey}`
        : `legacy:${entry.turnId}:${entry.entryKey}`;
      if (!entriesByKey.has(key)) {
        entriesByKey.set(key, entry);
      }
    }
    return {
      browseResultEntries: sortBrowseResultEntries(turnFiles.flatMap((file) => file.browseResultEntries ?? [])),
      questionnaireEntries: sortQuestionnaireEntries(turnFiles.flatMap((file) => file.questionnaireEntries)),
      steerEntries: sortSteerEntries([...entriesByKey.values()]),
    };
  }

  async listSteerHistory(threadId: string) {
    return (await this.readThreadContextEntries(threadId)).steerEntries;
  }

  async listQuestionnaireHistory(threadId: string) {
    return (await this.readThreadContextEntries(threadId)).questionnaireEntries;
  }

  async listBrowseResultEntries(threadId: string) {
    return (await this.readThreadContextEntries(threadId)).browseResultEntries;
  }

  async readStoredTurnSnapshot(threadId: string, turnId: string) {
    await this.ready();
    const file = await this.readTurnFile(threadId, turnId, { repair: false });
    return file?.turn
      ? {
        itemTimeline: normalizeWorkbenchThreadItemTimeline(file.itemTimeline),
        turn: file.turn,
      }
      : null;
  }

  async readStoredThreadSnapshot(threadId: string) {
    await this.ready();
    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    if (!threadFile?.thread) return null;
    return await this.hydrateSelectedThread(threadFile.thread, null, { repair: false, threadFile });
  }

  async readStoredThreadWindow(threadId: string, turnIds: readonly string[]) {
    await this.ready();
    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    if (!threadFile?.thread) return null;
    return await this.hydrateSelectedThread(threadFile.thread, { mode: "exact", turnIds }, {
      repair: false,
      threadFile,
    });
  }

  async readStoredTurnUsageEvents(threadId: string) {
    await this.ready();
    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    if (!threadFile?.thread) return null;
    const events: CodexTranscriptRawEvent[] = [];
    for (const { turnId } of threadFile.turnIndex) {
      const journal = await this.json.readJsonLines<CodexTranscriptRawEvent>(this.turnJournalPath(threadId, turnId));
      let event: CodexTranscriptRawEvent | undefined;
      for (let index = journal.length - 1; index >= 0; index -= 1) {
        if (journal[index]?.method !== "thread/tokenUsage/updated") continue;
        event = journal[index];
        break;
      }
      if (event) events.push(event);
    }
    return events;
  }

  async readProviderPreviousCursor(threadId: string, beforeTurnId: string) {
    await this.ready();
    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    return threadFile?.turnIndex.find((entry) => entry.turnId === beforeTurnId)?.previousCursor;
  }

  async recordProviderTurnCatalog(
    thread: Thread,
    turns: Turn[],
    boundary?: { cursor: string | null; turnId: string },
  ) {
    await this.ready();
    await this.updateThreadFile(thread.id, (file) => {
      let turnIndex = mergeTurnIndexes(file.turnIndex, turns, thread);
      if (boundary) {
        turnIndex = turnIndex.map((entry) => entry.turnId === boundary.turnId
          ? { ...entry, previousCursor: boundary.cursor }
          : entry);
      }
      return {
        ...file,
        cliVersion: thread.cliVersion,
        lastTouchedAt: now(),
        sourceThreadIds: Array.from(new Set([...file.sourceThreadIds, thread.id])),
        thread: createCompactThreadSnapshot(thread),
        turnIndex,
      };
    });
  }

  async recordProviderTurnPage(thread: Thread, turn: Turn, previousCursor: string | null) {
    await this.ready();
    await this.recordThreadSnapshot({ ...thread, turns: [turn] });
    await this.updateThreadFile(thread.id, (file) => ({
      ...file,
      lastTouchedAt: now(),
      turnIndex: file.turnIndex.map((entry) => entry.turnId === turn.id
        ? { ...entry, previousCursor }
        : entry),
    }));
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
    hydration: WorkbenchThreadHydrationRequest | { mode: "exact"; turnIds: readonly string[] } | null,
    {
      repair,
      threadFile,
    }: {
      repair: boolean;
      threadFile?: CodexTranscriptThreadFile | null;
    },
  ) {
    let storedThreadFile = threadFile ?? await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(thread.id), null);
    if (storedThreadFile && hasCrossTurnItemOwners(storedThreadFile.turnIndex)) {
      const turnFiles = await this.readTurnFiles(thread.id, {
        repair,
        turnIds: storedThreadFile.turnIndex.map((entry) => entry.turnId),
      });
      const repairedTurnIndex = reconcileTurnIndexItemIds(storedThreadFile.turnIndex, turnFiles);
      if (repair) {
        await this.updateThreadFile(thread.id, (file) => {
          if (!hasCrossTurnItemOwners(file.turnIndex)) {
            return file;
          }
          return {
            ...file,
            lastTouchedAt: now(),
            turnIndex: reconcileTurnIndexItemIds(file.turnIndex, turnFiles),
          };
        });
        storedThreadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(thread.id), null);
      } else {
        storedThreadFile = { ...storedThreadFile, turnIndex: repairedTurnIndex };
      }
    }
    let turnIndex = mergeTurnIndexes(storedThreadFile?.turnIndex ?? [], thread.turns, thread);
    let indexedThread = keepIndexedTurns(thread, turnIndex);

    if (hydration?.mode === "legacyFull") {
      const storedTurnFiles = orderTurnFilesByThreadIndex(storedThreadFile ?? createThreadFile(thread.id), await this.readTurnFiles(thread.id, {
        repair,
        turnIds: turnIndex.map((entry) => entry.turnId),
      }))
        .filter((file) => file.turn !== null);
      turnIndex = reconcileTurnIndexItemIds(turnIndex, storedTurnFiles, thread.turns);
      if (repair && storedTurnFiles.length) {
        await this.repairLoadedTurnIndex(thread, storedTurnFiles);
      }
      indexedThread = keepIndexedTurns(thread, turnIndex);
      const indexedTurnIds = new Set(turnIndex.map((entry) => entry.turnId));
      const itemOwners = createFirstTurnItemOwners(turnIndex);
      const itemTimelineByTurnId = new Map(storedTurnFiles.map((file) => [file.turnId, file.itemTimeline]));
      const storedTurns = storedTurnFiles
        .filter((file) => indexedTurnIds.has(file.turnId))
        .map((file) => ({
          itemTimeline: file.itemTimeline,
          turn: keepTurnOwnedItems(file.turn!, itemOwners),
        }));
      const legacyThread = hydrateThreadWithStoredTurns(indexedThread, storedTurns);
      const compactedLegacyThread = compactCommandOutputPayload(legacyThread);
      return {
        ...compactedLegacyThread,
        workbenchTurnHistory: turnIndex.map((entry) => createTurnHistoryEntry(
          entry,
          new Set(compactedLegacyThread.turns.map((turn) => turn.id)),
          new Set(),
          itemTimelineByTurnId.get(entry.turnId),
        )),
      };
    }

    const requestedTurnIds = hydration?.mode === "exact"
      ? [...new Set(hydration.turnIds)]
      : [
        hydration?.mode === "previous"
          ? getPreviousTurnId(turnIndex, hydration.beforeTurnId)
          : getLatestTurnId(turnIndex, indexedThread.turns),
      ].filter((turnId): turnId is string => Boolean(turnId));
    const selectedTurnIds = new Set(requestedTurnIds);
    const selectedStoredTurnFiles = requestedTurnIds.length
      ? await this.readTurnFiles(thread.id, { repair, turnIds: selectedTurnIds })
      : [];
    turnIndex = reconcileTurnIndexItemIds(turnIndex, selectedStoredTurnFiles, thread.turns);
    if (repair && selectedStoredTurnFiles.length) {
      await this.repairLoadedTurnIndex(thread, selectedStoredTurnFiles);
    }
    indexedThread = keepIndexedTurns(thread, turnIndex);
    const indexedTurnIds = new Set(turnIndex.map((entry) => entry.turnId));
    const itemOwners = createFirstTurnItemOwners(turnIndex);
    const selectedUpstreamThread = {
      ...indexedThread,
      turns: indexedThread.turns.filter((turn) => selectedTurnIds.has(turn.id)),
    };
    const itemTimelineByTurnId = new Map(selectedStoredTurnFiles.map((file) => [file.turnId, file.itemTimeline]));
    const storedTurns = selectedStoredTurnFiles
      .filter((file) => file.turn !== null && indexedTurnIds.has(file.turnId))
      .map((file) => ({
        itemTimeline: file.itemTimeline,
        turn: keepTurnOwnedItems(file.turn!, itemOwners),
      }));
    const hydratedThread = compactCommandOutputPayload(hydrateThreadWithStoredTurns(selectedUpstreamThread, storedTurns));
    const loadedTurnIds = new Set(hydratedThread.turns.map((turn) => turn.id));
    const missingTurnIds = new Set<string>();
    for (const requestedTurnId of requestedTurnIds) {
      if (!loadedTurnIds.has(requestedTurnId)) missingTurnIds.add(requestedTurnId);
    }

    return {
      ...hydratedThread,
      workbenchTurnHistory: turnIndex.map((entry) => createTurnHistoryEntry(
        entry,
        loadedTurnIds,
        missingTurnIds,
        itemTimelineByTurnId.get(entry.turnId),
      )),
    };
  }

  private async repairLoadedTurnIndex(thread: Thread, turnFiles: CodexTranscriptTurnFile[]) {
    await this.updateThreadFile(thread.id, (file) => ({
      ...file,
      lastTouchedAt: now(),
      turnIndex: reconcileTurnIndexItemIds(
        mergeTurnIndexes(file.turnIndex, thread.turns, thread),
        turnFiles,
        thread.turns,
      ),
    }));
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
    originatingTurnId: string | null = null,
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

    const turnId = originatingTurnId ?? extractTurnId(payloadForRecord) ?? asString(originalParams?.turnId) ?? asString(originalParams?.expectedTurnId);
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
    const relevantTurns = thread.turns.filter(hasNativeSteerReconciliationEvidence);
    if (relevantTurns.length) {
      const resolvedAt = now();
      await this.updateThreadFile(thread.id, (file) => {
        const entries = file.steerEntries ?? [];
        const nextEntries = reconcileNativeSteerEntriesForTurns(entries, relevantTurns, resolvedAt);
        return nextEntries === entries
          ? file
          : { ...file, lastTouchedAt: now(), steerEntries: nextEntries };
      });
    }
    await Promise.all(thread.turns.map((turn) => this.recordThreadSnapshotTurn(thread.id, turn)));
  }

  private async recordThreadSnapshotTurn(threadId: string, turn: Turn) {
    turn = (await this.externalizeInlineImages(threadId, turn)).value;
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
    const runtimeCliVersion = event.source === "upstream-notification" && event.method === "turn/started"
      ? /^[^\s/]+\/([^\s/]+)(?:\s|$)/u.exec(this.getRuntimeUserAgent() ?? "")?.[1]
      : undefined;
    if (hasNativeSteerReconciliationEvidence(turn)) {
      await this.updateThreadFile(threadId, (file) => {
        const entries = file.steerEntries ?? [];
        const nextEntries = reconcileNativeSteerEntriesForTurns(entries, [turn], event.receivedAt);
        return nextEntries === entries
          ? file
          : { ...file, lastTouchedAt: now(), steerEntries: nextEntries };
      });
    }
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
        ...(runtimeCliVersion && !file.runtimeCliVersion ? { runtimeCliVersion } : {}),
        steerEntries: updatePendingSteerEntriesForInterruptedTurn(file.steerEntries ?? [], mergedTurn, event.receivedAt),
        turn: applyTurnTimeline(mergedTurn, {
          ...file,
          itemOrder: nextItemOrder,
          itemTimeline: nextItemTimeline,
        }),
      };
    });
    await this.appendTurnEvent(threadId, turn.id, event);
    if (isTurnLifecycleEvent(event)) {
      await this.updateThreadFile(threadId, (file) => ({
        ...file,
        lastTouchedAt: now(),
        turnIndex: mergeTurnIndexes(file.turnIndex, [turn], file.thread),
      }));
    }
    if (isTurnTerminalEvent(event)) {
      await this.compactTurnJournal(threadId, turn.id);
      return;
    }
    if (isTurnLifecycleEvent(event)) {
      return;
    }
    await this.touchThreadThrottled(threadId);
  }

  private async recordTurnItem(threadId: string, turnId: string, item: ThreadItem, event: CodexTranscriptRawEvent) {
    if (item.type === "userMessage" && item.clientId?.trim()) {
      await this.updateThreadFile(threadId, (file) => {
        const entries = file.steerEntries ?? [];
        const nextEntries = updateNativeSteerEntriesForUserMessage(entries, turnId, item, event.receivedAt);
        return nextEntries === entries
          ? file
          : { ...file, lastTouchedAt: now(), steerEntries: nextEntries };
      });
    }
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

  externalizeInlineImages<TValue>(threadId: string, value: TValue) {
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
