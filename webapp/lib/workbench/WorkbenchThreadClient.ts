/*
 * Exports:
 * - WorkbenchThreadState: owned thread, rate-limit, and model cache state for the workbench. Keywords: workbench, thread, state, codex.
 * - WorkbenchThreadSnapshot: readonly projection of the current thread client state. Keywords: workbench, thread, snapshot, rate limits.
 * - WorkbenchThreadListener: subscriber signature for thread client state changes. Keywords: workbench, thread, subscribe.
 * - WorkbenchThreadClientOptions: creation options for the thread client manager hooks. Keywords: workbench, thread, status, callbacks.
 * - WorkbenchThreadClient: public surface for thread transport, draft threads, and notification handling. Keywords: workbench, thread, client, dispose.
 * - createWorkbenchThreadClient: create the thread sub-client that owns Codex or Copilot thread state and notifications. Keywords: workbench, thread, codex, copilot.
 */

import { CodexAppServerClient } from "../codex/app-server-client";
import type { CodexAppServerNotification, CodexAppServerNotificationHandling } from "../codex/app-server-notifications";
import type { GetAccountRateLimitsResponse } from "../codex/generated/app-server/v2/GetAccountRateLimitsResponse";
import type { Model as CodexModel } from "../codex/generated/app-server/v2/Model";
import type { ModelListResponse } from "../codex/generated/app-server/v2/ModelListResponse";
import type { RateLimitSnapshot } from "../codex/generated/app-server/v2/RateLimitSnapshot";
import type { ThreadItem } from "../codex/generated/app-server/v2/ThreadItem";
import type { ThreadListResponse } from "../codex/generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "../codex/generated/app-server/v2/ThreadReadResponse";
import type { Turn } from "../codex/generated/app-server/v2/Turn";
import type { TurnStartResponse } from "../codex/generated/app-server/v2/TurnStartResponse";
import type { TurnSteerResponse } from "../codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "../codex/generated/app-server/v2/UserInput";
import type { CodexClientRequest } from "../codex/protocol";
import { createTextInput, createThreadStartRequest, isCodexJsonRpcFailure } from "../codex/protocol";
import { formatThreadStatus, isProjectCodexThread, toThreadPayload, toThreadSummary } from "../codex/thread-adapter";
import { getCurrentInProgressTurn, getCurrentTurn } from "../codex/thread-state";
import type { ThreadPayload, ThreadSummary, WorkbenchHarness, WorkbenchModelOption } from "../types";
import { LifecycleScope } from "./state/LifecycleScope";
import {
    persistHarnessAgent,
    persistHarnessModel,
    persistHarnessModelEffort,
    readStoredHarnessAgent,
    readStoredHarnessModel,
    readStoredHarnessModelEffort,
} from "./state/browser-state";

const THREAD_REFRESH_TASK_ID = "thread-refresh";
const THREAD_LIST_REFRESH_TASK_ID = "thread-list-refresh";
const CODEX_NOTIFICATION_THREAD_REFRESH_DELAY_MS = 350;
const CODEX_NOTIFICATION_THREAD_LIST_REFRESH_DELAY_MS = 750;
const DEFAULT_TURN_REASONING_SUMMARY = "detailed" as const;
const DRAFT_THREAD_ID_PREFIX = "draft:";

export interface WorkbenchThreadState {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  modelsByHarness: Map<WorkbenchHarness, WorkbenchModelOption[]>;
  projectRoot: string;
  projectRootPath: string;
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByHarness: Map<WorkbenchHarness, RateLimitSnapshot | null>;
  threads: ThreadSummary[];
  threadsError: string;
}

export interface WorkbenchThreadSnapshot {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  rateLimits: RateLimitSnapshot | null;
  threads: ThreadSummary[];
  threadsError: string;
}

export type WorkbenchThreadListener = (snapshot: WorkbenchThreadSnapshot) => void;

export interface WorkbenchThreadClientOptions {
  onStatusMessage?: (message: string) => void;
}

export interface WorkbenchThreadClient {
  clearThreadSelection: () => void;
  createThread: (harness: WorkbenchHarness, threadId?: string) => ThreadPayload;
  dispose: () => void;
  getSnapshot: () => WorkbenchThreadSnapshot;
  hasThread: (threadId: string) => boolean;
  isCurrentThreadUpToDate: (threadId: string) => boolean;
  isDraftThreadId: (threadId: string) => boolean;
  listModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  openThread: (threadId: string, options?: { harness?: WorkbenchHarness; source?: "open" | "reload" }) => Promise<void>;
  reconcileCurrentThreadFromRead: (threadId: string, harness: WorkbenchHarness) => Promise<void>;
  readCurrentThread: (threadId: string, harness: WorkbenchHarness) => Promise<ThreadPayload | null>;
  refreshRateLimits: () => Promise<void>;
  refreshThreads: () => Promise<void>;
  sendThreadMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
  setProjectContext: (context: { root: string; rootPath: string }) => void;
  subscribe: (listener: WorkbenchThreadListener) => () => void;
}

