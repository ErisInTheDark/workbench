/*
 * Exports:
 * - WorkbenchThreadState: owned thread, rate-limit, and model cache state for the workbench. Keywords: workbench, thread, state, codex.
 * - WorkbenchThreadSnapshot: readonly projection of the current thread client state. Keywords: workbench, thread, snapshot, rate limits.
 * - WorkbenchThreadListener: subscriber signature for thread client state changes. Keywords: workbench, thread, subscribe.
 * - WorkbenchThreadClientOptions: creation options for the thread client manager hooks. Keywords: workbench, thread, status, callbacks.
 * - WorkbenchThreadClient: public surface for thread transport, draft threads, and notification handling. Keywords: workbench, thread, client, dispose.
 * - default WorkbenchThreadClient: create the thread sub-client that owns Codex or Copilot thread state and notifications. Keywords: workbench, thread, codex, copilot, default export.
 */

import { CodexAppServerClient } from "../codex/app-server-client";
import type { CodexAppServerNotification, CodexAppServerNotificationHandling } from "../codex/app-server-notifications";
import type { GetAccountRateLimitsResponse } from "../codex/generated/app-server/v2/GetAccountRateLimitsResponse";
import type { Model as CodexModel } from "../codex/generated/app-server/v2/Model";
import type { ModelListResponse } from "../codex/generated/app-server/v2/ModelListResponse";
import type { RateLimitSnapshot } from "../codex/generated/app-server/v2/RateLimitSnapshot";
import type { ThreadActiveFlag } from "../codex/generated/app-server/v2/ThreadActiveFlag";
import type { ThreadItem } from "../codex/generated/app-server/v2/ThreadItem";
import type { ThreadListResponse } from "../codex/generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "../codex/generated/app-server/v2/ThreadReadResponse";
import type { ThreadResumeParams } from "../codex/generated/app-server/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "../codex/generated/app-server/v2/ThreadResumeResponse";
import type { Turn } from "../codex/generated/app-server/v2/Turn";
import type { TurnStartParams } from "../codex/generated/app-server/v2/TurnStartParams";
import type { TurnStartResponse } from "../codex/generated/app-server/v2/TurnStartResponse";
import type { TurnSteerResponse } from "../codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "../codex/generated/app-server/v2/UserInput";
import {
    createQuestionnaireCollaborationMode,
    createTextInput,
    createThreadStartRequest,
    isCodexJsonRpcFailure,
} from "../codex/protocol";
import { formatThreadStatus, isProjectCodexThread, toThreadPayload, toThreadSummary } from "../codex/thread-adapter";
import { getCurrentInProgressTurn, getCurrentTurn } from "../codex/thread-state";
import {
    buildCodexThreadBootstrapInstructions,
    buildThreadTitleBootstrapInstructions,
    buildThreadTitleRouteUrl,
} from "../thread-bootstrap";
import {
    getThreadStateChangeTagText as getNormalizedThreadStateChangeTagText,
} from "./markdown/markdown-parse";
import type {
    ThreadPayload,
    ThreadSummary,
    WorkbenchHarness,
    WorkbenchModelOption,
    WorkbenchPendingUserInputRequest,
    WorkbenchQuestionnaireHistoryEntry,
    WorkbenchSendThreadMessageOptions,
    WorkbenchStoredThreadUnreadState,
    WorkbenchSubmitUserInputRequestOptions,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "../types";
import LifecycleScope from "./state/LifecycleScope";
import {
    persistHarnessAgent,
    persistHarnessModel,
    persistHarnessModelEffort,
    persistHarnessServiceTier,
    persistThreadUnreadState,
    readLocalWorkbenchOrigin,
    readStoredHarnessAgent,
    readStoredHarnessModel,
    readStoredHarnessModelEffort,
    readStoredHarnessServiceTier,
    readStoredThreadUnreadState,
} from "./state/browser-state";
import { applyQuestionnaireHistoryToThread } from "./thread/thread-questionnaire-history";
import { getTurnRenderSignature } from "./thread/thread-item-signature";

const THREAD_REFRESH_TASK_ID = "thread-refresh";
const THREAD_LIST_REFRESH_TASK_ID = "thread-list-refresh";
const RATE_LIMIT_REFRESH_TASK_ID = "rate-limit-refresh";
const CODEX_NOTIFICATION_THREAD_REFRESH_DELAY_MS = 350;
const CODEX_NOTIFICATION_THREAD_LIST_REFRESH_DELAY_MS = 750;
const ACTIVE_TURN_RATE_LIMIT_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_TURN_REASONING_SUMMARY = "detailed" as const;
const DRAFT_THREAD_ID = "new";
const DRAFT_THREAD_ID_PREFIX = "draft:";
const STABLE_VISIBLE_THREAD_COUNT = 5;
const EMPTY_ROLLOUT_ERROR_FRAGMENT = "rollout at";
const EMPTY_ROLLOUT_ERROR_SUFFIX = "is empty";
const MISSING_ROLLOUT_ERROR_FRAGMENT = "no rollout found by id";
const FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE = "Started the thread. Its saved rollout is still warming up, so the live view will refresh automatically.";

export interface WorkbenchThreadState {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  modelsByHarness: Map<WorkbenchHarness, WorkbenchModelOption[]>;
  pendingUserInputRequestsByThreadId: Map<string, WorkbenchPendingUserInputRequest>;
  projectId: string;
  projectRoot: string;
  projectRootPath: string;
  questionnaireHistoryByThreadId: Map<string, WorkbenchQuestionnaireHistoryEntry[]>;
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByHarness: Map<WorkbenchHarness, RateLimitSnapshot | null>;
  threadUnreadStateByKey: Map<string, WorkbenchStoredThreadUnreadState>;
  threads: ThreadSummary[];
  threadsError: string;
}

export interface WorkbenchThreadSnapshot {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  pendingUserInputRequestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>;
  rateLimits: RateLimitSnapshot | null;
  threads: ThreadSummary[];
  threadsError: string;
}

export type WorkbenchThreadListener = (snapshot: WorkbenchThreadSnapshot) => void;

export interface WorkbenchThreadClientOptions {
  onStatusMessage?: (message: string) => void;
  onThreadStarted?: (thread: ThreadPayload) => void;
}

interface WorkbenchThreadClient {
  clearThreadSelection: () => void;
  createThread: (harness: WorkbenchHarness, threadId?: string) => ThreadPayload;
  dispose: () => void;
  getSnapshot: () => WorkbenchThreadSnapshot;
  hasThread: (threadId: string) => boolean;
  isCurrentThreadUpToDate: (threadId: string) => boolean;
  isDraftThreadId: (threadId: string) => boolean;
  listModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  markThreadSeen: (thread: ThreadPayload) => void;
  openThread: (threadId: string, options?: { harness?: WorkbenchHarness; source?: "open" | "reload" }) => Promise<void>;
  readThread: (threadId: string, harness?: WorkbenchHarness) => Promise<ThreadPayload | null>;
  selectThreadPayload: (thread: ThreadPayload) => void;
  reconcileCurrentThreadFromRead: (threadId: string, harness: WorkbenchHarness) => Promise<void>;
  readCurrentThread: (threadId: string, harness: WorkbenchHarness) => Promise<ThreadPayload | null>;
  refreshPendingUserInputRequests: () => Promise<void>;
  refreshRateLimits: () => Promise<void>;
  refreshThreads: () => Promise<void>;
  sendThreadMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  stopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  submitPendingUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  setCurrentThreadServiceTier: (threadId: string, serviceTier: string | null) => void;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
  setProjectContext: (context: { projectId?: string; root: string; rootPath: string }) => void;
  subscribe: (listener: WorkbenchThreadListener) => () => void;
}

type RateLimitSnapshotSource = "cache" | "notification" | "read";

type RateLimitSnapshotEntry = {
  generation: number;
  receivedAt: number;
  snapshot: RateLimitSnapshot | null;
  source: RateLimitSnapshotSource;
};

interface OptimisticUserMessageEntry {
  createdAt: number;
  input: UserInput[];
  item: Extract<ThreadItem, { type: "userMessage" }>;
}

type CodexThreadSessionResponse = {
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  thread: ThreadReadResponse["thread"];
};

function createInitialThreadState(): WorkbenchThreadState {
  return {
    currentThread: null,
    currentThreadId: "",
    modelsByHarness: new Map(),
    pendingUserInputRequestsByThreadId: new Map(),
    projectId: "",
    projectRoot: "Project",
    projectRootPath: "",
    questionnaireHistoryByThreadId: new Map(),
    rateLimits: null,
    rateLimitsByHarness: new Map(),
    threadUnreadStateByKey: new Map(),
    threads: [],
    threadsError: "",
  };
}

function getThreadStateKey(harness: WorkbenchHarness, threadId: string) {
  return `${harness}:${threadId}`;
}

function getThreadItemKey(turnId: string, itemId: string) {
  return `${turnId}:${itemId}`;
}

function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

function removeThreadActiveFlag(status: string, flag: ThreadActiveFlag) {
  if (!status.startsWith("active:")) {
    return status;
  }

  const [, activeFlags = ""] = status.split(":", 2);
  const nextFlags = activeFlags.split(",").filter((activeFlag) => activeFlag && activeFlag !== flag);
  return nextFlags.length ? `active:${nextFlags.join(",")}` : "active";
}

function getThreadItemIds(turns: Turn[]) {
  return turns.flatMap((turn) => turn.items.map((item) => item.id));
}

function countUnreadThreadItems(state: WorkbenchStoredThreadUnreadState) {
  if (!state.lastSeenItemId) {
    return state.observedItemIds.length;
  }

  const lastSeenIndex = state.observedItemIds.lastIndexOf(state.lastSeenItemId);
  return lastSeenIndex >= 0
    ? Math.max(0, state.observedItemIds.length - lastSeenIndex - 1)
    : 0;
}

function getLatestTurnStartedAt(turns: Turn[]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const startedAt = turns[index].startedAt;
    if (typeof startedAt === "number") {
      return startedAt;
    }
  }

  return null;
}

