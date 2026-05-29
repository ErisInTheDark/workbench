/*
 * Exports:
 * - CodexTranscriptStore: persist and hydrate Codex extended transcript data under .workbench/transcripts. Keywords: codex, transcript, questionnaire, pruning.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { JsonValue } from "../lib/codex/generated/app-server/serde_json/JsonValue";
import { normalizeThreadItems } from "../lib/codex/thread-item-normalization";
import type { WorkbenchQuestionnaireHistoryEntry } from "../lib/types";
import AtomicJsonStore from "./AtomicJsonStore";
import { hydrateThreadWithStoredTurns } from "./codex-transcript-hydration";
import { shouldPersistRawNotificationToJournal } from "./codex-transcript-event-routing";
import { mergeThreadItem } from "./codex-transcript-item-merge";
import {
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
  classifyTimelineEvent,
  createDynamicToolCallItem,
  extractTimelineItemKey,
  normalizeTurnTimeline,
  orderMergedItemsByTimeline,
  rememberTimelineItem,
} from "./codex-transcript-timeline";
import type {
  CodexTranscriptOrphanEventsFile,
  CodexTranscriptRawEvent,
  CodexTranscriptThreadFile,
  CodexTranscriptTurnFile,
} from "./codex-transcript-types";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { runCodexTranscriptMigrations } from "./codex-transcript-migrations";
import { queueCodexTranscriptRequestSidecarCleanup } from "./codex-transcript-migrations/v3";
import { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "./codex-transcript-version";

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const THREAD_TOUCH_THROTTLE_MS = 30_000;
const SUPPORTED_CODEX_TRANSCRIPT_SCHEMA_VERSIONS = new Set([1, 2, 3, CODEX_TRANSCRIPT_SCHEMA_VERSION]);

interface HydrateThreadResponseOptions {
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

function createTurnFile(threadId: string, turnId: string): CodexTranscriptTurnFile {
  return {
    itemOrder: [],
    itemTimeline: [],
    lastTouchedAt: now(),
    questionnaireEntries: [],
    schemaVersion: CODEX_TRANSCRIPT_SCHEMA_VERSION,
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

function rememberTurnTimelineItem(file: CodexTranscriptTurnFile, itemId: string, item: ThreadItem | null, method: string | null) {
  return rememberTimelineItem(file, itemId, classifyTimelineEvent(method, item));
}

function getTurnOrderingUpdate(file: CodexTranscriptTurnFile, itemId: string, item: ThreadItem | null, method: string | null) {
  const itemOrder = rememberTurnItemIds(file, [itemId]);
  const itemTimeline = rememberTurnTimelineItem({ ...file, itemOrder }, itemId, item, method);
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
      anchorItemId,
      itemId: entry.itemId,
      sequence: cleanedTimeline.length + 1,
    });
  }

  return cleanedTimeline;
}

function normalizeTurnFileSnapshot(file: CodexTranscriptTurnFile) {
  if (!file.turn) {
    return {
      ...file,
      itemOrder: file.itemOrder ?? [],
      itemTimeline: normalizeTurnTimeline(file),
    };
  }

  const normalizedTurn = applyTurnTimeline(file.turn, file);
  if (!normalizedTurn) {
    return file;
  }

  const survivingItemIds = new Set(normalizedTurn.items.map((item) => item.id));
  const normalizedTimeline = normalizeTurnTimeline({
    ...file,
    turn: normalizedTurn,
  });

  return {
    ...file,
    itemOrder: normalizedTurn.items.map((item) => item.id),
    itemTimeline: cleanTurnTimeline(normalizedTimeline, survivingItemIds),
    turn: {
      ...normalizedTurn,
      items: orderMergedItemsByTimeline(normalizedTurn.items, cleanTurnTimeline(normalizedTimeline, survivingItemIds)),
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
      aggregatedOutput: `${item.aggregatedOutput ?? ""}${delta}`,
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
      .then(() => queueCodexTranscriptRequestSidecarCleanup(path.dirname(this.threadsDirectoryPath)))
      .catch(() => undefined);
  }

  async dispose() {
    clearInterval(this.pruneTimer);
    await this.readyPromise;
    await this.json.waitForIdle();
  }

  async recordClientRequest(request: JsonRpcRequest) {
    await this.ready();
    return this.recordRawTraffic("client-request", request, null, request);
  }

  async recordUpstreamResponse(originalRequest: JsonRpcRequest | null, response: JsonRpcResponse) {
    await this.ready();
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

  async listQuestionnaireHistory(threadId: string) {
    await this.ready();
    const turnFiles = await this.readTurnFiles(threadId);
    return sortQuestionnaireEntries(turnFiles.flatMap((file) => file.questionnaireEntries));
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
        ? await this.hydrateStoredThreadReadResponse(asString(originalParams?.threadId), response)
        : response;
    }

    const result = asRecord(response.result);
    const thread = asRecord(result?.thread) as Thread | null;
    if (!thread?.id) {
      return response;
    }

    const upstreamTurnIds = new Set(thread.turns.map((turn) => turn.id));
    const storedTurns = (await this.readTurnFiles(thread.id, {
      repair: options.touchThread !== false,
      turnIds: upstreamTurnIds,
    }))
      .filter((file) => file.turn !== null)
      .map((file) => ({
        itemTimeline: file.itemTimeline,
        turn: file.turn!,
      }));
    const hydratedThread = hydrateThreadWithStoredTurns(thread, storedTurns);
    if (options.touchThread !== false) {
      await this.touchThread(thread.id, hydratedThread);
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

  private async hydrateStoredThreadReadResponse(threadId: string | null, response: JsonRpcResponse) {
    if (!threadId) {
      return response;
    }

    const threadFile = await this.json.read<CodexTranscriptThreadFile | null>(this.threadFilePath(threadId), null);
    const storedThread = threadFile?.thread ?? null;
    if (!storedThread) {
      return response;
    }

    const storedTurns = orderTurnFilesByThreadIndex(threadFile, await this.readTurnFiles(threadId, { repair: true }))
      .filter((file) => file.turn !== null)
      .map((file) => ({
        itemTimeline: file.itemTimeline,
        turn: file.turn!,
      }));
    return {
      id: response.id,
      result: {
        thread: hydrateThreadWithStoredTurns(storedThread, storedTurns),
      },
    } satisfies JsonRpcResponse;
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
    const method = asString(asRecord(payload)?.method) ?? fallbackMethod;
    const requestId = asRecord(payload)?.id;
    const normalizedRequestId = typeof requestId === "number" || typeof requestId === "string" ? requestId : null;
    const thread = extractThread(payload);
    if (thread) {
      await this.recordThreadSnapshot(thread);
      return;
    }

    const event = createRawEvent(source, payload, method, normalizedRequestId);
    const originalParams = asRecord(originalRequest?.params);
    const threadId = extractThreadId(payload) ?? asString(originalParams?.threadId);
    if (!threadId) {
      return;
    }

    const turn = extractTurn(payload);
    if (turn) {
      await this.recordTurnSnapshot(threadId, turn, event);
      return;
    }

    const turnId = extractTurnId(payload) ?? asString(originalParams?.turnId);
    const item = extractItem(payload);
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
    const itemOrder = turn.items.map((item) => item.id);
    await this.updateTurnFile(threadId, turn.id, (file) => {
      const nextItemOrder = mergeItemOrder(itemOrder, file.itemOrder ?? []);
      const nextItemTimeline = turn.items.reduce(
        (timeline, item) => rememberTimelineItem({ ...file, itemOrder: nextItemOrder, itemTimeline: timeline }, item.id, classifyTimelineEvent(null, item)),
        normalizeTurnTimeline(file),
      );
      return {
        ...file,
        itemOrder: nextItemOrder,
        itemTimeline: nextItemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(mergeTurnItems(file.turn, turn), {
          ...file,
          itemOrder: nextItemOrder,
          itemTimeline: nextItemTimeline,
        }),
      };
    });
  }

  private async recordTurnSnapshot(threadId: string, turn: Turn, event: CodexTranscriptRawEvent) {
    await this.updateTurnFile(threadId, turn.id, (file) => {
      const nextItemOrder = mergeItemOrder(turn.items.map((item) => item.id), file.itemOrder ?? []);
      const nextItemTimeline = turn.items.reduce(
        (timeline, item) => rememberTimelineItem({ ...file, itemOrder: nextItemOrder, itemTimeline: timeline }, item.id, classifyTimelineEvent(event.method, item)),
        normalizeTurnTimeline(file),
      );
      return {
        ...file,
        itemOrder: nextItemOrder,
        itemTimeline: nextItemTimeline,
        lastTouchedAt: now(),
        turn: applyTurnTimeline(mergeTurnItems(file.turn, turn), {
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
      const { itemOrder, itemTimeline } = getTurnOrderingUpdate(file, item.id, item, event.method);
      return {
        ...file,
        itemOrder,
        itemTimeline,
        lastTouchedAt: now(),
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
        ? thread.turns.map((turn) => ({
          completedAt: turn.completedAt,
          itemCount: turn.items.length,
          startedAt: turn.startedAt,
          status: turn.status,
          turnId: turn.id,
          updatedAt: getThreadTimestamp(thread),
        }))
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

  private updateTurnFile(threadId: string, turnId: string, updater: (file: CodexTranscriptTurnFile) => CodexTranscriptTurnFile) {
    return this.json.updateIfChanged(this.turnFilePath(threadId, turnId), createTurnFile(threadId, turnId), async (file) => (
      preserveCurrentIfOnlyLastTouchedAtChanged(file, normalizeTurnFileSnapshot(await updater(file)))
    ));
  }

  private updateOrphanEventsFile(threadId: string, updater: (file: CodexTranscriptOrphanEventsFile) => CodexTranscriptOrphanEventsFile) {
    return this.json.updateIfChanged(this.orphanEventsFilePath(threadId), createOrphanEventsFile(threadId), async (file) => (
      preserveCurrentIfOnlyLastTouchedAtChanged(file, await updater(file))
    ));
  }

  private appendTurnEvent(threadId: string, turnId: string, event: CodexTranscriptRawEvent) {
    return this.json.appendLine(this.turnJournalPath(threadId, turnId), event);
  }

  private appendOrphanEvent(threadId: string, event: CodexTranscriptRawEvent) {
    return this.json.appendLine(this.orphanEventsJournalPath(threadId), event);
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
        if (options.repair && stableJsonStringify(file) !== stableJsonStringify(normalizedFile)) {
          await this.json.updateIfChanged(filePath, normalizedFile, () => normalizedFile);
        }
        return normalizedFile;
      }));
  }
}