function createInitialThreadState(): WorkbenchThreadState {
  return {
    currentThread: null,
    currentThreadId: "",
    modelsByHarness: new Map(),
    projectRoot: "Project",
    projectRootPath: "",
    rateLimits: null,
    rateLimitsByHarness: new Map(),
    threads: [],
    threadsError: "",
  };
}

export function WorkbenchThreadClient(
  options: WorkbenchThreadClientOptions = {},
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchThreadClient {
  const codexClient = new CodexAppServerClient();
  const listeners = new Set<WorkbenchThreadListener>();
  const state = createInitialThreadState();
  let disposed = false;
  let refreshThreadsPromise: Promise<void> | null = null;

  function emitStatusMessage(message: string) {
    options.onStatusMessage?.(message);
  }

  function getSnapshot(): WorkbenchThreadSnapshot {
    return {
      currentThread: state.currentThread,
      currentThreadId: state.currentThreadId,
      rateLimits: state.rateLimits,
      threads: state.threads,
      threadsError: state.threadsError,
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function subscribe(listener: WorkbenchThreadListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function setProjectContext(context: { root: string; rootPath: string }) {
    if (state.projectRoot === context.root && state.projectRootPath === context.rootPath) {
      return;
    }

    state.projectRoot = context.root;
    state.projectRootPath = context.rootPath;
  }

  function areCurrentTurnsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
    const leftTurn = getCurrentTurn(left);
    const rightTurn = getCurrentTurn(right);

    if (leftTurn === rightTurn) {
      return true;
    }

    if (!leftTurn || !rightTurn) {
      return false;
    }

    return JSON.stringify(leftTurn) === JSON.stringify(rightTurn);
  }

  function areThreadPayloadsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    return left.id === right.id
      && left.harness === right.harness
      && left.model === right.model
      && left.reasoningEffort === right.reasoningEffort
      && left.agentPath === right.agentPath
      && left.isDraft === right.isDraft
      && left.name === right.name
      && left.preview === right.preview
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.status === right.status
      && left.cwd === right.cwd
      && left.source === right.source
      && left.path === right.path
      && left.turns.length === right.turns.length
      && areCurrentTurnsEquivalent(left, right);
  }

  function setRateLimits(rateLimits: RateLimitSnapshot | null) {
    if (state.rateLimits === rateLimits) {
      return;
    }

    state.rateLimits = rateLimits;
    emit();
  }

  function setCurrentThread(thread: ThreadPayload | null) {
    if (areThreadPayloadsEquivalent(state.currentThread, thread)) {
      return;
    }

    const previousThread = state.currentThread;
    state.currentThread = thread;
    state.currentThreadId = thread?.id ?? "";
    emit();

    if (!thread) {
      setRateLimits(null);
      return;
    }

    if (!previousThread || previousThread.id !== thread.id || previousThread.harness !== thread.harness) {
      setRateLimits(state.rateLimitsByHarness.get(thread.harness) ?? null);
      void refreshRateLimits();
    }
  }

  function updateCurrentThread(updater: (thread: ThreadPayload) => ThreadPayload | null) {
    if (!state.currentThread) {
      return false;
    }

    const nextThread = updater(state.currentThread);
    if (!nextThread) {
      return false;
    }

    setCurrentThread(nextThread);
    return true;
  }

  function updateCurrentThreadFields(fields: Partial<Omit<ThreadPayload, "turns">>) {
    return updateCurrentThread((thread) => ({
      ...thread,
      ...fields,
    }));
  }

  async function sendBridgeRequest<TResponse>(
    harness: WorkbenchHarness,
    request: Omit<CodexClientRequest, "id"> & { id?: number },
  ) {
    await codexClient.connect();
    const response = await codexClient.sendRequest<TResponse>({
      ...request,
      workbenchHarness: harness,
    });
    if (isCodexJsonRpcFailure(response)) {
      const detail = response.error.data ? ` ${JSON.stringify(response.error.data)}` : "";
      throw new Error(`${response.error.message}${detail}`);
    }

    return response.result;
  }

  function createDraftThreadId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${DRAFT_THREAD_ID_PREFIX}${crypto.randomUUID()}`;
    }

    return `${DRAFT_THREAD_ID_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  function isDraftThreadId(threadId: string) {
    return threadId.startsWith(DRAFT_THREAD_ID_PREFIX);
  }

  function createDraftThread(harness: WorkbenchHarness, threadId = createDraftThreadId()): ThreadPayload {
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const model = readStoredHarnessModel(harness);

    return {
      id: threadId,
      harness,
      model,
      reasoningEffort: readStoredHarnessModelEffort(harness, model),
      agentPath: readStoredHarnessAgent(harness),
      isDraft: true,
      name: "Create new thread",
      preview: "",
      createdAt: timestampSeconds,
      updatedAt: timestampSeconds,
      status: "idle",
      cwd: state.projectRootPath || state.projectRoot,
      source: harness,
      path: null,
      turns: [],
    };
  }

  function getThreadHarness(threadId: string, fallback: WorkbenchHarness = "codex") {
    if (state.currentThread?.id === threadId) {
      return state.currentThread.harness;
    }

    return state.threads.find((thread) => thread.id === threadId)?.harness ?? fallback;
  }

  function getThreadModel(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return state.currentThread.model;
    }

    return null;
  }

  function getThreadReasoningEffort(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return state.currentThread.reasoningEffort;
    }

    return null;
  }

  function resolvePreferredReasoningEffort(harness: WorkbenchHarness, modelId: string | null) {
    if (!modelId) {
      return null;
    }

    const storedEffort = readStoredHarnessModelEffort(harness, modelId);
    if (storedEffort) {
      return storedEffort;
    }

    const selectedModel = state.modelsByHarness.get(harness)?.find((model) => model.id === modelId) ?? null;
    if (!selectedModel?.supportsReasoningEffort) {
      return null;
    }

    return selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? null;
  }

  function mapCodexModelToWorkbenchOption(model: CodexModel): WorkbenchModelOption {
    return {
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      hidden: model.hidden,
      isDefault: model.isDefault,
      supportsPersonality: model.supportsPersonality,
      supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportsVision: model.inputModalities.includes("image"),
      inputModalities: [...model.inputModalities],
      maxContextWindowTokens: null,
      additionalSpeedTiers: [...model.additionalSpeedTiers],
      policyState: null,
      billingMultiplier: null,
    };
  }

  async function listModels(harness: WorkbenchHarness) {
    const cachedModels = state.modelsByHarness.get(harness);
    if (cachedModels) {
      return cachedModels;
    }

    if (harness === "copilot") {
      const response = await sendBridgeRequest<{ data: WorkbenchModelOption[] }>(harness, {
        method: "model/list",
        params: undefined,
      });
      state.modelsByHarness.set(harness, response.data);
      return response.data;
    }

    const models: WorkbenchModelOption[] = [];
    let cursor: string | null = null;

    do {
      const response = await sendBridgeRequest<ModelListResponse>(harness, {
        method: "model/list",
        params: {
          cursor,
          includeHidden: false,
          limit: 100,
        },
      });
      models.push(...response.data.map(mapCodexModelToWorkbenchOption));
      cursor = response.nextCursor;
    } while (cursor);

    state.modelsByHarness.set(harness, models);
    return models;
  }

  async function fetchThreadPayload(threadId: string, harness: WorkbenchHarness) {
    try {
      const response = await sendBridgeRequest<{ model?: string | null; modelProvider?: string | null; reasoningEffort?: string | null; thread: ThreadReadResponse["thread"] }>(harness, {
        method: "thread/resume",
        params: {
          persistExtendedHistory: true,
          threadId,
        },
      });

      if (state.projectRootPath && !isProjectCodexThread(response.thread, state.projectRootPath)) {
        emitStatusMessage("That Codex thread doesn't belong to this project.");
        return null;
      }

      const nextModel = response.model ?? null;
      return toThreadPayload(
        response.thread,
        harness,
        nextModel,
        readStoredHarnessModelEffort(harness, nextModel) ?? response.reasoningEffort ?? null,
        readStoredHarnessAgent(harness),
      );
    } catch (error) {
      emitStatusMessage(error instanceof Error ? error.message : "Unable to open Codex thread.");
      return null;
    }
  }

  async function readCurrentThread(threadId: string, harness: WorkbenchHarness) {
    try {
      const response = await sendBridgeRequest<ThreadReadResponse>(harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId,
        },
      });

      if (state.projectRootPath && !isProjectCodexThread(response.thread, state.projectRootPath)) {
        emitStatusMessage("That Codex thread doesn't belong to this project.");
        return null;
      }

      const nextModel = getThreadModel(threadId);
      return toThreadPayload(
        response.thread,
        harness,
        nextModel,
        getThreadReasoningEffort(threadId) ?? readStoredHarnessModelEffort(harness, nextModel),
        state.currentThread?.agentPath ?? readStoredHarnessAgent(harness),
      );
    } catch (error) {
      emitStatusMessage(error instanceof Error ? error.message : "Unable to read Codex thread.");
      return null;
    }
  }

  async function refreshThreads() {
    if (refreshThreadsPromise) {
      await refreshThreadsPromise;
      return;
    }

    refreshThreadsPromise = (async () => {
      try {
        if (!state.projectRootPath) {
          state.threads = [];
          state.threadsError = "";
          emit();
          return;
        }

        const results = await Promise.allSettled((["codex", "copilot"] as const).map(async (harness) => {
          const response = await sendBridgeRequest<ThreadListResponse>(harness, {
            method: "thread/list",
            params: {
              archived: false,
              limit: 50,
              sortKey: "updated_at",
            },
          });

          return response.data
            .filter((thread) => isProjectCodexThread(thread, state.projectRootPath))
            .map((thread) => toThreadSummary(thread, harness));
        }));

        const threads: ThreadSummary[] = [];
        const errors: string[] = [];

        for (const result of results) {
          if (result.status === "fulfilled") {
            threads.push(...result.value);
            continue;
          }

          errors.push(result.reason instanceof Error ? result.reason.message : "Unable to load some threads.");
        }

        state.threads = threads.sort((left, right) => {
          if (right.updatedAt !== left.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }

          if (left.harness !== right.harness) {
            return left.harness.localeCompare(right.harness);
          }

          return left.id.localeCompare(right.id);
        });
        state.threadsError = errors.join(" ");
      } catch (error) {
        state.threads = [];
        state.threadsError = error instanceof Error ? error.message : "Unable to load Codex threads.";
      } finally {
        refreshThreadsPromise = null;
        emit();
      }
    })();

    await refreshThreadsPromise;
  }

  async function refreshRateLimits() {
    const harness = state.currentThread?.harness ?? "codex";

    try {
      const response = await sendBridgeRequest<GetAccountRateLimitsResponse>(harness, {
        method: "account/rateLimits/read",
        params: undefined,
      });
      state.rateLimitsByHarness.set(harness, response.rateLimits);
      if (state.currentThread?.harness === harness) {
        setRateLimits(response.rateLimits);
      }
    } catch {
      if (!state.rateLimitsByHarness.has(harness) && state.currentThread?.harness === harness) {
        setRateLimits(null);
      }
    }
  }

  function normalizeThreadMessageInput(input: UserInput[] | string) {
    const entries = Array.isArray(input)
      ? input
      : input.trim()
        ? [createTextInput(input)]
        : [];
    const normalized: UserInput[] = [];

    for (const entry of entries) {
      switch (entry.type) {
        case "text": {
          const text = entry.text.trim();
          if (text) {
            normalized.push(createTextInput(text));
          }
          break;
        }
        case "image": {
          const url = entry.url.trim();
          if (url) {
            normalized.push({
              type: "image",
              url,
            });
          }
          break;
        }
        case "localImage": {
          const path = entry.path.trim();
          if (path) {
            normalized.push({
              type: "localImage",
              path,
            });
          }
          break;
        }
        case "skill": {
          const name = entry.name.trim();
          const path = entry.path.trim();
          if (name && path) {
            normalized.push({
              type: "skill",
              name,
              path,
            });
          }
          break;
        }
        case "mention": {
          const name = entry.name.trim();
          const path = entry.path.trim();
          if (name && path) {
            normalized.push({
              type: "mention",
              name,
              path,
            });
          }
          break;
        }
      }
    }

    return normalized;
  }

  function isCurrentThreadUpToDate(threadId: string) {
    const currentThread = state.currentThread;
    if (!currentThread || currentThread.id !== threadId) {
      return false;
    }

    if (getCurrentInProgressTurn(currentThread)) {
      return false;
    }

    const threadSummary = state.threads.find((thread) => thread.id === threadId);
    if (!threadSummary) {
      return false;
    }

    return currentThread.updatedAt === threadSummary.updatedAt
      && currentThread.harness === threadSummary.harness
      && currentThread.status === threadSummary.status;
  }

  function mergeTurnMetadata(existingTurn: Turn | undefined, incomingTurn: Turn): Turn {
    return {
      ...incomingTurn,
      items: existingTurn?.items ?? incomingTurn.items,
    };
  }

  function upsertTurnMetadata(incomingTurn: Turn) {
    return updateCurrentThread((thread) => {
      const turnIndex = thread.turns.findIndex((turn) => turn.id === incomingTurn.id);
      if (turnIndex === -1) {
        return {
          ...thread,
          turns: [...thread.turns, incomingTurn],
        };
      }

      return {
        ...thread,
        turns: thread.turns.map((turn, index) => (
          index === turnIndex ? mergeTurnMetadata(turn, incomingTurn) : turn
        )),
      };
    });
  }

  function updateTurnItems(
    turnId: string,
    updater: (items: ThreadItem[]) => ThreadItem[] | null,
  ) {
    return updateCurrentThread((thread) => {
      let updated = false;
      const turns = thread.turns.map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }

        const nextItems = updater(turn.items);
        if (!nextItems) {
          return turn;
        }

        updated = true;
        return {
          ...turn,
          items: nextItems,
        };
      });

      return updated ? { ...thread, turns } : null;
    });
  }

  function upsertThreadItem(turnId: string, incomingItem: ThreadItem) {
    return updateTurnItems(turnId, (items) => {
      const itemIndex = items.findIndex((item) => item.id === incomingItem.id);
      if (itemIndex === -1) {
        return [...items, incomingItem];
      }

      return items.map((item, index) => (
        index === itemIndex ? incomingItem : item
      ));
    });
  }

  function updateThreadItem(
    turnId: string,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem | null,
  ) {
    return updateTurnItems(turnId, (items) => {
      let updated = false;
      const nextItems = items.map((item) => {
        if (item.id !== itemId) {
          return item;
        }

        const nextItem = updater(item);
        if (!nextItem) {
          return item;
        }

        updated = true;
        return nextItem;
      });

      return updated ? nextItems : null;
    });
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

  function doesNotificationTargetCurrentThread(
    notification: CodexAppServerNotification,
    harness: WorkbenchHarness,
  ) {
    if (state.currentThread?.harness !== harness) {
      return false;
    }

    return "threadId" in notification.params
      ? notification.params.threadId === state.currentThreadId
      : "thread" in notification.params
        ? notification.params.thread.id === state.currentThreadId
        : false;
  }

  function applyCodexNotificationToCurrentThread(
    notification: CodexAppServerNotification,
    harness: WorkbenchHarness,
  ) {
    if (!state.currentThread || !doesNotificationTargetCurrentThread(notification, harness)) {
      return false;
    }

    switch (notification.method) {
      case "thread/started":
        return updateCurrentThreadFields({
          ...toThreadSummary(notification.params.thread, harness),
          isDraft: false,
        });
      case "thread/status/changed":
        return updateCurrentThreadFields({
          status: formatThreadStatus(notification.params.status),
        });
      case "thread/name/updated":
        return updateCurrentThreadFields({
          name: notification.params.threadName ?? null,
        });
      case "turn/started":
      case "turn/completed":
        return upsertTurnMetadata(notification.params.turn);
      case "item/started":
      case "item/completed":
        return upsertThreadItem(notification.params.turnId, notification.params.item);
      case "item/agentMessage/delta":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "agentMessage"
            ? { ...item, text: `${item.text}${notification.params.delta}` }
            : null
        ));
      case "item/plan/delta":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "plan"
            ? { ...item, text: `${item.text}${notification.params.delta}` }
            : null
        ));
      case "item/commandExecution/outputDelta":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "commandExecution"
            ? { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ""}${notification.params.delta}` }
            : null
        ));
      case "item/fileChange/patchUpdated":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "fileChange"
            ? { ...item, changes: notification.params.changes }
            : null
        ));
      case "item/reasoning/summaryPartAdded":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "reasoning"
            ? { ...item, summary: ensureIndexedText(item.summary, notification.params.summaryIndex) }
            : null
        ));
      case "item/reasoning/summaryTextDelta":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "reasoning"
            ? { ...item, summary: appendIndexedText(item.summary, notification.params.summaryIndex, notification.params.delta) }
            : null
        ));
      case "item/reasoning/textDelta":
        return updateThreadItem(notification.params.turnId, notification.params.itemId, (item) => (
          item.type === "reasoning"
            ? { ...item, content: appendIndexedText(item.content, notification.params.contentIndex, notification.params.delta) }
            : null
        ));
      case "thread/archived":
      case "thread/unarchived":
      case "thread/closed":
      case "thread/tokenUsage/updated":
      case "thread/compacted":
      case "hook/started":
      case "hook/completed":
      case "turn/diff/updated":
      case "turn/plan/updated":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "rawResponseItem/completed":
      case "command/exec/outputDelta":
      case "item/commandExecution/terminalInteraction":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
      case "serverRequest/resolved":
      case "model/rerouted":
      case "model/verification":
      case "thread/realtime/started":
      case "thread/realtime/itemAdded":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
      case "thread/realtime/outputAudio/delta":
      case "thread/realtime/sdp":
      case "thread/realtime/error":
      case "thread/realtime/closed":
      case "error":
      case "skills/changed":
      case "mcpServer/oauthLogin/completed":
      case "mcpServer/startupStatus/updated":
      case "account/updated":
      case "account/rateLimits/updated":
      case "app/list/updated":
      case "externalAgentConfig/import/completed":
      case "fs/changed":
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
      case "configWarning":
      case "fuzzyFileSearch/sessionUpdated":
      case "fuzzyFileSearch/sessionCompleted":
      case "windows/worldWritableWarning":
      case "windowsSandbox/setupCompleted":
      case "account/login/completed":
        return false;
    }

    const unhandledNotification: never = notification;
    return unhandledNotification;
  }

  function cloneUserInput(input: UserInput): UserInput {
    switch (input.type) {
      case "text":
        return {
          ...input,
          text_elements: [...input.text_elements],
        };
      default:
        return { ...input };
    }
  }

  function doesUserMessageMatchInput(
    item: ThreadPayload["turns"][number]["items"][number],
    input: UserInput[],
  ) {
    if (item.type !== "userMessage" || item.content.length !== input.length) {
      return false;
    }

    return item.content.every((content, index) => {
      const nextInput = input[index];
      if (!nextInput || content.type !== nextInput.type) {
        return false;
      }

      switch (nextInput.type) {
        case "text":
          return content.type === "text"
            && content.text.trim() === nextInput.text.trim();
        case "image":
          return content.type === "image"
            && content.url === nextInput.url;
        case "localImage":
          return content.type === "localImage"
            && content.path === nextInput.path;
        case "skill":
          return content.type === "skill"
            && content.name === nextInput.name
            && content.path === nextInput.path;
        case "mention":
          return content.type === "mention"
            && content.name === nextInput.name
            && content.path === nextInput.path;
        default:
          return false;
      }
    });
  }

  function createOptimisticUserMessage(input: UserInput[]): Extract<ThreadPayload["turns"][number]["items"][number], { type: "userMessage" }> {
    return {
      type: "userMessage",
      id: `optimistic-user-message:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      content: input.map((entry) => cloneUserInput(entry)),
    };
  }

  function applyOptimisticSteerMessage(
    payload: ThreadPayload,
    previousThread: ThreadPayload | null,
    input: UserInput[],
  ) {
    const previousTargetTurn = getCurrentInProgressTurn(previousThread);
    if (!previousTargetTurn) {
      return payload;
    }

    const nextTurnIndex = payload.turns.findIndex((turn) => turn.id === previousTargetTurn.id);
    if (nextTurnIndex === -1) {
      return payload;
    }

    const nextTurn = payload.turns[nextTurnIndex];
    if (nextTurn.status !== "inProgress") {
      return payload;
    }

    const newItems = nextTurn.items.slice(previousTargetTurn.items.length);
    if (newItems.some((item) => doesUserMessageMatchInput(item, input))) {
      return payload;
    }

    return {
      ...payload,
      turns: payload.turns.map((turn, index) => (
        index === nextTurnIndex
          ? {
            ...turn,
            items: [...turn.items, createOptimisticUserMessage(input)],
          }
          : turn
      )),
    };
  }

  async function openThread(
    threadId: string,
    { harness, source = "open" }: { harness?: WorkbenchHarness; source?: "open" | "reload" } = {},
  ) {
    if (source === "open" && threadId === state.currentThreadId) {
      return;
    }

    const payload = await fetchThreadPayload(threadId, harness ?? getThreadHarness(threadId));
    if (!payload) {
      return;
    }

    setCurrentThread(payload);
  }

  async function reconcileCurrentThreadFromRead(threadId: string, harness: WorkbenchHarness) {
    const payload = await readCurrentThread(threadId, harness);
    if (!payload || state.currentThreadId !== threadId) {
      return;
    }

    setCurrentThread(payload);
  }

  async function sendThreadMessage(threadId: string, input: UserInput[]) {
    let resolvedThreadId = threadId;
    let harness = resolvedThreadId.trim()
      ? getThreadHarness(resolvedThreadId)
      : state.currentThread?.harness ?? "codex";
    const selectedModel = resolvedThreadId.trim()
      ? getThreadModel(resolvedThreadId)
      : state.currentThread?.model ?? readStoredHarnessModel(harness);
    const selectedReasoningEffort = resolvedThreadId.trim()
      ? getThreadReasoningEffort(resolvedThreadId)
      : state.currentThread?.reasoningEffort ?? resolvePreferredReasoningEffort(harness, selectedModel);
    const selectedAgentPath = resolvedThreadId.trim()
      ? state.currentThread?.id === resolvedThreadId ? state.currentThread.agentPath : null
      : state.currentThread?.agentPath ?? readStoredHarnessAgent(harness);
    const normalizedInput = normalizeThreadMessageInput(input);
    const isDraftThread = state.currentThread?.isDraft === true && state.currentThread.id === resolvedThreadId;
    let previousThread = state.currentThread && state.currentThread.id === resolvedThreadId && !state.currentThread.isDraft
      ? state.currentThread
      : null;

    if (!normalizedInput.length) {
      throw new Error("Message input cannot be empty.");
    }

    if (selectedAgentPath && harness === "codex") {
      normalizedInput.unshift(createTextInput(
        `For this turn, you are the agent defined in ${selectedAgentPath}. If you do not have this file in your context window, read it. Treat it as CRITICAL rules to follow, only overridden by anything I say below:`,
      ));
    }

    if (isDraftThread || !resolvedThreadId.trim()) {
      const threadStartRequest = createThreadStartRequest(0, {
        ...(selectedModel ? { model: selectedModel } : {}),
        persistExtendedHistory: true,
      });
      const startedThreadResponse = await sendBridgeRequest<{ model?: string | null; modelProvider?: string | null; reasoningEffort?: string | null; thread: ThreadReadResponse["thread"] }>(harness, {
        method: threadStartRequest.method,
        params: selectedAgentPath && harness === "copilot"
          ? {
            ...threadStartRequest.params,
            agentPath: selectedAgentPath,
          } as typeof threadStartRequest.params & { agentPath: string }
          : threadStartRequest.params,
      });

      const startedPayload = toThreadPayload(
        startedThreadResponse.thread,
        harness,
        startedThreadResponse.model ?? selectedModel ?? null,
        selectedReasoningEffort ?? startedThreadResponse.reasoningEffort ?? null,
        selectedAgentPath,
      );
      setCurrentThread(startedPayload);
      resolvedThreadId = startedPayload.id;
      previousThread = null;
      await refreshThreads();
    }

    const readableThreadResponse = await sendBridgeRequest<ThreadReadResponse>(harness, {
      method: "thread/read",
      params: {
        includeTurns: true,
        threadId: resolvedThreadId,
      },
    });
    const resumedThreadResponse = await sendBridgeRequest<{ model?: string | null; modelProvider?: string | null; reasoningEffort?: string | null; thread: ThreadReadResponse["thread"] }>(harness, {
      method: "thread/resume",
      params: {
        ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        persistExtendedHistory: true,
        threadId: resolvedThreadId,
      } as { agentPath?: string; model?: string; persistExtendedHistory: true; threadId: string },
    });
    const readableThread = toThreadPayload(readableThreadResponse.thread, harness);
    const resumedThread = toThreadPayload(
      resumedThreadResponse.thread,
      harness,
      resumedThreadResponse.model ?? selectedModel ?? readableThread.model,
      selectedReasoningEffort ?? resumedThreadResponse.reasoningEffort ?? readableThread.reasoningEffort,
      selectedAgentPath,
    );

    const currentInProgressTurn = getCurrentInProgressTurn(resumedThread);
    const visibleCurrentTurn = getCurrentTurn(readableThread);

    if (
      visibleCurrentTurn?.status === "completed"
      && currentInProgressTurn
      && currentInProgressTurn.id !== visibleCurrentTurn.id
    ) {
      throw new Error("This thread is out of sync with the app-server. New messages are disabled here for now.");
    }

    harness = resumedThread.harness;

    if (currentInProgressTurn) {
      await sendBridgeRequest<TurnSteerResponse>(harness, {
        method: "turn/steer",
        params: {
          ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
          expectedTurnId: currentInProgressTurn.id,
          input: normalizedInput,
          threadId: resolvedThreadId,
        } as { agentPath?: string; expectedTurnId: string; input: UserInput[]; threadId: string },
      });
    } else {
      await sendBridgeRequest<TurnStartResponse>(harness, {
        method: "turn/start",
        params: {
          ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
          input: normalizedInput,
          ...(selectedReasoningEffort ? { effort: selectedReasoningEffort } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          summary: DEFAULT_TURN_REASONING_SUMMARY,
          threadId: resolvedThreadId,
        } as { agentPath?: string; effort?: string; input: UserInput[]; model?: string; summary: typeof DEFAULT_TURN_REASONING_SUMMARY; threadId: string },
      });
    }

    const refreshedThreadResponse = await sendBridgeRequest<ThreadReadResponse>(harness, {
      method: "thread/read",
      params: {
        includeTurns: true,
        threadId: resolvedThreadId,
      },
    });
    const payload = applyOptimisticSteerMessage(
      toThreadPayload(refreshedThreadResponse.thread, harness, resumedThread.model, resumedThread.reasoningEffort, resumedThread.agentPath),
      previousThread,
      normalizedInput,
    );
    setCurrentThread(payload);
    await refreshThreads();
  }

  function scheduleCodexNotificationRefresh(handling: CodexAppServerNotificationHandling) {
    if (handling.refreshThread && state.currentThreadId && !lifecycle.has(THREAD_REFRESH_TASK_ID)) {
      // Notification-triggered refresh stays local to the thread client; the coordinator owns only recurring refresh policy.
      lifecycle.scheduleOnce(THREAD_REFRESH_TASK_ID, CODEX_NOTIFICATION_THREAD_REFRESH_DELAY_MS, () => {
        if (disposed || !state.currentThreadId) {
          return;
        }

        void reconcileCurrentThreadFromRead(state.currentThreadId, state.currentThread?.harness ?? "codex");
      });
    }

    if (handling.refreshThreads && !lifecycle.has(THREAD_LIST_REFRESH_TASK_ID)) {
      lifecycle.scheduleOnce(THREAD_LIST_REFRESH_TASK_ID, CODEX_NOTIFICATION_THREAD_LIST_REFRESH_DELAY_MS, () => {
        if (disposed) {
          return;
        }

        void refreshThreads();
      });
    }
  }

  function handleCodexNotification(
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
    harness: WorkbenchHarness,
  ) {
    if (notification.method === "account/rateLimits/updated" && state.currentThread?.harness === harness) {
      setRateLimits(notification.params.rateLimits);
    }

    if (applyCodexNotificationToCurrentThread(notification, harness)) {
      emit();
    }
    scheduleCodexNotificationRefresh(handling);
  }

  const unsubscribeCodexNotifications = codexClient.onNotification((notification, handling, harness) => {
    handleCodexNotification(notification, handling, harness);
  });
  lifecycle.addUnsubscribe(unsubscribeCodexNotifications);
  lifecycle.addUnsubscribe(() => {
    codexClient.close();
  });

  function clearThreadSelection() {
    if (!state.currentThread && !state.currentThreadId && !state.rateLimits) {
      return;
    }

    state.currentThreadId = "";
    state.currentThread = null;
    setRateLimits(null);
    emit();
  }

  function hasThread(threadId: string) {
    return state.threads.some((thread) => thread.id === threadId);
  }

  function setCurrentThreadModel(threadId: string, model: string) {
    if (!state.currentThread || state.currentThread.id !== threadId) {
      return;
    }

    persistHarnessModel(state.currentThread.harness, model);
    updateCurrentThreadFields({
      model,
      reasoningEffort: resolvePreferredReasoningEffort(state.currentThread.harness, model),
    });
  }

  function setCurrentThreadAgent(threadId: string, agentPath: string | null) {
    if (!state.currentThread || state.currentThread.id !== threadId) {
      return;
    }

    persistHarnessAgent(state.currentThread.harness, agentPath);
    updateCurrentThreadFields({ agentPath });
  }

  function setCurrentThreadReasoningEffort(threadId: string, effort: string | null) {
    if (!state.currentThread || state.currentThread.id !== threadId || !state.currentThread.model) {
      return;
    }

    persistHarnessModelEffort(state.currentThread.harness, state.currentThread.model, effort);
    updateCurrentThreadFields({ reasoningEffort: effort });
  }

  function setDraftThreadHarness(harness: WorkbenchHarness) {
    if (!state.currentThread?.isDraft) {
      return;
    }

    const model = readStoredHarnessModel(harness);

    updateCurrentThreadFields({
      harness,
      model,
      reasoningEffort: readStoredHarnessModelEffort(harness, model),
      agentPath: readStoredHarnessAgent(harness),
      source: harness,
    });
  }

  function createThread(harness: WorkbenchHarness, threadId?: string) {
    const draftThread = createDraftThread(harness, threadId);
    setCurrentThread(draftThread);
    return draftThread;
  }

  function dispose() {
    disposed = true;
    listeners.clear();
    lifecycle.dispose();
  }

  return {
    clearThreadSelection,
    createThread,
    dispose,
    getSnapshot,
    hasThread,
    isCurrentThreadUpToDate,
    isDraftThreadId,
    listModels,
    openThread,
    reconcileCurrentThreadFromRead,
    readCurrentThread,
    refreshRateLimits,
    refreshThreads,
    sendThreadMessage,
    setCurrentThreadAgent,
    setCurrentThreadModel,
    setCurrentThreadReasoningEffort,
    setDraftThreadHarness,
    setProjectContext,
    subscribe,
  };
}