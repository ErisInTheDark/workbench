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
import type { WorkbenchQuestionnaireHistoryEntry } from "../lib/types";
import AtomicJsonStore from "./AtomicJsonStore";
import { hydrateThreadWithStoredTurns } from "./codex-transcript-hydration";
import { shouldRouteRawResponseToRequestJournal } from "./codex-transcript-event-routing";
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
  CodexTranscriptRequestFile,
  CodexTranscriptThreadFile,
  CodexTranscriptTurnFile,
} from "./codex-transcript-types";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { runCodexTranscriptMigrations } from "./codex-transcript-migrations";
import { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "./codex-transcript-version";

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function createRequestFile(threadId: string, requestKey: string, turnId: string | null): CodexTranscriptRequestFile {
  return {
    lastTouchedAt: now(),
    requestKey,
    schemaVersion: CODEX_TRANSCRIPT_SCHEMA_VERSION,
    threadId,
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

function normalizeUserInput(value: unknown) {
  return JSON.stringify(value);
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
    case "reasoning": {
      const text = [...item.summary, ...item.content].join("\n").trim();
      return text ? `reasoning:${text}` : null;
    }
    default:
      return null;
  }
}

function chooseRicherTurnItem(left: ThreadItem, right: ThreadItem) {
  return mergeThreadItem(left, right);
}

function normalizeMergedTurnItems(items: ThreadItem[]) {
  const dedupedItems: ThreadItem[] = [];
  const dedupedIndexesByKey = new Map<string, number>();
  let changed = false;

  for (const item of items) {
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
    dedupedItems[existingIndex] = chooseRicherTurnItem(dedupedItems[existingIndex]!, item);
  }

  return changed ? dedupedItems : items;
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

function orderTurnItems(items: ThreadItem[], itemOrder: string[]) {
  if (!itemOrder.length) {
    return normalizeMergedTurnItems(items);
  }

  const indexesById = new Map(itemOrder.map((itemId, index) => [itemId, index]));
  return normalizeMergedTurnItems(items
    .map((item, index) => ({
      index,
      item,
      order: indexesById.get(item.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => (left.order - right.order) || (left.index - right.index))
    .map(({ item }) => item));
}

function applyTurnTimeline(turn: Turn | null, file: Pick<CodexTranscriptTurnFile, "itemOrder" | "itemTimeline" | "turn">) {
  return turn ? { ...turn, items: orderMergedItemsByTimeline(turn.items, normalizeTurnTimeline({ ...file, turn })) } : turn;
}

function applyTurnItemOrder(turn: Turn | null, itemOrder: string[]) {
  return turn ? { ...turn, items: orderTurnItems(turn.items, itemOrder) } : turn;
}

function mergeTurnItems(currentTurn: Turn | null, incomingTurn: Turn) {
  if (!currentTurn) {
    return {
      ...incomingTurn,
      items: normalizeMergedTurnItems(incomingTurn.items),
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
    items: normalizeMergedTurnItems([...mergedCurrentItems, ...incomingOnlyItems]),
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
    items: normalizeMergedTurnItems(nextItems),
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

export default class CodexTranscriptStore {
  private readonly getProtectedThreadIds: () => Iterable<string>;
  private lastPrunedAt = 0;
  private readonly json = new AtomicJsonStore();
  private readonly pruneTimer: NodeJS.Timeout;
  private readonly readyPromise: Promise<void>;
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
    await this.recordRawTraffic("upstream-notification", notification);

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
          await this.updateAgentMessageDelta(threadId, turnId, itemId, delta);
        }
        return;
      case "item/plan/delta":
        if (delta !== null) {
          await this.updatePlanDelta(threadId, turnId, itemId, delta);
        }
        return;
      case "item/commandExecution/outputDelta":
        if (delta !== null) {
          await this.updateCommandOutputDelta(threadId, turnId, itemId, delta);
        }
        return;
      case "item/fileChange/patchUpdated":
        await this.updateFileChangePatch(threadId, turnId, itemId, notification);
        return;
      case "item/reasoning/summaryPartAdded":
        await this.updateReasoningSummaryPart(threadId, turnId, itemId, notification);
        return;
      case "item/reasoning/summaryTextDelta":
        if (delta !== null) {
          await this.updateReasoningSummaryDelta(threadId, turnId, itemId, notification, delta);
        }
        return;
      case "item/reasoning/textDelta":
        if (delta !== null) {
          await this.updateReasoningTextDelta(threadId, turnId, itemId, notification, delta);
        }
        return;
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

  async hydrateThreadResponse(originalRequest: JsonRpcRequest, response: JsonRpcResponse) {
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

    const storedTurns = (await this.readTurnFiles(thread.id))
      .filter((file) => file.turn !== null)
      .map((file) => ({
        itemTimeline: file.itemTimeline,
        turn: file.turn!,
      }));
    const hydratedThread = hydrateThreadWithStoredTurns(thread, storedTurns);
    await this.touchThread(thread.id, hydratedThread);
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

    const storedTurns = (await this.readTurnFiles(threadId))
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
    const event = createRawEvent(source, payload, method, typeof requestId === "number" || typeof requestId === "string" ? requestId : null);
    const thread = extractThread(payload);
    if (thread) {
      await this.recordThreadSnapshot(thread);
      if (shouldRouteRawResponseToRequestJournal(method)) {
        const requestKey = typeof requestId === "number" || typeof requestId === "string" ? String(requestId) : null;
        if (requestKey) {
          await this.updateRequestFile(thread.id, requestKey, null, (file) => ({
            ...file,
            lastTouchedAt: now(),
          }));
          await this.appendRequestEvent(thread.id, requestKey, event);
        }
      }
      return;
    }

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
      await this.updateRequestFile(threadId, requestKey, null, (file) => ({
        ...file,
        lastTouchedAt: now(),
      }));
      await this.appendRequestEvent(threadId, requestKey, event);
      await this.touchThread(threadId, null);
      return;
    }

    await this.updateOrphanEventsFile(threadId, (file) => ({
      ...file,
      lastTouchedAt: now(),
    }));
    await this.appendOrphanEvent(threadId, event);
    await this.touchThread(threadId, null);
  }

  private async recordThreadSnapshot(thread: Thread) {
    await this.touchThread(thread.id, thread);
    await Promise.all(thread.turns.map((turn) => this.recordThreadSnapshotTurn(thread.id, turn)));
  }

  private async recordThreadSnapshotTurn(threadId: string, turn: Turn) {
    const itemOrder = turn.items.map((item) => item.id);
    await this.updateTurnFile(threadId, turn.id, (file) => {
      const nextItemOrder = mergeItemOrder(itemOrder, file.itemOrder ?? []);
      return {
        ...file,
        itemOrder: nextItemOrder,
        itemTimeline: turn.items.reduce(
          (timeline, item) => rememberTimelineItem({ ...file, itemTimeline: timeline }, item.id, classifyTimelineEvent(null, item)),
          normalizeTurnTimeline(file),
        ),
        lastTouchedAt: now(),
        turn: applyTurnTimeline(mergeTurnItems(file.turn, turn), {
          ...file,
          itemOrder: nextItemOrder,
          itemTimeline: turn.items.reduce(
            (timeline, item) => rememberTimelineItem({ ...file, itemTimeline: timeline }, item.id, classifyTimelineEvent(null, item)),
            normalizeTurnTimeline(file),
          ),
        }),
      };
    });
  }

  private async recordTurnSnapshot(threadId: string, turn: Turn, event: CodexTranscriptRawEvent) {
    await this.updateTurnFile(threadId, turn.id, (file) => ({
      ...file,
      itemOrder: mergeItemOrder(turn.items.map((item) => item.id), file.itemOrder ?? []),
      itemTimeline: turn.items.reduce(
        (timeline, item) => rememberTimelineItem({ ...file, itemTimeline: timeline }, item.id, classifyTimelineEvent(event.method, item)),
        normalizeTurnTimeline(file),
      ),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(mergeTurnItems(file.turn, turn), mergeItemOrder(turn.items.map((item) => item.id), file.itemOrder ?? [])),
    }));
    await this.appendTurnEvent(threadId, turn.id, event);
    if (isTurnTerminalEvent(event)) {
      await this.compactTurnJournal(threadId, turn.id);
    }
    await this.touchThread(threadId, null);
  }

  private async recordTurnItem(threadId: string, turnId: string, item: ThreadItem, event: CodexTranscriptRawEvent) {
    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [item.id]),
      itemTimeline: rememberTurnTimelineItem(file, item.id, item, event.method),
      lastTouchedAt: now(),
      turn: applyTurnTimeline(upsertItem(file.turn, item, turnId), {
        ...file,
        itemOrder: rememberTurnItemIds(file, [item.id]),
        itemTimeline: rememberTurnTimelineItem(file, item.id, item, event.method),
      }),
    }));
    await this.appendTurnEvent(threadId, turnId, event);
    await this.touchThread(threadId, null);
  }

  private async updateCommandOutputDelta(threadId: string, turnId: string, itemId: string, delta: string) {
    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateCommandOutput(file.turn, itemId, delta), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
  }

  private async updateAgentMessageDelta(threadId: string, turnId: string, itemId: string, delta: string) {
    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingAgentMessageItem(itemId), (item) => (
        item.type === "agentMessage" ? { ...item, text: `${item.text}${delta}` } : null
      )), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
  }

  private async updatePlanDelta(threadId: string, turnId: string, itemId: string, delta: string) {
    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingPlanItem(itemId), (item) => (
        item.type === "plan" ? { ...item, text: `${item.text}${delta}` } : null
      )), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
  }

  private async updateReasoningSummaryPart(threadId: string, turnId: string, itemId: string, notification: JsonRpcNotification) {
    const summaryIndex = extractNumberParam(notification, "summaryIndex");
    if (summaryIndex === null) {
      return;
    }

    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingReasoningItem(itemId), (item) => (
        item.type === "reasoning" ? { ...item, summary: ensureIndexedText(item.summary, summaryIndex) } : null
      )), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
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

    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingReasoningItem(itemId), (item) => (
        item.type === "reasoning"
          ? { ...item, summary: appendIndexedText(item.summary, summaryIndex, delta) }
          : null
      )), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
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

    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateOrCreateItem(file.turn, turnId, itemId, () => createStreamingReasoningItem(itemId), (item) => (
        item.type === "reasoning"
          ? { ...item, content: appendIndexedText(item.content, contentIndex, delta) }
          : null
      )), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
  }

  private async updateFileChangePatch(threadId: string, turnId: string, itemId: string, notification: JsonRpcNotification) {
    const changes = asRecord(notification.params)?.changes;
    if (!Array.isArray(changes)) {
      return;
    }

    await this.updateTurnFile(threadId, turnId, (file) => ({
      ...file,
      itemOrder: rememberTurnItemIds(file, [itemId]),
      lastTouchedAt: now(),
      turn: applyTurnItemOrder(updateExistingItem(file.turn, itemId, (item) => (
        item.type === "fileChange"
          ? { ...item, changes: changes as Extract<ThreadItem, { type: "fileChange" }>["changes"] }
          : null
      )), rememberTurnItemIds(file, [itemId])),
    }));
    await this.touchThread(threadId, null);
  }

  private async touchThread(threadId: string, thread: Thread | null) {
    await this.updateThreadFile(threadId, (file) => {
      const nextThread = thread ?? file.thread;
      const turnIndex = nextThread
        ? nextThread.turns.map((turn) => ({
          completedAt: turn.completedAt,
          itemCount: turn.items.length,
          startedAt: turn.startedAt,
          status: turn.status,
          turnId: turn.id,
          updatedAt: getThreadTimestamp(nextThread),
        }))
        : file.turnIndex;
      return {
        ...file,
        cliVersion: nextThread?.cliVersion ?? file.cliVersion,
        lastTouchedAt: now(),
        sourceThreadIds: Array.from(new Set([...file.sourceThreadIds, threadId])),
        thread: nextThread,
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

  private requestFilePath(threadId: string, requestKey: string) {
    return path.join(this.threadDirectoryPath(threadId), "requests", `${encodeTranscriptPathSegment(requestKey)}.json`);
  }

  private orphanEventsFilePath(threadId: string) {
    return path.join(this.threadDirectoryPath(threadId), "orphan-events.json");
  }

  private turnJournalPath(threadId: string, turnId: string) {
    return path.join(this.threadDirectoryPath(threadId), "turns", `${encodeTranscriptPathSegment(turnId)}.ndjson`);
  }

  private requestJournalPath(threadId: string, requestKey: string) {
    return path.join(this.threadDirectoryPath(threadId), "requests", `${encodeTranscriptPathSegment(requestKey)}.ndjson`);
  }

  private orphanEventsJournalPath(threadId: string) {
    return path.join(this.threadDirectoryPath(threadId), "orphan-events.ndjson");
  }

  private updateThreadFile(threadId: string, updater: (file: CodexTranscriptThreadFile) => CodexTranscriptThreadFile) {
    return this.json.update(this.threadFilePath(threadId), createThreadFile(threadId), updater);
  }

  private updateTurnFile(threadId: string, turnId: string, updater: (file: CodexTranscriptTurnFile) => CodexTranscriptTurnFile) {
    return this.json.update(this.turnFilePath(threadId, turnId), createTurnFile(threadId, turnId), updater);
  }

  private updateRequestFile(
    threadId: string,
    requestKey: string,
    turnId: string | null,
    updater: (file: CodexTranscriptRequestFile) => CodexTranscriptRequestFile,
  ) {
    return this.json.update(this.requestFilePath(threadId, requestKey), createRequestFile(threadId, requestKey, turnId), updater);
  }

  private updateOrphanEventsFile(threadId: string, updater: (file: CodexTranscriptOrphanEventsFile) => CodexTranscriptOrphanEventsFile) {
    return this.json.update(this.orphanEventsFilePath(threadId), createOrphanEventsFile(threadId), updater);
  }

  private appendTurnEvent(threadId: string, turnId: string, event: CodexTranscriptRawEvent) {
    return this.json.appendLine(this.turnJournalPath(threadId, turnId), event);
  }

  private appendRequestEvent(threadId: string, requestKey: string, event: CodexTranscriptRawEvent) {
    return this.json.appendLine(this.requestJournalPath(threadId, requestKey), event);
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

  private async readTurnFiles(threadId: string) {
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

    const files = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => this.json.read<CodexTranscriptTurnFile | null>(path.join(turnsDirectoryPath, entry), null)));
    return files
      .filter((file): file is CodexTranscriptTurnFile => file !== null && file.schemaVersion === CODEX_TRANSCRIPT_SCHEMA_VERSION)
      .map((file) => {
        const normalizedFile = {
          ...file,
          itemOrder: file.itemOrder ?? [],
          itemTimeline: normalizeTurnTimeline(file),
        };
        return {
          ...normalizedFile,
          turn: applyTurnTimeline(file.turn, normalizedFile),
        };
      });
  }
}