function getWindowRemainingPercent(window: RateLimitSnapshot["primary"]) {
  return window ? 100 - window.usedPercent : null;
}

function hasRateLimitWindowRolledOver(previous: RateLimitSnapshot["primary"], next: RateLimitSnapshot["primary"]) {
  if (!previous || !next) {
    return false;
  }

  const previousResetMs = previous.resetsAt === null ? null : previous.resetsAt * 1000;
  const nextResetMs = next.resetsAt === null ? null : next.resetsAt * 1000;
  if (previousResetMs !== null && previousResetMs <= Date.now()) {
    return true;
  }

  return previousResetMs !== null
    && nextResetMs !== null
    && nextResetMs > previousResetMs
    && getWindowRemainingPercent(previous) !== null
    && getWindowRemainingPercent(previous)! <= 1;
}

function isRegressiveRateLimitWindow(previous: RateLimitSnapshot["primary"], next: RateLimitSnapshot["primary"]) {
  if (!previous || !next || previous.windowDurationMins !== next.windowDurationMins) {
    return false;
  }

  const previousRemaining = getWindowRemainingPercent(previous);
  const nextRemaining = getWindowRemainingPercent(next);
  return previousRemaining !== null
    && nextRemaining !== null
    && nextRemaining > previousRemaining
    && !hasRateLimitWindowRolledOver(previous, next);
}

function isRegressiveRateLimitSnapshot(previous: RateLimitSnapshot | null, next: RateLimitSnapshot | null) {
  if (!previous || !next) {
    return false;
  }

  return isRegressiveRateLimitWindow(previous.primary, next.primary);
}

function selectRateLimitSnapshot(
  response: GetAccountRateLimitsResponse,
  harness: WorkbenchHarness,
  previousSnapshot: RateLimitSnapshot | null,
) {
  const legacySnapshot = response.rateLimits as RateLimitSnapshot | null;
  const snapshotsByLimitId = response.rateLimitsByLimitId ?? {};
  if (harness === "codex") {
    return snapshotsByLimitId.codex
      ?? (previousSnapshot?.limitId ? snapshotsByLimitId[previousSnapshot.limitId] : undefined)
      ?? (legacySnapshot?.limitId ? snapshotsByLimitId[legacySnapshot.limitId] : undefined)
      ?? Object.values(snapshotsByLimitId)[0]
      ?? legacySnapshot;
  }

  return legacySnapshot;
}

function isTextPrefix(prefix: string, value: string) {
  return value.startsWith(prefix);
}

function mergeLongerStreamingText(incomingText: string, liveText: string) {
  if (!incomingText) {
    return liveText;
  }

  if (!liveText) {
    return incomingText;
  }

  if (isTextPrefix(incomingText, liveText)) {
    return liveText;
  }

  if (isTextPrefix(liveText, incomingText)) {
    return incomingText;
  }

  if (liveText.includes(incomingText) && liveText.length > incomingText.length) {
    return liveText;
  }

  return incomingText.length >= liveText.length ? incomingText : liveText;
}

function mergeStreamingTextArray(incomingValues: string[], liveValues: string[]) {
  const nextValues = [...incomingValues];
  for (const [index, liveValue] of liveValues.entries()) {
    nextValues[index] = mergeLongerStreamingText(nextValues[index] ?? "", liveValue);
  }
  return nextValues;
}

function areStreamingTextsCompatible(left: string, right: string) {
  const normalizedLeft = normalizeStreamingText(left);
  const normalizedRight = normalizeStreamingText(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(normalizedRight)
    || normalizedRight.startsWith(normalizedLeft);
}

function areStreamingTextArraysCompatible(left: string[], right: string[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? "";
    const rightValue = right[index] ?? "";
    if (leftValue || rightValue) {
      if (!areStreamingTextsCompatible(leftValue, rightValue)) {
        return false;
      }
    }
  }

  return true;
}

function joinStreamingText(values: string[]) {
  return values.join("\n").trim();
}

function normalizeStreamingText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isEmptyRolloutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return normalizedMessage.includes(EMPTY_ROLLOUT_ERROR_FRAGMENT)
    && normalizedMessage.includes(EMPTY_ROLLOUT_ERROR_SUFFIX);
}

function isMissingRolloutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(MISSING_ROLLOUT_ERROR_FRAGMENT);
}

function isTransientRolloutReadError(error: unknown) {
  return isEmptyRolloutError(error) || isMissingRolloutError(error);
}

function WorkbenchThreadClient(
  options: WorkbenchThreadClientOptions = {},
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchThreadClient {
  const codexClient = new CodexAppServerClient();
  const listeners = new Set<WorkbenchThreadListener>();
  const rateLimitSnapshotEntriesByHarness = new Map<WorkbenchHarness, RateLimitSnapshotEntry>();
  const state = createInitialThreadState();
  const clientCreatedStreamingItemKeys = new Set<string>();
  const optimisticUserMessagesByTurnKey = new Map<string, OptimisticUserMessageEntry[]>();
  const threadUnreadRefreshInFlightKeys = new Set<string>();
  const latestTurnStartedAtByThreadKey = new Map<string, number>();
  let disposed = false;
  let rateLimitGeneration = 0;
  const refreshRateLimitsPromisesByHarness = new Map<WorkbenchHarness, Promise<void>>();
  let refreshThreadsPromise: Promise<void> | null = null;
  let workbenchLibraryInstructionsPromise: Promise<string | null> | null = null;

  state.threadUnreadStateByKey = new Map(Object.entries(readStoredThreadUnreadState()));

  function emitStatusMessage(message: string) {
    options.onStatusMessage?.(message);
  }

  function serializePendingUserInputRequests() {
    return Object.fromEntries(state.pendingUserInputRequestsByThreadId.entries());
  }

  function persistUnreadStateSnapshot() {
    persistThreadUnreadState(Object.fromEntries(state.threadUnreadStateByKey.entries()));
  }

  function buildThreadSummaryWithUnreadBadge(thread: ThreadSummary): ThreadSummary {
    const unreadState = state.threadUnreadStateByKey.get(getThreadStateKey(thread.harness, thread.id));
    const hasActiveTurn = isThreadStatusActive(thread.status);
    if (!unreadState) {
      return hasActiveTurn
        ? {
          ...thread,
          unreadBadge: {
            unreadCount: 0,
            hasActiveTurn: true,
          },
        }
        : thread;
    }

    const unreadCount = countUnreadThreadItems(unreadState);
    if (!hasActiveTurn && unreadCount === 0) {
      return thread.unreadBadge ? { ...thread, unreadBadge: null } : thread;
    }

    const unreadBadge = {
      unreadCount,
      hasActiveTurn,
    };

    return thread.unreadBadge?.unreadCount === unreadBadge.unreadCount
      && thread.unreadBadge.hasActiveTurn === unreadBadge.hasActiveTurn
      ? thread
      : {
        ...thread,
        unreadBadge,
      };
  }

  function updateStoredThreadUnreadState(
    thread: Pick<ThreadSummary, "id" | "harness" | "status" | "updatedAt">,
    observedItemIds: string[],
    { markSeen = false, seedSeenIfMissing = false }: { markSeen?: boolean; seedSeenIfMissing?: boolean } = {},
  ) {
    const key = getThreadStateKey(thread.harness, thread.id);
    const previous = state.threadUnreadStateByKey.get(key);
    const lastObservedItemId = observedItemIds.at(-1) ?? null;
    const lastSeenItemId = markSeen
      ? lastObservedItemId
      : previous
        ? previous.lastSeenItemId
        : seedSeenIfMissing
          ? lastObservedItemId
          : null;

    const nextState: WorkbenchStoredThreadUnreadState = {
      lastObservedStatus: thread.status,
      lastObservedUpdatedAt: thread.updatedAt,
      lastSeenItemId,
      observedItemIds,
    };

    if (
      previous
      && previous.lastObservedStatus === nextState.lastObservedStatus
      && previous.lastObservedUpdatedAt === nextState.lastObservedUpdatedAt
      && previous.lastSeenItemId === nextState.lastSeenItemId
      && previous.observedItemIds.length === nextState.observedItemIds.length
      && previous.observedItemIds.every((itemId, index) => itemId === nextState.observedItemIds[index])
    ) {
      return false;
    }

    state.threadUnreadStateByKey.set(key, nextState);
    persistUnreadStateSnapshot();
    return true;
  }

  async function refreshThreadUnreadState(thread: ThreadSummary) {
    const key = getThreadStateKey(thread.harness, thread.id);
    if (threadUnreadRefreshInFlightKeys.has(key)) {
      return false;
    }

    threadUnreadRefreshInFlightKeys.add(key);
    try {
      const response = await sendBridgeRequest<ThreadReadResponse>(thread.harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId: thread.id,
        },
      });

      if (state.projectRootPath && !isProjectCodexThread(response.thread, state.projectRootPath)) {
        return false;
      }

      if (state.currentThread?.id === thread.id && state.currentThread.harness === thread.harness) {
        return false;
      }

      return updateStoredThreadUnreadState(
        toThreadSummary(response.thread, thread.harness),
        getThreadItemIds(response.thread.turns),
        { seedSeenIfMissing: true },
      );
    } catch {
      return false;
    } finally {
      threadUnreadRefreshInFlightKeys.delete(key);
    }
  }

  function shouldRefreshThreadUnreadState(thread: ThreadSummary) {
    if (state.currentThread?.id === thread.id && state.currentThread.harness === thread.harness) {
      return false;
    }

    const unreadState = state.threadUnreadStateByKey.get(getThreadStateKey(thread.harness, thread.id));
    if (!unreadState) {
      return isThreadStatusActive(thread.status);
    }

    return unreadState.lastObservedUpdatedAt !== thread.updatedAt
      || unreadState.lastObservedStatus !== thread.status;
  }

  async function refreshVisibleThreadUnreadStates(threads: ThreadSummary[]) {
    const threadsToRefresh = threads.filter(shouldRefreshThreadUnreadState);
    if (!threadsToRefresh.length) {
      return;
    }

    const results = await Promise.allSettled(threadsToRefresh.map((thread) => refreshThreadUnreadState(thread)));
    if (results.some((result) => result.status === "fulfilled" && result.value)) {
      state.threads = state.threads.map(buildThreadSummaryWithUnreadBadge);
      emit();
    }
  }

  function getSnapshot(): WorkbenchThreadSnapshot {
    return {
      currentThread: state.currentThread,
      currentThreadId: state.currentThreadId,
      pendingUserInputRequestsByThreadId: serializePendingUserInputRequests(),
      rateLimits: state.rateLimits,
      threads: state.threads.map(buildThreadSummaryWithUnreadBadge),
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

  function setProjectContext(context: { projectId?: string; root: string; rootPath: string }) {
    if (state.projectId === (context.projectId ?? "") && state.projectRoot === context.root && state.projectRootPath === context.rootPath) {
      return;
    }

    state.projectId = context.projectId ?? "";
    state.projectRoot = context.root;
    state.projectRootPath = context.rootPath;
  }

  function applyPersistedQuestionnaireHistory(thread: ThreadPayload | null) {
    if (!thread || thread.harness !== "codex") {
      return thread;
    }

    return applyQuestionnaireHistoryToThread(
      thread,
      state.questionnaireHistoryByThreadId.get(thread.id) ?? [],
    );
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

  function areTurnListsEquivalent(leftTurns: Turn[], rightTurns: Turn[]) {
    if (leftTurns.length !== rightTurns.length) {
      return false;
    }

    return leftTurns.every((leftTurn, index) => {
      const rightTurn = rightTurns[index];
      return !!rightTurn
        && leftTurn.id === rightTurn.id
        && leftTurn.status === rightTurn.status
        && leftTurn.itemsView === rightTurn.itemsView
        && getTurnRenderSignature(leftTurn) === getTurnRenderSignature(rightTurn);
    });
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
      && left.serviceTier === right.serviceTier
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
      && left.forkedFromId === right.forkedFromId
      && left.agentNickname === right.agentNickname
      && left.agentRole === right.agentRole
      && areTurnListsEquivalent(left.turns, right.turns)
      && areCurrentTurnsEquivalent(left, right);
  }

  function mergeStableThreadMetadata(thread: ThreadPayload | null) {
    if (!thread || state.currentThread?.id !== thread.id || state.currentThread.harness !== thread.harness) {
      return thread;
    }

    const currentThread = state.currentThread;
    return {
      ...thread,
      agentNickname: thread.agentNickname ?? currentThread.agentNickname,
      agentPath: thread.agentPath ?? currentThread.agentPath,
      agentRole: thread.agentRole ?? currentThread.agentRole,
      model: thread.model ?? currentThread.model,
      name: thread.name ?? currentThread.name,
      reasoningEffort: thread.reasoningEffort ?? currentThread.reasoningEffort,
      serviceTier: thread.serviceTier,
    };
  }

  function setRateLimits(rateLimits: RateLimitSnapshot | null) {
    if (state.rateLimits === rateLimits) {
      return;
    }

    state.rateLimits = rateLimits;
    emit();
  }

  function setHarnessRateLimits(
    harness: WorkbenchHarness,
    rateLimits: RateLimitSnapshot | null,
    {
      generation = ++rateLimitGeneration,
      source,
    }: {
      generation?: number;
      source: RateLimitSnapshotSource;
    },
  ) {
    const previousEntry = rateLimitSnapshotEntriesByHarness.get(harness);
    if (previousEntry && generation < previousEntry.generation) {
      return false;
    }

    if (source === "read" && previousEntry && generation === previousEntry.generation && previousEntry.source === "notification") {
      return false;
    }

    if (isRegressiveRateLimitSnapshot(previousEntry?.snapshot ?? null, rateLimits)) {
      return false;
    }

    rateLimitSnapshotEntriesByHarness.set(harness, {
      generation,
      receivedAt: Date.now(),
      snapshot: rateLimits,
      source,
    });
    state.rateLimitsByHarness.set(harness, rateLimits);
    if (state.currentThread?.harness === harness) {
      setRateLimits(rateLimits);
    }
    return true;
  }

  function markThreadPayloadSeen(thread: ThreadPayload) {
    rememberLatestTurnStartedAt(thread);
    return updateStoredThreadUnreadState(thread, getThreadItemIds(thread.turns), { markSeen: true });
  }

  function markThreadSeen(thread: ThreadPayload) {
    if (!markThreadPayloadSeen(thread)) {
      return;
    }

    state.threads = state.threads.map(buildThreadSummaryWithUnreadBadge);
    emit();
  }

  function scheduleActiveTurnRateLimitRefresh() {
    const harness = state.currentThread?.harness;
    if (!harness || !getCurrentInProgressTurn(state.currentThread)) {
      lifecycle.cancel(RATE_LIMIT_REFRESH_TASK_ID);
      return;
    }

    if (lifecycle.has(RATE_LIMIT_REFRESH_TASK_ID)) {
      return;
    }

    void refreshRateLimits(harness);

    lifecycle.scheduleRepeat(RATE_LIMIT_REFRESH_TASK_ID, ACTIVE_TURN_RATE_LIMIT_REFRESH_INTERVAL_MS, () => {
      if (disposed || state.currentThread?.harness !== harness || !getCurrentInProgressTurn(state.currentThread)) {
        lifecycle.cancel(RATE_LIMIT_REFRESH_TASK_ID);
        return;
      }

      return refreshRateLimits(harness);
    });
  }

  function rememberLatestTurnStartedAt(thread: ThreadPayload) {
    const latestStartedAt = getLatestTurnStartedAt(thread.turns);
    const key = getThreadStateKey(thread.harness, thread.id);
    if (latestStartedAt === null) {
      latestTurnStartedAtByThreadKey.delete(key);
      return;
    }

    latestTurnStartedAtByThreadKey.set(key, latestStartedAt);
  }

  function getThreadStableVisibleSortTimestamp(thread: ThreadSummary) {
    return latestTurnStartedAtByThreadKey.get(getThreadStateKey(thread.harness, thread.id))
      ?? thread.createdAt
      ?? thread.updatedAt;
  }

  async function refreshLatestTurnStartedAt(thread: ThreadSummary) {
    try {
      const response = await sendBridgeRequest<ThreadReadResponse>(thread.harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId: thread.id,
        },
      });

      if (state.projectRootPath && !isProjectCodexThread(response.thread, state.projectRootPath)) {
        return;
      }

      const latestStartedAt = getLatestTurnStartedAt(response.thread.turns);
      const key = getThreadStateKey(thread.harness, thread.id);
      if (latestStartedAt === null) {
        latestTurnStartedAtByThreadKey.delete(key);
        return;
      }

      latestTurnStartedAtByThreadKey.set(key, latestStartedAt);
    } catch {
      // Keep the previous stable ordering key if a best-effort metadata read fails.
    }
  }

  async function hydrateVisibleThreadStableSortKeys(threads: ThreadSummary[]) {
    await Promise.all(threads.map((thread) => refreshLatestTurnStartedAt(thread)));
  }

  function setCurrentThread(
    thread: ThreadPayload | null,
    {
      pruneStreamingDuplicates = true,
    }: {
      pruneStreamingDuplicates?: boolean;
    } = {},
  ) {
    const stableThread = mergeStableThreadMetadata(thread);
    const nextThread = pruneStreamingDuplicates
      ? pruneThreadStreamingDuplicates(applyOptimisticUserMessageOverlay(applyPersistedQuestionnaireHistory(stableThread)))
      : applyOptimisticUserMessageOverlay(applyPersistedQuestionnaireHistory(stableThread));
    const unreadStateChanged = nextThread ? markThreadPayloadSeen(nextThread) : false;
    if (areThreadPayloadsEquivalent(state.currentThread, nextThread)) {
      if (unreadStateChanged) {
        state.threads = state.threads.map(buildThreadSummaryWithUnreadBadge);
        emit();
      }
      return;
    }

    const previousThread = state.currentThread;
    if (!previousThread || !nextThread || previousThread.id !== nextThread.id || previousThread.harness !== nextThread.harness) {
      clientCreatedStreamingItemKeys.clear();
    }
    state.currentThread = nextThread;
    state.currentThreadId = nextThread?.id ?? "";
    emit();
    scheduleActiveTurnRateLimitRefresh();

    if (!nextThread) {
      setRateLimits(null);
      return;
    }

    if (!previousThread || previousThread.id !== nextThread.id || previousThread.harness !== nextThread.harness) {
      setRateLimits(null);
      void refreshRateLimits(nextThread.harness);
    }
  }

  function updateCurrentThread(
    updater: (thread: ThreadPayload) => ThreadPayload | null,
    options: {
      pruneStreamingDuplicates?: boolean;
    } = {},
  ) {
    if (!state.currentThread) {
      return false;
    }

    const nextThread = updater(state.currentThread);
    if (!nextThread) {
      return false;
    }

    setCurrentThread(nextThread, options);
    return true;
  }

  function updateCurrentThreadFields(fields: Partial<Omit<ThreadPayload, "turns">>) {
    return updateCurrentThread((thread) => ({
      ...thread,
      ...fields,
      agentNickname: fields.agentNickname ?? thread.agentNickname,
      agentPath: fields.agentPath ?? thread.agentPath,
      agentRole: fields.agentRole ?? thread.agentRole,
      model: fields.model ?? thread.model,
      name: fields.name ?? thread.name,
      reasoningEffort: fields.reasoningEffort ?? thread.reasoningEffort,
      serviceTier: fields.serviceTier ?? thread.serviceTier,
    }));
  }

  function mergeLiveStreamingItem(incomingItem: ThreadItem, liveItem: ThreadItem) {
    if (incomingItem.type === "agentMessage" && liveItem.type === "agentMessage") {
      return {
        ...incomingItem,
        text: mergeLongerStreamingText(incomingItem.text, liveItem.text),
      };
    }

    if (incomingItem.type === "reasoning" && liveItem.type === "reasoning") {
      return {
        ...incomingItem,
        content: mergeStreamingTextArray(incomingItem.content, liveItem.content),
        summary: mergeStreamingTextArray(incomingItem.summary, liveItem.summary),
      };
    }

    if (incomingItem.type === "plan" && liveItem.type === "plan") {
      return {
        ...incomingItem,
        text: mergeLongerStreamingText(incomingItem.text, liveItem.text),
      };
    }

    return incomingItem;
  }

  function getThreadStateChangeTagText(item: ThreadItem) {
    if (item.type !== "agentMessage") {
      return null;
    }

    return getNormalizedThreadStateChangeTagText(normalizeStreamingText(item.text));
  }

  function isThreadStateChangeLikeAgentMessage(item: ThreadItem) {
    return item.type === "agentMessage"
      && normalizeStreamingText(item.text).startsWith("<set-state");
  }

  function areThreadStateChangeItemsCompatible(left: ThreadItem, right: ThreadItem) {
    const leftTag = getThreadStateChangeTagText(left);
    const rightTag = getThreadStateChangeTagText(right);
    return leftTag !== null && rightTag !== null && leftTag === rightTag;
  }

  function isStructurallyMatchingStreamingItem(incomingItem: ThreadItem, liveItem: ThreadItem) {
    if (incomingItem.type === "agentMessage" && liveItem.type === "agentMessage") {
      if (isThreadStateChangeLikeAgentMessage(incomingItem) || isThreadStateChangeLikeAgentMessage(liveItem)) {
        return areThreadStateChangeItemsCompatible(incomingItem, liveItem);
      }

      return areStreamingTextsCompatible(incomingItem.text, liveItem.text);
    }

    if (incomingItem.type === "reasoning" && liveItem.type === "reasoning") {
      const incomingText = joinStreamingText([...incomingItem.content, ...incomingItem.summary]);
      const liveText = joinStreamingText([...liveItem.content, ...liveItem.summary]);
      if (incomingText || liveText) {
        return areStreamingTextsCompatible(incomingText, liveText);
      }

      return areStreamingTextArraysCompatible(incomingItem.content, liveItem.content)
        && areStreamingTextArraysCompatible(incomingItem.summary, liveItem.summary);
    }

    if (incomingItem.type === "plan" && liveItem.type === "plan") {
      return areStreamingTextsCompatible(incomingItem.text, liveItem.text);
    }

    return false;
  }

  function getStreamingItemText(item: ThreadItem) {
    switch (item.type) {
      case "agentMessage":
        return normalizeStreamingText(item.text);
      case "reasoning":
        return normalizeStreamingText(joinStreamingText([...item.content, ...item.summary]));
      case "plan":
        return normalizeStreamingText(item.text);
      default:
        return "";
    }
  }

  function getStreamingItemDedupeKind(item: ThreadItem) {
    switch (item.type) {
      case "agentMessage":
      case "reasoning":
      case "plan":
        return item.type;
      default:
        return null;
    }
  }

  function forgetReplacedStreamingItem(turnId: string, clientItemId: string, canonicalItemId: string) {
    const clientKey = getThreadItemKey(turnId, clientItemId);
    const canonicalKey = getThreadItemKey(turnId, canonicalItemId);
    if (clientKey === canonicalKey) {
      clientCreatedStreamingItemKeys.delete(clientKey);
      return;
    }

    clientCreatedStreamingItemKeys.delete(clientKey);
  }

  function forgetStreamingItemKey(turnId: string, itemId: string) {
    const itemKey = getThreadItemKey(turnId, itemId);
    clientCreatedStreamingItemKeys.delete(itemKey);
  }

  function shouldPreferIncomingStreamingItem(turnId: string, incomingItem: ThreadItem, existingItem: ThreadItem) {
    const incomingKey = getThreadItemKey(turnId, incomingItem.id);
    const existingKey = getThreadItemKey(turnId, existingItem.id);
    const incomingIsClientCreated = clientCreatedStreamingItemKeys.has(incomingKey);
    const existingIsClientCreated = clientCreatedStreamingItemKeys.has(existingKey);
    if (incomingIsClientCreated !== existingIsClientCreated) {
      return existingIsClientCreated;
    }

    return getStreamingItemText(incomingItem).length >= getStreamingItemText(existingItem).length;
  }

  function canPruneDuplicateStreamingItems(turnId: string, item: ThreadItem, candidate: ThreadItem) {
    if (isThreadStateChangeLikeAgentMessage(item) || isThreadStateChangeLikeAgentMessage(candidate)) {
      const itemKey = getThreadItemKey(turnId, item.id);
      const candidateKey = getThreadItemKey(turnId, candidate.id);
      return clientCreatedStreamingItemKeys.has(itemKey) !== clientCreatedStreamingItemKeys.has(candidateKey)
        && isStructurallyMatchingStreamingItem(item, candidate);
    }

    return isStructurallyMatchingStreamingItem(item, candidate);
  }

  function pruneDuplicateStreamingItems(turnId: string, items: ThreadItem[]) {
    const nextItems: ThreadItem[] = [];
    let changed = false;

    for (const item of items) {
      const kind = getStreamingItemDedupeKind(item);
      const text = getStreamingItemText(item);
      if (!kind || !text) {
        nextItems.push(item);
        continue;
      }

      const existingIndex = nextItems.findIndex((candidate) => (
        getStreamingItemDedupeKind(candidate) === kind
        && canPruneDuplicateStreamingItems(turnId, item, candidate)
      ));

      if (existingIndex === -1) {
        nextItems.push(item);
        continue;
      }

      changed = true;
      const existingItem = nextItems[existingIndex];
      if (shouldPreferIncomingStreamingItem(turnId, item, existingItem)) {
        forgetReplacedStreamingItem(turnId, existingItem.id, item.id);
        nextItems[existingIndex] = mergeLiveStreamingItem(item, existingItem);
      } else {
        forgetReplacedStreamingItem(turnId, item.id, existingItem.id);
      }
    }

    return changed ? nextItems : items;
  }

  function pruneThreadStreamingDuplicates(thread: ThreadPayload | null) {
    if (!thread) {
      return null;
    }

    let changed = false;
    const turns = thread.turns.map((turn) => {
      const nextItems = pruneDuplicateStreamingItems(turn.id, turn.items);
      if (nextItems === turn.items) {
        return turn;
      }

      changed = true;
      return {
        ...turn,
        items: nextItems,
      };
    });

    return changed ? { ...thread, turns } : thread;
  }

  function getOptimisticTurnKey(harness: WorkbenchHarness, threadId: string, turnId: string) {
    return `${harness}:${threadId}:${turnId}`;
  }

  function isOptimisticUserMessageItem(item: ThreadItem) {
    return item.type === "userMessage" && item.id.startsWith("optimistic-user-message:");
  }

  function enqueueOptimisticUserMessage(
    harness: WorkbenchHarness,
    threadId: string,
    turnId: string,
    input: UserInput[],
  ) {
    const turnKey = getOptimisticTurnKey(harness, threadId, turnId);
    const entry: OptimisticUserMessageEntry = {
      createdAt: Date.now(),
      input: input.map((item) => cloneUserInput(item)),
      item: createOptimisticUserMessage(input),
    };
    optimisticUserMessagesByTurnKey.set(turnKey, [
      ...(optimisticUserMessagesByTurnKey.get(turnKey) ?? []),
      entry,
    ]);
    return entry.item;
  }

  function countCanonicalUserMessageMatches(items: ThreadItem[], input: UserInput[]) {
    return items.filter((item) => !isOptimisticUserMessageItem(item) && doesUserMessageMatchInput(item, input)).length;
  }

  function getOptimisticUserMessageInsertIndex(items: ThreadItem[]) {
    let insertIndex = 0;
    while (items[insertIndex]?.type === "userMessage") {
      insertIndex += 1;
    }
    return insertIndex;
  }

  function insertOptimisticUserMessageItems(
    items: ThreadItem[],
    optimisticItems: Array<Extract<ThreadItem, { type: "userMessage" }>>,
  ) {
    if (!optimisticItems.length) {
      return items;
    }

    const insertIndex = getOptimisticUserMessageInsertIndex(items);
    return [
      ...items.slice(0, insertIndex),
      ...optimisticItems,
      ...items.slice(insertIndex),
    ];
  }

  function applyOptimisticUserMessagesToTurn(
    thread: Pick<ThreadPayload, "harness" | "id">,
    turn: Turn,
  ): Turn {
    const entries = optimisticUserMessagesByTurnKey.get(getOptimisticTurnKey(thread.harness, thread.id, turn.id));
    if (!entries?.length) {
      return turn;
    }

    const canonicalItems = turn.items.filter((item) => !isOptimisticUserMessageItem(item));
    const visibleEntries: OptimisticUserMessageEntry[] = [];
    for (const [index, entry] of entries.entries()) {
      const matchingEntriesThroughCurrent = entries
        .slice(0, index + 1)
        .filter((candidate) => JSON.stringify(candidate.input) === JSON.stringify(entry.input))
        .length;
      if (countCanonicalUserMessageMatches(canonicalItems, entry.input) < matchingEntriesThroughCurrent) {
        visibleEntries.push(entry);
      }
    }

    if (!visibleEntries.length) {
      return turn.items.length === canonicalItems.length
        ? turn
        : { ...turn, items: canonicalItems };
    }

    return {
      ...turn,
      items: insertOptimisticUserMessageItems(canonicalItems, visibleEntries.map((entry) => entry.item)),
    };
  }

  function applyOptimisticUserMessageOverlay(thread: ThreadPayload | null) {
    if (!thread) {
      return null;
    }

    let changed = false;
    const turns = thread.turns.map((turn) => {
      const nextTurn = applyOptimisticUserMessagesToTurn(thread, turn);
      if (nextTurn !== turn) {
        changed = true;
      }
      return nextTurn;
    });

    return changed ? { ...thread, turns } : thread;
  }

  function shouldPreserveUnmatchedLiveTurnItems(incomingTurn: Turn, liveTurn: Turn) {
    if (!liveTurn.items.length) {
      return false;
    }

    if (incomingTurn.itemsView !== "full") {
      return true;
    }

    return incomingTurn.status === "inProgress"
      && liveTurn.status === "inProgress"
      && incomingTurn.items.length < liveTurn.items.length;
  }

  function isToolLikeThreadItem(item: ThreadItem) {
    return item.type === "commandExecution"
      || item.type === "dynamicToolCall"
      || item.type === "mcpToolCall"
      || item.type === "fileChange"
      || item.type === "collabAgentToolCall";
  }

  function shouldPreserveUnmatchedLiveItem(
    incomingTurn: Turn,
    liveTurn: Turn,
    liveItem: ThreadItem,
    preserveAllUnmatchedLiveItems: boolean,
    preserveToolItemsFromThinnerTurn: boolean,
  ) {
    if (preserveAllUnmatchedLiveItems) {
      return true;
    }

    if (preserveToolItemsFromThinnerTurn && isToolLikeThreadItem(liveItem)) {
      return true;
    }

    return incomingTurn.status === "inProgress"
      && liveTurn.status === "inProgress"
      && (liveItem.type === "agentMessage" || liveItem.type === "reasoning" || liveItem.type === "plan");
  }

  function mergeLiveStreamingTurn(incomingTurn: Turn, liveTurn: Turn | undefined) {
    if (!liveTurn) {
      return incomingTurn;
    }

    const liveItemsById = new Map(liveTurn.items.map((item) => [item.id, item]));
    const preserveAllUnmatchedLiveItems = shouldPreserveUnmatchedLiveTurnItems(incomingTurn, liveTurn);
    const preserveToolItemsFromThinnerTurn = incomingTurn.itemsView === "full"
      && incomingTurn.items.length < liveTurn.items.length;
    const nextItems = incomingTurn.items.map((item) => {
      const liveItem = liveItemsById.get(item.id);
      let matchedLiveItem: ThreadItem | null = null;
      if (!liveItem) {
        for (const [liveItemId, candidateLiveItem] of liveItemsById) {
          if (
            clientCreatedStreamingItemKeys.has(getThreadItemKey(incomingTurn.id, liveItemId))
            && isStructurallyMatchingStreamingItem(item, candidateLiveItem)
          ) {
            matchedLiveItem = candidateLiveItem;
            liveItemsById.delete(liveItemId);
            forgetReplacedStreamingItem(incomingTurn.id, liveItemId, item.id);
            break;
          }
        }
        return matchedLiveItem ? mergeLiveStreamingItem(item, matchedLiveItem) : item;
      }

      liveItemsById.delete(item.id);
      forgetStreamingItemKey(incomingTurn.id, item.id);
      return mergeLiveStreamingItem(item, liveItem);
    });

    for (const liveItem of liveItemsById.values()) {
      if (shouldPreserveUnmatchedLiveItem(incomingTurn, liveTurn, liveItem, preserveAllUnmatchedLiveItems, preserveToolItemsFromThinnerTurn)) {
        nextItems.push(liveItem);
      }
    }

    return {
      ...incomingTurn,
      items: pruneDuplicateStreamingItems(incomingTurn.id, nextItems),
    };
  }

  function mergeLiveStreamingThreadSnapshot(incomingThread: ThreadPayload) {
    const liveThread = state.currentThread;
    if (!liveThread || liveThread.id !== incomingThread.id || liveThread.harness !== incomingThread.harness) {
      return incomingThread;
    }

    const liveTurnsById = new Map(liveThread.turns.map((turn) => [turn.id, turn]));
    return {
      ...incomingThread,
      turns: incomingThread.turns.map((turn) => mergeLiveStreamingTurn(turn, liveTurnsById.get(turn.id))),
    };
  }

  async function sendBridgeRequest<TResponse>(
    harness: WorkbenchHarness,
    request: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
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

  function upsertPendingUserInputRequest(
    threadId: string,
    harness: WorkbenchHarness,
    requestKey: string,
    request: WorkbenchUserInputRequest,
    {
      itemId = null,
      turnId = null,
    }: {
      itemId?: string | null;
      turnId?: string | null;
    } = {},
  ) {
    const existing = state.pendingUserInputRequestsByThreadId.get(threadId);
    if (
      existing?.requestKey === requestKey
      && existing.harness === harness
      && existing.turnId === turnId
      && existing.itemId === itemId
      && JSON.stringify(existing.request) === JSON.stringify(request)
    ) {
      return false;
    }

    state.pendingUserInputRequestsByThreadId.set(threadId, {
      harness,
      itemId,
      request,
      requestKey,
      threadId,
      turnId,
    });
    return true;
  }

  function clearPendingUserInputRequest(threadId: string, requestKey?: string) {
    const existing = state.pendingUserInputRequestsByThreadId.get(threadId);
    if (!existing) {
      return false;
    }

    if (requestKey && existing.requestKey !== requestKey) {
      return false;
    }

    state.pendingUserInputRequestsByThreadId.delete(threadId);
    return true;
  }

  function clearThreadWaitingOnUserInputFlag(threadId: string) {
    let changed = false;
    if (state.currentThread?.id === threadId) {
      const nextStatus = removeThreadActiveFlag(state.currentThread.status, "waitingOnUserInput");
      if (nextStatus !== state.currentThread.status) {
        state.currentThread = {
          ...state.currentThread,
          status: nextStatus,
        };
        changed = true;
      }
    }

    state.threads = state.threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }

      const nextStatus = removeThreadActiveFlag(thread.status, "waitingOnUserInput");
      if (nextStatus === thread.status) {
        return thread;
      }

      changed = true;
      return buildThreadSummaryWithUnreadBadge({
        ...thread,
        status: nextStatus,
      });
    });

    return changed;
  }

  function replacePendingUserInputRequests(
    harness: WorkbenchHarness,
    requests: WorkbenchPendingUserInputRequest[],
  ) {
    const nextRequests = new Map(
      Array.from(state.pendingUserInputRequestsByThreadId.entries()).filter(([, entry]) => entry.harness !== harness),
    );
    for (const request of requests) {
      nextRequests.set(request.threadId, request);
    }

    if (nextRequests.size === state.pendingUserInputRequestsByThreadId.size) {
      let unchanged = true;
      for (const [threadId, request] of nextRequests) {
        const existing = state.pendingUserInputRequestsByThreadId.get(threadId);
        if (
          !existing
          || existing.requestKey !== request.requestKey
          || existing.harness !== request.harness
          || existing.turnId !== request.turnId
          || existing.itemId !== request.itemId
          || JSON.stringify(existing.request) !== JSON.stringify(request.request)
        ) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        return false;
      }
    }

    state.pendingUserInputRequestsByThreadId = nextRequests;
    return true;
  }

  function createDraftThreadId() {
    return DRAFT_THREAD_ID;
  }

  function isDraftThreadId(threadId: string) {
    return threadId === DRAFT_THREAD_ID || threadId.startsWith(DRAFT_THREAD_ID_PREFIX);
  }

  function createDraftThread(harness: WorkbenchHarness, threadId = createDraftThreadId()): ThreadPayload {
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const model = readStoredHarnessModel(harness);

    return {
      id: threadId,
      harness,
      model,
      reasoningEffort: readStoredHarnessModelEffort(harness, model),
      serviceTier: harness === "codex" ? readStoredHarnessServiceTier(harness) : null,
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
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    unreadBadge: null,
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

  function getThreadServiceTier(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return state.currentThread.serviceTier;
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
    const serviceTierIds = new Set([
      ...model.additionalSpeedTiers,
      ...model.serviceTiers.map((tier) => tier.id),
    ]);

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
      supportsFastMode: serviceTierIds.has("fast"),
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

  function setQuestionnaireHistoryEntries(threadId: string, entries: WorkbenchQuestionnaireHistoryEntry[]) {
    const nextEntries = entries.filter((entry) => entry.threadId === threadId);
    const existingEntries = state.questionnaireHistoryByThreadId.get(threadId) ?? [];
    if (JSON.stringify(existingEntries) === JSON.stringify(nextEntries)) {
      return false;
    }

    if (nextEntries.length) {
      state.questionnaireHistoryByThreadId.set(threadId, nextEntries);
    } else {
      state.questionnaireHistoryByThreadId.delete(threadId);
    }
    return true;
  }

  function reapplyCurrentThreadQuestionnaireHistory(threadId: string) {
    if (state.currentThread?.id !== threadId || state.currentThread.harness !== "codex") {
      return;
    }

    setCurrentThread(state.currentThread);
  }

  async function readCompletedQuestionnaireHistory(threadId: string) {
    try {
      const response = await sendBridgeRequest<{ data?: WorkbenchQuestionnaireHistoryEntry[] }>("codex", {
        method: "questionnaire/history/list",
        params: {
          threadId,
        },
      });
      const entries = response.data ?? [];
      if (setQuestionnaireHistoryEntries(threadId, entries)) {
        reapplyCurrentThreadQuestionnaireHistory(threadId);
      }
      return entries;
    } catch {
      if (setQuestionnaireHistoryEntries(threadId, [])) {
        reapplyCurrentThreadQuestionnaireHistory(threadId);
      }
      return [];
    }
  }

  async function readWorkbenchLibraryInstructions() {
    if (!workbenchLibraryInstructionsPromise) {
      workbenchLibraryInstructionsPromise = fetch("/api/workbench-library/skills", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) {
            return null;
          }

          const payload = await response.json() as { instructions?: string | null };
          return payload.instructions?.trim() ? payload.instructions : null;
        })
        .catch(() => null);
    }

    return await workbenchLibraryInstructionsPromise;
  }

  async function buildCodexDeveloperInstructions(
    threadId: string,
    agentPath: string | null,
  ) {
    const workbenchLibraryInstructions = await readWorkbenchLibraryInstructions();
    return buildCodexThreadBootstrapInstructions({
      agentPath,
      harness: "codex",
      routeUrl: null,
      threadId,
      workbenchLibraryInstructions,
    });
  }

  function buildCodexCollaborationBootstrapInstructions(threadId: string, routeUrl: string | null) {
    return routeUrl
      ? buildThreadTitleBootstrapInstructions({
        harness: "codex",
        routeUrl,
        threadId,
      })
      : null;
  }

  async function fetchThreadPayload(threadId: string, harness: WorkbenchHarness) {
    try {
      const selectedAgentPath = state.currentThread?.id === threadId
        ? state.currentThread.agentPath
        : readStoredHarnessAgent(harness);
      const workbenchOrigin = readLocalWorkbenchOrigin();
      let resumedThread: ThreadResumeResponse | null = null;

      if (harness === "codex") {
        const codexDeveloperInstructions = await buildCodexDeveloperInstructions(threadId, selectedAgentPath);
        try {
          resumedThread = await sendBridgeRequest<ThreadResumeResponse>(harness, {
            method: "thread/resume",
            params: {
              developerInstructions: codexDeveloperInstructions,
              threadId,
            } satisfies ThreadResumeParams,
          });
        } catch {
          resumedThread = null;
        }
      }

      const response = await sendBridgeRequest<ThreadReadResponse>(harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
          ...(state.projectId && harness === "copilot" ? { projectId: state.projectId } : {}),
          ...(state.projectRootPath && harness === "copilot" ? { cwd: state.projectRootPath } : {}),
          ...(workbenchOrigin && harness === "copilot" ? { workbenchOrigin } : {}),
          threadId,
        },
      });

      if (state.projectRootPath && !isProjectCodexThread(response.thread, state.projectRootPath)) {
        emitStatusMessage("That Codex thread doesn't belong to this project.");
        return null;
      }

      const nextModel = state.currentThread?.id === threadId
        ? getThreadModel(threadId)
        : resumedThread?.model ?? readStoredHarnessModel(harness);
      const nextServiceTier = harness === "codex"
        ? state.currentThread?.id === threadId
          ? getThreadServiceTier(threadId) ?? resumedThread?.serviceTier ?? readStoredHarnessServiceTier(harness)
          : resumedThread?.serviceTier ?? readStoredHarnessServiceTier(harness)
        : null;
      if (harness === "codex") {
        void readCompletedQuestionnaireHistory(threadId);
      }
      return mergeLiveStreamingThreadSnapshot(toThreadPayload(
        response.thread,
        harness,
        nextModel,
        state.currentThread?.id === threadId
          ? getThreadReasoningEffort(threadId) ?? readStoredHarnessModelEffort(harness, nextModel) ?? resumedThread?.reasoningEffort ?? null
          : readStoredHarnessModelEffort(harness, nextModel) ?? resumedThread?.reasoningEffort ?? null,
        nextServiceTier,
        selectedAgentPath,
      ));
    } catch (error) {
      if (harness === "codex" && isTransientRolloutReadError(error)) {
        emitStatusMessage(FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE);
        return null;
      }

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
      if (harness === "codex") {
        void readCompletedQuestionnaireHistory(threadId);
      }
      return mergeLiveStreamingThreadSnapshot(toThreadPayload(
        response.thread,
        harness,
        nextModel,
        getThreadReasoningEffort(threadId) ?? readStoredHarnessModelEffort(harness, nextModel),
        harness === "codex"
          ? getThreadServiceTier(threadId) ?? readStoredHarnessServiceTier(harness)
          : null,
        state.currentThread?.id === threadId
          ? state.currentThread.agentPath
          : readStoredHarnessAgent(harness),
      ));
    } catch (error) {
      if (harness === "codex" && isTransientRolloutReadError(error)) {
        emitStatusMessage(FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE);
        return null;
      }

      emitStatusMessage(error instanceof Error ? error.message : "Unable to read Codex thread.");
      return null;
    }
  }

  async function readThread(threadId: string, harness?: WorkbenchHarness) {
    return await fetchThreadPayload(threadId, harness ?? getThreadHarness(threadId));
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

        const threadsByRecentItem = threads.sort((left, right) => {
          if (right.updatedAt !== left.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }

          if (left.harness !== right.harness) {
            return left.harness.localeCompare(right.harness);
          }

          return left.id.localeCompare(right.id);
        });
        const visibleThreads = threadsByRecentItem.slice(0, STABLE_VISIBLE_THREAD_COUNT);
        await hydrateVisibleThreadStableSortKeys(visibleThreads);
        const stableVisibleThreads = visibleThreads.sort((left, right) => {
          const rightStableTimestamp = getThreadStableVisibleSortTimestamp(right);
          const leftStableTimestamp = getThreadStableVisibleSortTimestamp(left);
          if (rightStableTimestamp !== leftStableTimestamp) {
            return rightStableTimestamp - leftStableTimestamp;
          }

          if (right.updatedAt !== left.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }

          if (left.harness !== right.harness) {
            return left.harness.localeCompare(right.harness);
          }

          return left.id.localeCompare(right.id);
        });
        state.threads = [
          ...stableVisibleThreads,
          ...threadsByRecentItem.slice(STABLE_VISIBLE_THREAD_COUNT),
        ];
        void refreshVisibleThreadUnreadStates(state.threads);
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

  async function refreshRateLimits(harness = state.currentThread?.harness ?? "codex") {
    const existingRefresh = refreshRateLimitsPromisesByHarness.get(harness);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const readGeneration = ++rateLimitGeneration;
    const refreshPromise = (async () => {
      try {
        const response = await sendBridgeRequest<GetAccountRateLimitsResponse>(harness, {
          method: "account/rateLimits/read",
          params: undefined,
        });
        const previousSnapshot = rateLimitSnapshotEntriesByHarness.get(harness)?.snapshot ?? null;
        setHarnessRateLimits(harness, selectRateLimitSnapshot(response, harness, previousSnapshot), {
          generation: readGeneration,
          source: "read",
        });
      } catch {
        if (!state.rateLimitsByHarness.has(harness) && state.currentThread?.harness === harness) {
          setRateLimits(null);
        }
      } finally {
        refreshRateLimitsPromisesByHarness.delete(harness);
      }
    })();

    refreshRateLimitsPromisesByHarness.set(harness, refreshPromise);
    await refreshPromise;
  }

  async function refreshPendingUserInputRequests() {
    const questionnaireHarnesses = ["codex", "copilot"] as const;
    const results = await Promise.allSettled(questionnaireHarnesses.map(async (harness) => {
      const response = await sendBridgeRequest<{ data?: Array<{ itemId?: string | null; request: WorkbenchUserInputRequest; requestKey: string; threadId: string; turnId?: string | null }> }>(harness, {
        method: "questionnaire/list",
        params: undefined,
      });
      return {
        harness,
        pendingRequests: (response.data ?? []).map((entry) => ({
          harness,
          itemId: entry.itemId ?? null,
          request: entry.request,
          requestKey: entry.requestKey,
          threadId: entry.threadId,
          turnId: entry.turnId ?? null,
        })),
      };
    }));

    let changed = false;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        changed = replacePendingUserInputRequests(result.value.harness, result.value.pendingRequests) || changed;
        continue;
      }

      const rejectedHarness = questionnaireHarnesses[index] ?? "codex";
      changed = replacePendingUserInputRequests(rejectedHarness, []) || changed;
    }

    if (changed) {
      emit();
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

    const threadSummary = state.threads.find((thread) => thread.id === threadId);
    if (!threadSummary) {
      return false;
    }

    if (getCurrentInProgressTurn(currentThread)) {
      return currentThread.harness === threadSummary.harness
        && currentThread.status === threadSummary.status;
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
    {
      pruneStreamingDuplicates = true,
    }: {
      pruneStreamingDuplicates?: boolean;
    } = {},
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

        const prunedItems = pruneStreamingDuplicates
          ? pruneDuplicateStreamingItems(turn.id, nextItems)
          : nextItems;
        updated = true;
        return {
          ...turn,
          items: prunedItems,
        };
      });

      return updated ? { ...thread, turns } : null;
    }, { pruneStreamingDuplicates });
  }

  function upsertThreadItem(turnId: string, incomingItem: ThreadItem) {
    return updateTurnItems(turnId, (items) => {
      const itemIndex = items.findIndex((item) => item.id === incomingItem.id);
      if (itemIndex === -1) {
        let matchedClientItem: ThreadItem | null = null;
        const nextItems = items.filter((item) => {
          const itemKey = getThreadItemKey(turnId, item.id);
          if (!clientCreatedStreamingItemKeys.has(itemKey) || !isStructurallyMatchingStreamingItem(incomingItem, item)) {
            return true;
          }

          matchedClientItem = item;
          forgetReplacedStreamingItem(turnId, item.id, incomingItem.id);
          return false;
        });
        return [...nextItems, matchedClientItem ? mergeLiveStreamingItem(incomingItem, matchedClientItem) : incomingItem];
      }

      forgetStreamingItemKey(turnId, incomingItem.id);
      return items.map((item, index) => (
        index === itemIndex ? mergeLiveStreamingItem(incomingItem, item) : item
      ));
    });
  }

  function createStreamingAgentMessageItem(itemId: string): Extract<ThreadItem, { type: "agentMessage" }> {
    return {
      type: "agentMessage",
      id: itemId,
      text: "",
      phase: "commentary",
      memoryCitation: null,
    };
  }

  function createStreamingReasoningItem(itemId: string): Extract<ThreadItem, { type: "reasoning" }> {
    return {
      type: "reasoning",
      id: itemId,
      summary: [],
      content: [],
    };
  }

  function createStreamingPlanItem(itemId: string): Extract<ThreadItem, { type: "plan" }> {
    return {
      type: "plan",
      id: itemId,
      text: "",
    };
  }

  function createStreamingTurn(turnId: string): Turn {
    return {
      id: turnId,
      items: [],
      status: "inProgress",
      error: null,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
      durationMs: null,
      itemsView: "full",
    };
  }

  function ensureTurnForStreamingDelta(turnId: string) {
    if (!state.currentThread || state.currentThread.turns.some((turn) => turn.id === turnId)) {
      return false;
    }

    return updateCurrentThread((thread) => ({
      ...thread,
      turns: [...thread.turns, createStreamingTurn(turnId)],
      status: isThreadStatusActive(thread.status) ? thread.status : "active",
    }));
  }

  function updateOrCreateThreadItem(
    turnId: string,
    itemId: string,
    createItem: () => ThreadItem,
    updater: (item: ThreadItem) => ThreadItem | null,
  ) {
    const itemKey = getThreadItemKey(turnId, itemId);
    ensureTurnForStreamingDelta(turnId);
    return updateTurnItems(turnId, (items) => {
      const itemIndex = items.findIndex((item) => item.id === itemId);
      if (itemIndex === -1) {
        const nextItem = updater(createItem());
        if (!nextItem) {
          return null;
        }

        clientCreatedStreamingItemKeys.add(itemKey);
        return [...items, nextItem];
      }

      let updated = false;
      const nextItems = items.map((item, index) => {
        if (index !== itemIndex) {
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
    }, { pruneStreamingDuplicates: false });
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
        return updateOrCreateThreadItem(notification.params.turnId, notification.params.itemId, () => createStreamingAgentMessageItem(notification.params.itemId), (item) => (
          item.type === "agentMessage"
            ? { ...item, text: `${item.text}${notification.params.delta}` }
            : null
        ));
      case "item/plan/delta":
        return updateOrCreateThreadItem(notification.params.turnId, notification.params.itemId, () => createStreamingPlanItem(notification.params.itemId), (item) => (
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
        return updateOrCreateThreadItem(notification.params.turnId, notification.params.itemId, () => createStreamingReasoningItem(notification.params.itemId), (item) => (
          item.type === "reasoning"
            ? { ...item, summary: ensureIndexedText(item.summary, notification.params.summaryIndex) }
            : null
        ));
      case "item/reasoning/summaryTextDelta":
        return updateOrCreateThreadItem(notification.params.turnId, notification.params.itemId, () => createStreamingReasoningItem(notification.params.itemId), (item) => (
          item.type === "reasoning"
            ? { ...item, summary: appendIndexedText(item.summary, notification.params.summaryIndex, notification.params.delta) }
            : null
        ));
      case "item/reasoning/textDelta":
        return updateOrCreateThreadItem(notification.params.turnId, notification.params.itemId, () => createStreamingReasoningItem(notification.params.itemId), (item) => (
          item.type === "reasoning"
            ? { ...item, content: appendIndexedText(item.content, notification.params.contentIndex, notification.params.delta) }
            : null
        ));
      case "thread/archived":
      case "thread/unarchived":
      case "thread/closed":
      case "thread/goal/updated":
      case "thread/goal/cleared":
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
      case "questionnaire/requested":
      case "questionnaire/resolved":
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
      case "remoteControl/status/changed":
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
            items: insertOptimisticUserMessageItems(turn.items, [createOptimisticUserMessage(input)]),
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

  function selectThreadPayload(thread: ThreadPayload) {
    setCurrentThread(thread);
  }

  async function reconcileCurrentThreadFromRead(threadId: string, harness: WorkbenchHarness) {
    const payload = await readCurrentThread(threadId, harness);
    if (!payload || state.currentThreadId !== threadId) {
      return;
    }

    setCurrentThread(payload);
  }

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    sendOptions: WorkbenchSendThreadMessageOptions = {},
  ) {
    let resolvedThreadId = thread.id;
    let harness = thread.harness;
    const selectedModel = thread.model ?? (
      resolvedThreadId.trim()
        ? getThreadModel(resolvedThreadId)
        : state.currentThread?.model ?? readStoredHarnessModel(harness)
    );
    const selectedReasoningEffort = thread.reasoningEffort ?? (
      resolvedThreadId.trim()
        ? getThreadReasoningEffort(resolvedThreadId)
        : state.currentThread?.reasoningEffort ?? resolvePreferredReasoningEffort(harness, selectedModel)
    );
    const selectedServiceTier = harness === "codex"
      ? thread.serviceTier ?? (
        resolvedThreadId.trim()
          ? getThreadServiceTier(resolvedThreadId)
          : state.currentThread?.serviceTier ?? readStoredHarnessServiceTier(harness)
      )
      : null;
    const selectedAgentPath = thread.agentPath ?? (
      resolvedThreadId.trim()
        ? state.currentThread?.id === resolvedThreadId
          ? state.currentThread.agentPath
          : readStoredHarnessAgent(harness)
        : state.currentThread?.agentPath ?? readStoredHarnessAgent(harness)
    );
    const normalizedInput = normalizeThreadMessageInput(input);
    const workbenchOrigin = readLocalWorkbenchOrigin();
    const titleRouteUrl = workbenchOrigin ? buildThreadTitleRouteUrl(workbenchOrigin) : null;
    const isDraftThread = thread.isDraft;
    const shouldBypassCodexDraftBootstrap = harness === "codex" && isDraftThread;
    let previousThread = !thread.isDraft ? thread : null;
    let bootstrapThread: ThreadPayload | null = null;

    if (!normalizedInput.length) {
      throw new Error("Message input cannot be empty.");
    }

    if (isDraftThread || !resolvedThreadId.trim()) {
      const threadStartRequest = createThreadStartRequest(0, {
        ...(harness === "codex" && state.projectRootPath ? { cwd: state.projectRootPath } : {}),
        ...(harness === "codex"
          ? {
            developerInstructions: await buildCodexDeveloperInstructions(
              resolvedThreadId,
              selectedAgentPath,
            ),
          }
          : {}),
        ...(harness === "codex" ? { ephemeral: false } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(harness === "codex" ? { serviceTier: selectedServiceTier } : {}),
      });
      const startedThreadResponse = await sendBridgeRequest<CodexThreadSessionResponse>(harness, {
        method: threadStartRequest.method,
        params: harness === "copilot"
          ? {
            ...threadStartRequest.params,
            ...(selectedAgentPath ? { agentPath: selectedAgentPath } : {}),
            ...(state.projectId ? { projectId: state.projectId } : {}),
            ...(state.projectRootPath ? { cwd: state.projectRootPath } : {}),
            ...(workbenchOrigin ? { workbenchOrigin } : {}),
          } as typeof threadStartRequest.params & { agentPath?: string; cwd?: string; projectId?: string; workbenchOrigin?: string }
          : threadStartRequest.params,
      });

      const startedPayload = toThreadPayload(
        startedThreadResponse.thread,
        harness,
        startedThreadResponse.model ?? selectedModel ?? null,
        selectedReasoningEffort ?? startedThreadResponse.reasoningEffort ?? null,
        selectedServiceTier ?? startedThreadResponse.serviceTier ?? null,
        selectedAgentPath,
      );
      bootstrapThread = startedPayload;
      if (sendOptions.selectThread !== false) {
        setCurrentThread(bootstrapThread);
      }
      resolvedThreadId = bootstrapThread.id;
      previousThread = null;
      if (isDraftThread) {
        sendOptions.onThreadMaterialized?.(bootstrapThread);
      }
      if (!shouldBypassCodexDraftBootstrap) {
        await refreshThreads();
      }
    }

    const codexDeveloperInstructions = harness === "codex"
      ? await buildCodexDeveloperInstructions(resolvedThreadId, selectedAgentPath)
      : null;
    let resumedThread = bootstrapThread;
    if (!resumedThread || !shouldBypassCodexDraftBootstrap) {
      const readableThreadResponse = await sendBridgeRequest<ThreadReadResponse>(harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId: resolvedThreadId,
        },
      });
      const resumedThreadResponse = await sendBridgeRequest<CodexThreadSessionResponse>(harness, {
        method: "thread/resume",
          params: {
            ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
            ...(state.projectId && harness === "copilot" ? { projectId: state.projectId } : {}),
            ...(state.projectRootPath && harness === "copilot" ? { cwd: state.projectRootPath } : {}),
          ...(workbenchOrigin && harness === "copilot" ? { workbenchOrigin } : {}),
          ...(codexDeveloperInstructions && harness === "codex" ? { developerInstructions: codexDeveloperInstructions } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(harness === "codex" ? { serviceTier: selectedServiceTier } : {}),
          threadId: resolvedThreadId,
        } as ThreadResumeParams & { agentPath?: string; developerInstructions?: string; model?: string; serviceTier?: string | null; threadId: string; workbenchOrigin?: string },
      });
      const readableThread = toThreadPayload(readableThreadResponse.thread, harness);
      resumedThread = toThreadPayload(
        resumedThreadResponse.thread,
        harness,
        resumedThreadResponse.model ?? selectedModel ?? readableThread.model,
        selectedReasoningEffort ?? resumedThreadResponse.reasoningEffort ?? readableThread.reasoningEffort,
        selectedServiceTier ?? resumedThreadResponse.serviceTier ?? readableThread.serviceTier,
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
    }

    if (!resumedThread) {
      throw new Error("Unable to prepare the new Codex thread for its first turn.");
    }

    harness = resumedThread.harness;
    const currentInProgressTurn = getCurrentInProgressTurn(resumedThread);
    let optimisticTurnId: string | null = null;

    if (currentInProgressTurn) {
      const steerResponse = await sendBridgeRequest<TurnSteerResponse>(harness, {
        method: "turn/steer",
          params: {
            ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
            ...(state.projectId && harness === "copilot" ? { projectId: state.projectId } : {}),
            ...(state.projectRootPath && harness === "copilot" ? { cwd: state.projectRootPath } : {}),
            ...(workbenchOrigin && harness === "copilot" ? { workbenchOrigin } : {}),
          expectedTurnId: currentInProgressTurn.id,
          input: normalizedInput,
          threadId: resolvedThreadId,
        } as { agentPath?: string; expectedTurnId: string; input: UserInput[]; threadId: string; workbenchOrigin?: string },
      });
      optimisticTurnId = steerResponse.turnId || currentInProgressTurn.id;
      enqueueOptimisticUserMessage(harness, resolvedThreadId, optimisticTurnId, normalizedInput);
    } else {
      const codexCollaborationMode = harness === "codex"
        ? (() => {
          const collaborationModel = selectedModel ?? resumedThread.model;
          return collaborationModel
            ? createQuestionnaireCollaborationMode(
              collaborationModel,
              selectedReasoningEffort ?? null,
              buildCodexCollaborationBootstrapInstructions(resolvedThreadId, titleRouteUrl),
            )
            : null;
        })()
        : null;
      const turnStartResponse = await sendBridgeRequest<TurnStartResponse>(harness, {
        method: "turn/start",
        params: {
          ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
          ...(workbenchOrigin && harness === "copilot" ? { workbenchOrigin } : {}),
          ...(codexCollaborationMode ? { collaborationMode: codexCollaborationMode } : {}),
          input: normalizedInput,
          ...(selectedReasoningEffort ? { effort: selectedReasoningEffort } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(harness === "codex" ? { serviceTier: selectedServiceTier } : {}),
          summary: DEFAULT_TURN_REASONING_SUMMARY,
          threadId: resolvedThreadId,
        } as TurnStartParams & {
          agentPath?: string;
          collaborationMode?: ReturnType<typeof createQuestionnaireCollaborationMode>;
          workbenchOrigin?: string;
        },
      });
      optimisticTurnId = turnStartResponse.turn.id;
      enqueueOptimisticUserMessage(harness, resolvedThreadId, optimisticTurnId, normalizedInput);
      resumedThread = applyOptimisticUserMessageOverlay({
        ...resumedThread,
        status: isThreadStatusActive(resumedThread.status) ? resumedThread.status : "active",
        turns: resumedThread.turns.some((turn) => turn.id === turnStartResponse.turn.id)
          ? resumedThread.turns.map((turn) => turn.id === turnStartResponse.turn.id ? turnStartResponse.turn : turn)
          : [...resumedThread.turns, turnStartResponse.turn],
      }) ?? resumedThread;
      if (sendOptions.selectThread !== false) {
        setCurrentThread(resumedThread);
        options.onThreadStarted?.(resumedThread);
      }
    }

    let refreshedThread = resumedThread;
    try {
      if (harness === "codex") {
        const refreshedThreadResponse = await sendBridgeRequest<CodexThreadSessionResponse>(harness, {
          method: "thread/resume",
          params: {
            ...(selectedModel ? { model: selectedModel } : {}),
            serviceTier: selectedServiceTier,
            threadId: resolvedThreadId,
          } as ThreadResumeParams & { model?: string; serviceTier?: string | null; threadId: string },
        });
        refreshedThread = mergeLiveStreamingThreadSnapshot(toThreadPayload(
          refreshedThreadResponse.thread,
          harness,
          refreshedThreadResponse.model ?? resumedThread.model,
          refreshedThreadResponse.reasoningEffort ?? resumedThread.reasoningEffort,
          refreshedThreadResponse.serviceTier ?? resumedThread.serviceTier,
          resumedThread.agentPath,
        ));
      } else {
        const refreshedThreadResponse = await sendBridgeRequest<ThreadReadResponse>(harness, {
          method: "thread/read",
          params: {
            includeTurns: true,
            threadId: resolvedThreadId,
          },
        });
        refreshedThread = mergeLiveStreamingThreadSnapshot(toThreadPayload(
          refreshedThreadResponse.thread,
          harness,
          resumedThread.model,
          resumedThread.reasoningEffort,
          resumedThread.serviceTier,
          resumedThread.agentPath,
        ));
      }
      if (harness === "codex") {
        await readCompletedQuestionnaireHistory(resolvedThreadId);
      }
    } catch (error) {
      if (!(shouldBypassCodexDraftBootstrap && harness === "codex" && isTransientRolloutReadError(error))) {
        throw error;
      }

      // Fresh Codex threads can briefly race the rollout writer after turn/start succeeds.
      emitStatusMessage(FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE);
    }
    const payload = applyOptimisticSteerMessage(
      applyOptimisticUserMessageOverlay(refreshedThread) ?? refreshedThread,
      previousThread,
      normalizedInput,
    );
    if (sendOptions.selectThread !== false) {
      setCurrentThread(payload);
    }
    await refreshThreads();
    return payload;
  }

  async function stopThread(thread: ThreadPayload) {
    if (thread.isDraft) {
      return thread;
    }

    const clearedPendingRequest = clearPendingUserInputRequest(thread.id);
    const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(thread.id);
    if (clearedPendingRequest || clearedWaitingFlag) {
      emit();
    }

    const activeTurn = getCurrentInProgressTurn(thread);
    if (!activeTurn) {
      return thread;
    }

    await sendBridgeRequest<{ ok?: boolean }>(thread.harness, {
      method: "turn/interrupt",
      params: {
        threadId: thread.id,
        turnId: activeTurn.id,
      },
    });

    const refreshedThread = await readThread(thread.id, thread.harness).catch(() => null);
    if (refreshedThread) {
      if (state.currentThread?.id === refreshedThread.id && state.currentThread.harness === refreshedThread.harness) {
        setCurrentThread(refreshedThread);
      }
      await refreshThreads();
      return refreshedThread;
    }

    await refreshThreads();
    return thread;
  }

  async function submitPendingUserInputRequest(
    threadId: string,
    response: WorkbenchUserInputResponse,
    options: WorkbenchSubmitUserInputRequestOptions = {},
  ) {
    const pendingRequest = state.pendingUserInputRequestsByThreadId.get(threadId);
    if (!pendingRequest) {
      throw new Error("There is no pending question for this thread.");
    }

    const submitResult = await sendBridgeRequest<{ ok: boolean; warning?: string }>(pendingRequest.harness, {
      method: "questionnaire/respond",
      params: {
        insertAfterItemId: options.insertAfterItemId ?? pendingRequest.itemId,
        insertAfterItemIndex: options.insertAfterItemIndex ?? null,
        response,
        requestKey: pendingRequest.requestKey,
        threadId,
        turnId: options.turnId ?? pendingRequest.turnId,
      },
    });
    if (submitResult.warning) {
      emitStatusMessage(submitResult.warning);
    }
    if (pendingRequest.harness === "codex") {
      await readCompletedQuestionnaireHistory(threadId);
    }
    const clearedPendingRequest = clearPendingUserInputRequest(threadId, pendingRequest.requestKey);
    const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(threadId);
    if (clearedPendingRequest || clearedWaitingFlag) {
      emit();
    }
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
    if (notification.method === "questionnaire/requested") {
      if (upsertPendingUserInputRequest(
        notification.params.threadId,
        harness,
        notification.params.requestKey,
        notification.params.request,
        {
          itemId: notification.params.itemId,
          turnId: notification.params.turnId,
        },
      )) {
        emit();
      }
      return;
    }

    if (notification.method === "questionnaire/resolved") {
      const clearedPendingRequest = clearPendingUserInputRequest(notification.params.threadId, notification.params.requestKey);
      const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(notification.params.threadId);
      if (clearedPendingRequest || clearedWaitingFlag) {
        emit();
      }
      if (harness === "codex") {
        void readCompletedQuestionnaireHistory(notification.params.threadId);
      }
      return;
    }

    if (notification.method === "account/rateLimits/updated") {
      void refreshRateLimits(harness);
      return;
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

  function setCurrentThreadServiceTier(threadId: string, serviceTier: string | null) {
    if (!state.currentThread || state.currentThread.id !== threadId || state.currentThread.harness !== "codex") {
      return;
    }

    const nextServiceTier = serviceTier === "fast" ? "fast" : null;
    persistHarnessServiceTier(state.currentThread.harness, nextServiceTier);
    updateCurrentThread((thread) => ({
      ...thread,
      serviceTier: nextServiceTier,
    }));
  }

  function setDraftThreadHarness(harness: WorkbenchHarness) {
    if (!state.currentThread?.isDraft) {
      return;
    }

    const model = readStoredHarnessModel(harness);

    updateCurrentThread((thread) => ({
      ...thread,
      harness,
      model,
      reasoningEffort: readStoredHarnessModelEffort(harness, model),
      serviceTier: harness === "codex" ? readStoredHarnessServiceTier(harness) : null,
      agentPath: readStoredHarnessAgent(harness),
      source: harness,
    }));
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
    markThreadSeen,
    openThread,
    readThread,
    selectThreadPayload,
    reconcileCurrentThreadFromRead,
    readCurrentThread,
    refreshPendingUserInputRequests,
    refreshRateLimits,
    refreshThreads,
    sendThreadMessage,
    stopThread,
    submitPendingUserInputRequest,
    setCurrentThreadAgent,
    setCurrentThreadModel,
    setCurrentThreadReasoningEffort,
    setCurrentThreadServiceTier,
    setDraftThreadHarness,
    setProjectContext,
    subscribe,
  };
}

export default WorkbenchThreadClient;
