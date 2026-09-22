/*
 * Exports:
 * - WorkbenchThreadState: owned cross-thread selection and provider projection state.
 * - WorkbenchAcceptedIntent: provider-confirmed sidebar admission evidence handed to the workbench coordinator.
 * - WorkbenchThreadClientOptions: thread-client adapters and coordinator callbacks.
 * - default WorkbenchThreadClient: coordinate transport, project context, controller registries, cross-thread notifications, and message admission.
 */

import WorkbenchSocketClient from "workbench-shared/workbench/WorkbenchSocketClient";
import { defaultProviderKey, installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { WORKBENCH_THREAD_HISTORY_PENDING } from "workbench-shared/workbench/provider/provider-thread";
import ThreadObservationController, { getThreadObservationKey } from "./thread/ThreadObservationController";
import WorkbenchThreadController, { type ThreadControllerTarget } from "./WorkbenchThreadController";
import type { WorkbenchClientNotification } from "workbench-shared/workbench/WorkbenchSocketClient";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "workbench-shared/workbench/daemon-reload";
import { WORKBENCH_STATS_IMPORT_UPDATED_METHOD } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchControls } from "workbench-shared/types";
import type { ThreadActiveFlag } from "workbench-shared/workbench/thread/workbench-thread-turn";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { DraftIdSchema, PendingTurnIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchTurnIdSchema, type DraftId, type PendingTurnId, type ProjectId, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { createWorkbenchTextInput as createTextInput } from "workbench-shared/workbench/provider/provider-input";
import { isWorkbenchRpcFailure } from "workbench-shared/workbench/workbench-rpc";
import { formatThreadStatus } from "workbench-shared/workbench/thread/thread-runtime-state";
import { isProjectThread, isProjectThreadAtExpectedCwd } from "workbench-shared/workbench/thread/thread-location";
import { appendCommandOutputDelta, compactCommandExecutionItemOutput } from "workbench-shared/workbench/thread/thread-command-output";
import {
  isSupportedWorkbenchTranscriptItem,
  normalizeThreadItems,
} from "workbench-shared/workbench/thread/thread-item-normalization";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import { getCurrentInProgressTurn, getCurrentTurn } from "workbench-shared/workbench/thread/thread-runtime-state";
import type { ThreadPayload, ThreadSummary, WorkbenchBrowseResultEntry, WorkbenchComposerSettings, WorkbenchHarness, WorkbenchListModelsOptions, WorkbenchModelOption, WorkbenchPendingUserInputRequest, WorkbenchProjectOption, WorkbenchProjectRoot, WorkbenchQuestionnaireHistoryEntry, WorkbenchReadThreadOptions, WorkbenchSendThreadMessageOptions, WorkbenchSteerHistoryEntry, WorkbenchSubagentSummary, WorkbenchSubmitUserInputRequestOptions, WorkbenchThreadGoalControls, WorkbenchThreadRuntimeSnapshot, WorkbenchThreadTurnHistoryEntry, WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import { normalizeWorkbenchAgentPath } from "workbench-shared/workbench/agent-paths";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchTranscriptClient from "./database/transcript/WorkbenchTranscriptClient";
import { workbenchTranscriptOperations } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import LifecycleScope from "./state/LifecycleScope";
import WorkbenchClientStateController from "./state/WorkbenchClientStateController";
import ThreadDocumentStore from "./state/ThreadDocumentStore";
import type { ThreadSourceStore } from "./state/ThreadSourceStore";
import ThreadDocumentController, {
  type ThreadDocumentOverlayRevision,
  type ThreadStablePreferences,
} from "./thread/ThreadDocumentController";
import ThreadGoalController from "./thread/ThreadGoalController";
import ThreadMessageAdmissionController from "./thread/ThreadMessageAdmissionController";
import ThreadOptimisticInputStore from "./thread/ThreadOptimisticInputStore";
import type { WorkbenchThreadIdentityResolution, WorkbenchThreadIdentityResolveRequest } from "workbench-shared/workbench/thread/workbench-thread-identity";
import ThreadTextPresentationController, {
    type ThreadTextPresentationField,
    type ThreadTextPresentationKey,
} from "./thread/ThreadTextPresentationController";
import type { WorkbenchThreadPageResult as WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/thread-actions";
import { WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED } from "workbench-shared/workbench/thread/thread-actions";
import { getTurnRenderSignature } from "./thread/thread-item-signature";
import { upsertWorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { ThreadMessageNotSentError } from "./thread/thread-message-submission";
import { applyQuestionnaireHistoryToThread, isSyntheticQuestionnaireHistoryItem } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import {
    isWorkbenchMcpQuestionnaireRequestKey,
    mergeQuestionnaireHistoryEntries,
} from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import {
    createWorkbenchThreadRecoveryId,
    isWorkbenchThreadRecoveryInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchQuestionnaireHistoryEntryState, WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { applySteerHistoryToThread, isSyntheticSteerHistoryItem } from "workbench-shared/workbench/thread/thread-steer-history";
import {
    getWorkbenchApprovalSupplementalSteerText,
    hasWorkbenchApprovalDecisionSelection,
    isWorkbenchApprovalRequest,
} from "workbench-shared/workbench/thread/thread-user-input-requests";
import ThreadTranscriptProjectionController from "./transcript/ThreadTranscriptProjectionController";
import WorkbenchAccountClient from "./WorkbenchAccountClient";

const RATE_LIMIT_REFRESH_TASK_ID = "rate-limit-refresh";
const RATE_LIMIT_REFRESH_INTERVAL_MS = 15_000;
const AUTO_REFRESH_REQUEST_SOURCE = "autoRefresh";
const DEFAULT_WORKFLOW_IDS = ["default"] as const;
const SUBAGENT_WORKFLOW_IDS = ["subagent"] as const;

function readLocalWorkbenchOrigin() {
  try {
    return new URL(window.location.href).origin;
  } catch {
    return null;
  }
}

function isApprovalUserInputRequest(request: WorkbenchUserInputRequest) {
  return request.approval !== undefined || isWorkbenchApprovalRequest(request);
}
const THREAD_HISTORY_PENDING_STATUS_MESSAGE = "Started the thread. Its saved history is still becoming available, so the live view will refresh automatically.";


export interface WorkbenchThreadState {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  hasLoadedThreads: boolean;
  isLoading: boolean;
  pendingUserInputRequestsByThreadId: Map<string, WorkbenchPendingUserInputRequest>;
  projectId: ProjectId | "";
  projectRoot: string;
  projectRootPath: string;
  projectRoots: WorkbenchProjectRoot[];
  questionnaireHistoryByThreadId: Map<string, WorkbenchQuestionnaireHistoryEntry[]>;
  browseResultEntriesByThreadId: Map<string, WorkbenchBrowseResultEntry[]>;
  steerHistoryByThreadId: Map<string, WorkbenchSteerHistoryEntry[]>;
  subagents: WorkbenchSubagentSummary[];
  threads: ThreadSummary[];
  threadsError: string;
}

type WorkbenchThreadListener = (snapshot: WorkbenchThreadRuntimeSnapshot) => void;

export interface WorkbenchAcceptedIntent {
  draftId?: DraftId;
  harness: WorkbenchHarness;
  projectId: ProjectId;
  threadId: WorkbenchThreadId;
  title: string;
  turnId: WorkbenchTurnId;
}

export interface WorkbenchThreadClientOptions {
  updateThreadStateWithAcceptance?: WorkbenchControls["updateThreadStateWithAcceptance"];
  getProjectById?: (projectId: string) => WorkbenchProjectOption | undefined;
  clientStateController?: WorkbenchClientStateController;
  onStatusMessage?: (message: string) => void;
  onThreadStarted?: (thread: ThreadPayload) => void;
  publishAcceptedIntent?: (event: WorkbenchAcceptedIntent) => Promise<void>;
  resolveThreadIdentity?: (request: WorkbenchThreadIdentityResolveRequest) => Promise<WorkbenchThreadIdentityResolution | null>;
}

interface WorkbenchThreadClient {
  threadObservations: ThreadObservationController;
  getThreadController: (projectId: string, target: ThreadControllerTarget) => WorkbenchThreadController;
  recoverThreadControllers: () => Promise<void>;
  activateThreadControllers: () => void;
  applyAcceptedThreadTitle: (threadId: WorkbenchThreadId, harness: WorkbenchHarness, title: string) => boolean;
  clearThreadSelection: () => void;
  createThread: (harness: WorkbenchHarness, threadId?: DraftId, options?: { project?: WorkbenchProjectOption; select?: boolean }) => ThreadPayload<DraftId>;
  dispose: () => void;
  getSnapshot: () => WorkbenchThreadRuntimeSnapshot;
  hasThread: (threadId: string) => boolean;
  isCurrentThreadUpToDate: (threadId: string) => boolean;
  isDraftThreadId: (threadId: string) => threadId is DraftId;
  installThreadStateSources: (sources: {
    activeProjectSnapshot: WorkbenchThreadSidebarSnapshot | null;
  }) => void;
  listModels: (harness: WorkbenchHarness, options?: WorkbenchListModelsOptions) => Promise<WorkbenchModelOption[]>;
  openThread: (threadId: string, options?: { harness?: WorkbenchHarness; project?: WorkbenchProjectOption; source?: "open" | "reload"; isCurrent?: () => boolean }) => Promise<ThreadPayloadFetchOutcome>;
  onReconnect: (listener: () => void) => () => void;
  onDisconnect: (listener: () => void) => () => void;
  setAppAvailable: (available: boolean) => void;
  onWorkbenchNotification: (listener: (notification: {
    method: "voice/event" | "workbench/thread-state/reset" | "workbench/thread-state/updated" | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD | typeof WORKBENCH_STATS_IMPORT_UPDATED_METHOD;
    params: unknown;
  }) => void) => () => void;
  refreshCurrentThread: () => Promise<ThreadPayload | null>;
  requestWorkbench: <TResponse>(method: string, params: unknown) => Promise<TResponse>;
  resetConnectionState: () => void;
  readThread: (threadId: string, harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => Promise<ThreadPayload | null>;
  selectThreadPayload: (thread: ThreadPayload) => void;
  refreshRateLimits: () => Promise<void>;
  sendThreadMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  compactThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  stopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  threadGoals: WorkbenchThreadGoalControls;
  transcripts: WorkbenchTranscriptClient;
  submitPendingUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  setCurrentThreadAgent: (threadId: string, agentPath: string | null) => void;
  setCurrentThreadComposerSettings: (threadId: string, settings: WorkbenchComposerSettings) => void;
  setCurrentThreadModel: (threadId: string, model: string) => void;
  setCurrentThreadReasoningEffort: (threadId: string, effort: string | null) => void;
  setCurrentThreadServiceTier: (threadId: string, serviceTier: string | null) => void;
  setDraftThreadHarness: (harness: WorkbenchHarness) => void;
  setProjectContext: (context: { projectId?: ProjectId | ""; root: string; rootPath: string; roots?: WorkbenchProjectRoot[] }) => void;
  subscribe: (listener: WorkbenchThreadListener) => () => void;
  textPresentation: ThreadTextPresentationController;
}

type OptimisticUserMessagePlacement = "initial" | "steer";
type OptimisticUserMessageStatus = "pending" | "sent" | "interrupted" | "failed";
type ProviderSteerAcknowledgement = { turnId: string };

interface ThreadReadFailure {
  harness: WorkbenchHarness;
  message: string;
  transientRollout: boolean;
}

class ThreadPayloadReadError extends Error {
  constructor(readonly failure: ThreadReadFailure) { super(failure.message); }
}

type ThreadPayloadFetchOutcome =
  | { kind: "failure"; failure: ThreadReadFailure }
  | { kind: "success"; payload: ThreadPayload }
  | { kind: "superseded" };

interface ThreadOperationFence {
  ownerIsCurrent?: () => boolean;
  overlayRevisions: ThreadDocumentOverlayRevision;
  projectContextGeneration: number;
  projectId: string;
  projectRootPath: string;
  selectedThreadKey: string | null;
  sourceRevision: number;
  stablePreferenceRevision: number;
  statusRevision: number;
  threadProjectContextGeneration: number;
  threadKey: string;
}

type ProjectOperationIdentity = Pick<ThreadOperationFence, "projectContextGeneration" | "projectId" | "projectRootPath" | "threadProjectContextGeneration">;
type ThreadProjectContext = {
  projectId: ProjectId | "";
  projectRoot: string;
  projectRootPath: string;
  projectRoots: WorkbenchProjectRoot[];
};
type SelectedThreadProjectContext = {
  isCurrent: () => boolean;
  projectId: ProjectId | "";
  harness: WorkbenchHarness;
  rootThreadId: string;
};

interface ThreadReadResult {
  pageResponse: WorkbenchThreadPageResponse;
  payload: ThreadPayload;
}

interface ReconcileAdmittedThreadMessageContext {
  harness: WorkbenchHarness;
  isDraftThread: boolean;
  normalizedInput: UserInput[];
  optimisticTurnId: string | null;
  previousThread: ThreadPayload | null;
  resolvedThreadId: string;
  resumedThread: ThreadPayload;
  selectedAgentPath: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  selectedServiceTier: string | null;
  sendOptions: WorkbenchSendThreadMessageOptions;
  isFreshCreation: boolean;
  workbenchOrigin: string | null;
}

function createInitialThreadState(): WorkbenchThreadState {
  return {
    currentThread: null,
    currentThreadId: "",
    hasLoadedThreads: false,
    isLoading: false,
    pendingUserInputRequestsByThreadId: new Map(),
    projectId: "",
    projectRoot: "Project",
    projectRootPath: "",
    projectRoots: [],
    questionnaireHistoryByThreadId: new Map(),
    browseResultEntriesByThreadId: new Map(),
    steerHistoryByThreadId: new Map(),
    subagents: [],
    threads: [],
    threadsError: "",
  };
}

function getThreadStateKey(harness: WorkbenchHarness, threadId: string) {
  return `${harness}:${threadId}`;
}

function getProjectRootPaths(state: Pick<WorkbenchThreadState, "projectRootPath" | "projectRoots">) {
  const rootPaths = state.projectRoots.length
    ? state.projectRoots.map((root) => root.rootPath)
    : state.projectRootPath
      ? [state.projectRootPath]
      : [];
  return Array.from(new Set(rootPaths.filter(Boolean)));
}

function getThreadProjectRootPaths(context: ThreadProjectContext) {
  const rootPaths = context.projectRoots.length
    ? context.projectRoots.map((root) => root.rootPath)
    : context.projectRootPath
      ? [context.projectRootPath]
      : [];
  return Array.from(new Set(rootPaths.filter(Boolean)));
}

function isWorkbenchThreadInCurrentProject(thread: Pick<ThreadSummary, "cwd">, harness: WorkbenchHarness, projectRootPaths: string[]) {
  if (!projectRootPaths.length) {
    return true;
  }

  return isProjectThread(thread, projectRootPaths);
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

function addThreadActiveFlag(status: string, flag: ThreadActiveFlag) {
  if (!status.startsWith("active")) {
    return `active:${flag}`;
  }

  const [, activeFlags = ""] = status.split(":", 2);
  const nextFlags = Array.from(new Set([...activeFlags.split(",").filter(Boolean), flag]));
  return nextFlags.length ? `active:${nextFlags.join(",")}` : "active";
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

function createLoadedTurnHistoryEntry(turn: Turn): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    itemIds: turn.items.map((item) => item.id),
    loadState: "loaded",
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  };
}

function mergeThreadTurnHistory(
  incomingHistory: WorkbenchThreadTurnHistoryEntry[],
  existingHistory: WorkbenchThreadTurnHistoryEntry[],
) {
  if (!existingHistory.length) {
    return incomingHistory;
  }

  const incomingById = new Map(incomingHistory.map((entry) => [entry.turnId, entry]));
  let changed = false;
  const mergedExisting = existingHistory.map((entry) => {
    const incomingEntry = incomingById.get(entry.turnId);
    if (!incomingEntry) {
      return entry;
    }

    incomingById.delete(entry.turnId);
    const incomingWithPreservedTimeline = incomingEntry.itemTimeline === undefined && entry.itemTimeline !== undefined
      ? { ...incomingEntry, itemTimeline: entry.itemTimeline }
      : incomingEntry;
    const mergedEntry = entry.loadState === "loaded" && incomingWithPreservedTimeline.loadState !== "loaded"
      ? {
        ...incomingWithPreservedTimeline,
        itemCount: entry.itemCount,
        itemIds: entry.itemIds,
        loadState: entry.loadState,
      }
      : incomingWithPreservedTimeline;
    if (!areDeeplyEqual(mergedEntry, entry)) {
      changed = true;
    }
    return mergedEntry;
  });

  const appended = Array.from(incomingById.values());
  return changed || appended.length ? [...mergedExisting, ...appended] : existingHistory;
}

function orderTurnsByHistory(turns: Turn[], history: WorkbenchThreadTurnHistoryEntry[]) {
  const indexesById = new Map(history.map((entry, index) => [entry.turnId, index]));
  return [...turns].sort((left, right) => {
    const leftIndex = indexesById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = indexesById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.id.localeCompare(right.id);
  });
}

function mergeThreadTurnBodies(incomingTurns: Turn[], existingTurns: Turn[], history: WorkbenchThreadTurnHistoryEntry[]) {
  if (!existingTurns.length) {
    return orderTurnsByHistory(incomingTurns, history);
  }

  const incomingById = new Map(incomingTurns.map((turn) => [turn.id, turn]));
  const incomingIds = new Set(incomingTurns.map((turn) => turn.id));
  const mergedExisting = existingTurns.map((turn) => incomingById.get(turn.id) ?? turn);
  const appended = incomingTurns.filter((turn) => !existingTurns.some((existingTurn) => existingTurn.id === turn.id));
  return incomingIds.size || appended.length ? orderTurnsByHistory([...mergedExisting, ...appended], history) : existingTurns;
}

function mergeScopedThreadContextEntries<TEntry extends { turnId: string }>(
  existingEntries: TEntry[],
  incomingEntries: TEntry[],
  turnIds: Iterable<string>,
  turnHistory: WorkbenchThreadTurnHistoryEntry[],
) {
  const scopedTurnIds = new Set(turnIds);
  const turnIndexes = new Map(turnHistory.map((entry, index) => [entry.turnId, index]));
  return [
    ...existingEntries.filter((entry) => !scopedTurnIds.has(entry.turnId)),
    ...incomingEntries.filter((entry) => scopedTurnIds.has(entry.turnId)),
  ]
    .map((entry, stableIndex) => ({ entry, stableIndex }))
    .sort((left, right) => {
      const leftTurnIndex = turnIndexes.get(left.entry.turnId) ?? Number.MAX_SAFE_INTEGER;
      const rightTurnIndex = turnIndexes.get(right.entry.turnId) ?? Number.MAX_SAFE_INTEGER;
      return leftTurnIndex - rightTurnIndex || left.stableIndex - right.stableIndex;
    })
    .map(({ entry }) => entry);
}

function mergeThreadContextEntriesByKey<TEntry extends { entryKey: string }>(
  incomingEntries: TEntry[],
  currentEntries: TEntry[],
) {
  const merged = [...incomingEntries];
  const indexByKey = new Map(merged.map((entry, index) => [entry.entryKey, index]));
  for (const entry of currentEntries) {
    const existingIndex = indexByKey.get(entry.entryKey);
    if (existingIndex === undefined) {
      indexByKey.set(entry.entryKey, merged.length);
      merged.push(entry);
    } else {
      merged[existingIndex] = entry;
    }
  }
  return merged;
}

function ensureThreadHistory(thread: ThreadPayload): ThreadPayload {
  if (thread.turnHistory.length) {
    return thread;
  }

  return {
    ...thread,
    turnHistory: thread.turns.map(createLoadedTurnHistoryEntry),
  };
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

function isThreadHistoryPending(error: unknown) {
  return error instanceof WorkbenchDaemonRequestError && error.code === WORKBENCH_THREAD_HISTORY_PENDING;
}

function normalizeQuestionnaireHistoryEntryState(
  entry: WorkbenchQuestionnaireHistoryEntryState,
): WorkbenchQuestionnaireHistoryEntry {
  return {
    insertAfterItemId: entry.insertAfterItemId ?? null,
    insertAfterItemIndex: entry.insertAfterItemIndex ?? null,
    itemId: entry.itemId ?? null,
    request: entry.request,
    requestKey: entry.requestKey,
    resolvedAt: entry.resolvedAt,
    response: entry.response,
    threadId: entry.threadId,
    turnId: entry.turnId,
  };
}

function WorkbenchThreadClient(
  options: WorkbenchThreadClientOptions = {},
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchThreadClient {
  const socket = new WorkbenchSocketClient();

  async function requestWorkbench<TResponse>(method: string, params: unknown) {
    const response = await socket.sendRequest<TResponse>({ method, params });
    if (isWorkbenchRpcFailure(response)) {
      const data = response.error.data && typeof response.error.data === "object" && !Array.isArray(response.error.data)
        ? response.error.data
        : null;
      throw new WorkbenchDaemonRequestError(response.error.message, response.error.code, data);
    }
    return response.result;
  }

  const daemon = new WorkbenchDaemonClient({ request: requestWorkbench });
  const threadObservations = new ThreadObservationController({ request: requestWorkbench });
  lifecycle.addUnsubscribe(socket.onConnectionClose(() => threadObservations.disconnect()));
  lifecycle.addUnsubscribe(socket.onWorkbenchNotification(notification => {
    if (notification.method === "workbench/thread-state/reset") threadObservations.disconnect();
    else if (notification.method === "workbench/thread-state/updated"
      && notification.params && typeof notification.params === "object"
      && "updateKind" in notification.params && notification.params.updateKind === "threadObservation") {
      threadObservations.accept(notification.params);
    }
  }));
  let selectedObservation: ReturnType<ThreadObservationController["acquire"]> | null = null;

  function onWorkbenchNotification(listener: (notification: {
    method: "voice/event" | "workbench/thread-state/reset" | "workbench/thread-state/updated" | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD | typeof WORKBENCH_STATS_IMPORT_UPDATED_METHOD;
    params: unknown;
  }) => void) {
    return socket.onWorkbenchNotification((notification) => {
      if (
        notification.method === "workbench/thread-state/reset"
        || notification.method === "voice/event"
        || notification.method === "workbench/thread-state/updated"
        || notification.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
        || notification.method === WORKBENCH_STATS_IMPORT_UPDATED_METHOD
      ) {
        listener({ method: notification.method, params: notification.params });
      }
    });
  }

  function onReconnect(listener: () => void) {
    return socket.onReconnect(listener);
  }

  let transcriptConformanceReportFailureLogged = false;
  const transcripts = new WorkbenchTranscriptClient({
    reportConformance: (report) => {
      void requestWorkbench(
        workbenchTranscriptOperations.reportConformance.method,
        report,
      ).catch((error) => {
        if (transcriptConformanceReportFailureLogged) return;
        transcriptConformanceReportFailureLogged = true;
        console.error("Failed to store Workbench transcript conformance diagnostic.", error);
      });
    },
    transport: {
      onDisconnect: (listener) => socket.onConnectionClose(listener),
      onNotification: (listener) => socket.onWorkbenchNotification(listener),
      request: async (method, params) => await requestWorkbench<unknown>(method, params),
    },
  });
  const threadGoals = new ThreadGoalController({
    clear: params => daemon.threads.goal.clear(params),
    get: params => daemon.threads.goal.read(params),
    set: params => daemon.threads.goal.update(params),
  });
  const listeners = new Set<WorkbenchThreadListener>();
  const account = new WorkbenchAccountClient({
    listModels: async (harness) => (await daemon.models.list(harness)).data,
    reportError: message => emitStatusMessage(message),
    readRateLimits: async (harness) => await daemon.account.limits(harness),
  });
  const state = createInitialThreadState();
  const threadDocuments = ThreadDocumentStore({
    areDocumentsEquivalent: areThreadPayloadsEquivalent,
  });
  const documentControllers = new Map<string, ThreadDocumentController>();
  const threadControllers = new Map<string, WorkbenchThreadController>();
  const textPresentation = new ThreadTextPresentationController();
  function getDocumentController(key: string) {
    let controller = documentControllers.get(key);
    if (!controller) {
      controller = new ThreadDocumentController({
        applyBrowseResultOverlay: thread => applyPersistedBrowseResultEntries(thread) ?? thread,
        applyOptimisticOverlay: thread => applyOptimisticUserMessageOverlay(thread) ?? thread,
        applyQuestionnaireOverlay: thread => applyPersistedQuestionnaireHistory(thread) ?? thread,
        applySteerOverlay: thread => applyPersistedSteerHistory(thread) ?? thread,
        documents: threadDocuments,
        key,
        normalizeCanonicalThread: thread => prepareCanonicalThreadSource(thread) ?? thread,
      });
      documentControllers.set(key, controller);
    }
    return controller;
  }
  function findDocumentController(key: string) {
    return documentControllers.get(key) ?? null;
  }
  function getThreadStreaming(key: string) {
    return getDocumentController(key).streaming;
  }
  const threadSources: ThreadSourceStore = {
    clear() {
      for (const controller of documentControllers.values()) controller.clear();
      documentControllers.clear();
    },
    delete(key) {
      const controller = findDocumentController(key);
      if (!controller) return false;
      const changed = controller.clear();
      documentControllers.delete(key);
      return changed;
    },
    get: key => findDocumentController(key)?.getSource() ?? null,
    getRevision: key => findDocumentController(key)?.getRevision().sourceRevision ?? 0,
    has: key => findDocumentController(key)?.hasSource() ?? false,
    install(thread) {
      const key = getThreadStateKey(thread.harness, thread.id);
      return getDocumentController(key).installSource(thread);
    },
    update: (key, updater) => findDocumentController(key)?.updateSource(updater) ?? false,
  };
  function getThreadController(projectId: string, target: ThreadControllerTarget) {
    const threadId = target.kind === "draft" ? target.draftId : target.threadId;
    const key = `${projectId}\0${threadId}`;
    let controller = threadControllers.get(key);
    if (!controller) {
      const harness = target.kind === "draft"
        ? defaultProviderKey
        : target.harness ?? getKnownThreadHarness(threadId) ?? defaultProviderKey;
      controller = new WorkbenchThreadController(projectId, target, {
        controls: {
          compactThread, stopThread, setCurrentThreadAgent, setCurrentThreadModel,
          setCurrentThreadReasoningEffort, setCurrentThreadServiceTier, setCurrentThreadComposerSettings,
          submitPendingUserInputRequest,
          updateThreadStateWithAcceptance: request => {
            if (!options.updateThreadStateWithAcceptance) throw new Error("Thread state mutations are not connected.");
            return options.updateThreadStateWithAcceptance(request);
          },
        },
        document: getDocumentController(getThreadStateKey(harness, threadId)),
        observations: threadObservations,
        readGitArcProposal: async input => await daemon.git.arc.proposal.read({
          ...input,
          includeNewer: false,
        }),
        getChild: subagent => getThreadController(projectId, {
          kind: "subagent", harness: subagent.harness, parentThreadId: subagent.parentThreadId, threadId: subagent.threadId,
        }),
        releaseHistoricalTurns: turnIds => releaseHistoricalTurns(
          target.kind === "draft" ? defaultProviderKey : target.harness ?? getKnownThreadHarness(threadId) ?? defaultProviderKey,
          threadId,
          turnIds,
        ),
        readNative: () => {
          const document = threadDocuments.getDocumentByThreadId(threadId);
          return {
            document,
            pendingQuestionnaire: state.pendingUserInputRequestsByThreadId.get(threadId) ?? null,
            rateLimits: account.getRateLimits(document?.harness ?? (target.kind === "draft" ? defaultProviderKey : target.harness ?? defaultProviderKey)),
          };
        },
        subscribeNative: listener => subscribe(listener),
        subscribeGitArcProposalRefresh: listener => {
          window.addEventListener("focus", listener);
          return () => window.removeEventListener("focus", listener);
        },
        reconcile: async readOptions => {
          await daemon.threads.reconcile({
            threadId, target: readOptions.cursor ? { mode: "previous", beforeTurnId: readOptions.cursor } : { mode: "latest" },
            refresh: false,
          });
        },
        read: async (readOptions, beforeCommit, selectionBound, recover) => {
          await beforeCommit();
          const observed = target.kind === "draft" ? null : threadObservations.getSnapshot(getThreadObservationKey(projectId, target))
            .observation?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === threadId);
          const harness = observed && observed.entryKind !== "draft" ? observed.identity.harness
            : target.kind === "draft" ? defaultProviderKey : target.harness ?? getKnownThreadHarness(threadId) ?? defaultProviderKey;
          const cwd = observed?.entryKind === "subagent" ? observed.cwd : options.getProjectById?.(projectId)?.rootPath;
          readOptions = { ...(cwd ? { cwd } : {}), ...readOptions };
          const outcome = await fetchThreadPayload(threadId, harness, readOptions, payload => selectedThreadProjectContext?.projectId === projectId && selectedThreadProjectContext.rootThreadId === threadId && selectedThreadProjectContext.isCurrent()
            ? (setCurrentThread(payload), state.currentThread)
            : upsertThreadDocument(payload, { emitChange: true }), {
              selectionBound, beforeCommit, ownerIsCurrent: controller!.captureLifetime(), recover,
            });
          if (outcome.kind === "failure") throw new ThreadPayloadReadError(outcome.failure);
          return outcome.kind === "success" ? outcome.payload : null;
        },
        createTranscript: publish => {
          const projection = new ThreadTranscriptProjectionController({
            onError: error => console.error("Workbench SQLite transcript projection lifecycle failed.", error),
            onStateChange: publish,
            onText: (update, canonicalText) => {
              const sourceKey = getThreadStateKey(getThreadHarness(update.threadId), update.threadId);
              const key = presentationKey(sourceKey, update.threadId, update.turnId, update.itemId, update.field, update.index, "sqlite");
              textPresentation.acceptDelta({ key, canonicalText, delta: update.append ? update.text : canonicalText });
              if (!update.append) textPresentation.complete(key, canonicalText, { snap: true });
            },
            readOptimisticInitials: thread => optimisticInputs.getInitialProjections(getThreadStateKey(thread.harness, thread.id)),
            transcripts: {
              subscribe: (params, listener, streamListener, streamFailure) =>
                transcripts.subscribe(params, listener, streamListener, streamFailure),
              unsubscribe: async params => {
                // Closing this client closes the shared socket and releases all server subscriptions.
                if (disposed) return;
                try { await transcripts.unsubscribe(params); }
                catch (error) { if (!disposed) throw error; }
              },
            },
            turnLimit: 4,
          });
          return { controller: projection, stopAvailability: transcripts.onAvailabilityChange(available => projection.setAvailable(available)) };
        },
        reportError: message => emitStatusMessage(message),
      });
      threadControllers.set(key, controller);
    }
    return controller;
  }
  async function publishAcceptedIntent({
    draftId,
    harness,
    projectId,
    threadId,
    title,
    turnId,
  }: Omit<WorkbenchAcceptedIntent, "projectId"> & { projectId: ProjectId | "" }) {
    try {
      if (!projectId) throw new Error("The admitted thread has no project identity.");
      if (options.publishAcceptedIntent) {
        await options.publishAcceptedIntent({ ...(draftId ? { draftId } : {}), harness, projectId, threadId, title, turnId });
      } else {
        await requestWorkbench("workbench/thread-state/intent/accept", {
          ...(draftId ? { draftId } : {}),
          identity: { harness, threadId },
          projectId,
          title,
          turnId,
        });
      }
    } catch (error) {
      options.onStatusMessage?.(`The message was admitted, but sidebar lifecycle publication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const optimisticInputs = ThreadOptimisticInputStore();
  let disposed = false;
  let projectContextGeneration = 0;
  let threadProjectContextGeneration = 0;
  let selectedThreadProjectContext: SelectedThreadProjectContext | null = null;
  let messageAdmissionIntentRevision = 0;
  const pendingUserInputRequestGenerationsByHarness = new Map<WorkbenchHarness, number>();
  const questionnaireListSyncPromisesByHarness = new Map<WorkbenchHarness, Promise<boolean>>();
  const questionnaireListSyncedHarnesses = new Set<WorkbenchHarness>();
  const providerPendingUserInputRequestsByHarness = new Map<WorkbenchHarness, Map<string, WorkbenchPendingUserInputRequest>>();
  lifecycle.addUnsubscribe(threadObservations.subscribe(() => {
    if (disposed) return;
    reconcileObservedSubagents();
    reconcileObservedQuestionnaires();
    emit();
  }));
  const resolvedDurableQuestionnaireKeysByThreadId = new Map<string, string>();
  const browseResultReadGenerationByKey = new Map<string, number>();
  const questionnaireHistoryReadGenerationByKey = new Map<string, number>();
  const questionnaireHistoryWarningKeys = new Set<string>();
  const steerHistoryReadGenerationByKey = new Map<string, number>();
  const steerHistoryWarningKeys = new Set<string>();
  const messageAdmissionController = ThreadMessageAdmissionController({
    client: { connect: () => socket.connectSocket(), submit: input => daemon.threads.message(input) },
    documents: threadDocuments,
    emitWarning: emitStatusMessage,
    getLifecycleState: (threadId) => {
      const projectContext = effectiveThreadProjectContext(getThreadHarness(threadId), threadId);
      return {
        disposed,
        projectContextGeneration,
        projectId: projectContext.projectId,
        projectRootPath: projectContext.projectRootPath,
        messageAdmissionIntentRevision,
      };
    },
    getThreadStatus: (thread) => findDocumentController(getThreadStateKey(thread.harness, thread.id))?.getStatus() ?? thread.status,
    optimisticInputs,
    renderSource: renderOptimisticSource,
    sources: threadSources,
  });

  function emitStatusMessage(message: string) {
    options.onStatusMessage?.(message);
  }

  function renderOptimisticSource(key: string) {
    bumpOverlayRevisionForKey(key, "optimisticRevision");
    if (threadDocuments.getSelectedThreadKey() === key) {
      flushSelectedThreadRendering();
    }
  }

  function serializePendingUserInputRequests() {
    return Object.fromEntries(state.pendingUserInputRequestsByThreadId.entries());
  }

  function getPendingUserInputRequestGeneration(harness: WorkbenchHarness) {
    return pendingUserInputRequestGenerationsByHarness.get(harness) ?? 0;
  }

  function bumpPendingUserInputRequestGeneration(harness: WorkbenchHarness) {
    pendingUserInputRequestGenerationsByHarness.set(harness, getPendingUserInputRequestGeneration(harness) + 1);
  }

  function currentThreadProjectContext(): ThreadProjectContext {
    return {
      projectId: state.projectId,
      projectRoot: state.projectRoot,
      projectRootPath: state.projectRootPath,
      projectRoots: state.projectRoots,
    };
  }

  function projectThreadContext(project: WorkbenchProjectOption): ThreadProjectContext {
    return {
      projectId: project.id,
      projectRoot: project.name || project.id,
      projectRootPath: project.rootPath,
      projectRoots: project.roots,
    };
  }

  function effectiveThreadProjectContext(harness: WorkbenchHarness, threadId: string) {
    const observed = threadObservations.getObservations().find(snapshot => snapshot.entries.some(entry => (
      entry.entryKind !== "draft" && entry.identity.harness === harness && entry.identity.threadId === threadId
    )));
    const selected = selectedThreadProjectContext;
    const projectId = observed?.projectId ?? (selected?.harness === harness && selected.rootThreadId === threadId ? selected.projectId : state.projectId);
    if (projectId === state.projectId) return currentThreadProjectContext();
    const project = options.getProjectById?.(projectId);
    if (!project) throw new Error("The thread's owning project is unavailable.");
    return projectThreadContext(project);
  }

  function installSelectedThreadProjectContext(
    target: Exclude<ThreadControllerTarget, { kind: "subagent" }> & { harness: WorkbenchHarness },
    project: WorkbenchProjectOption | undefined,
    isCurrent: () => boolean = () => true,
  ) {
    const { harness } = target;
    const rootThreadId = target.kind === "draft" ? target.draftId : target.threadId;
    const projectId = project?.id ?? state.projectId;
    const observationKey = projectId && target.kind === "provider" ? getThreadObservationKey(projectId, target) : null;
    if (selectedObservation?.key !== observationKey) {
      selectedObservation?.release();
      selectedObservation = observationKey ? { key: observationKey, release: getThreadController(projectId, target).acquire("summary") } : null;
    }
    if (selectedThreadProjectContext?.projectId !== projectId
      || selectedThreadProjectContext.harness !== harness
      || selectedThreadProjectContext.rootThreadId !== rootThreadId) threadProjectContextGeneration += 1;
    selectedThreadProjectContext = { projectId, harness, rootThreadId, isCurrent };
    reconcileObservedSubagents();
  }

  function reconcileObservedSubagents() {
    const subagents = selectedObservation ? threadObservations.getSubagents(selectedObservation.key) : [];
    if (!areDeeplyEqual(state.subagents, subagents)) state.subagents = subagents;
  }

  function getSnapshot(): WorkbenchThreadRuntimeSnapshot {
    return {
      currentThread: state.currentThread,
      currentThreadId: state.currentThreadId,
      isLoading: state.isLoading,
      pendingUserInputRequestsByThreadId: serializePendingUserInputRequests(),
      rateLimits: account.getRateLimits(state.currentThread?.harness),
      subagents: state.subagents,
      threadDocuments: threadDocuments.getSnapshot(),
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

  lifecycle.addUnsubscribe(account.subscribe(emit));

  function areProjectRootsEquivalent(left: WorkbenchProjectRoot[], right: WorkbenchProjectRoot[]) {
    return left.length === right.length
      && left.every((root, index) => {
        const otherRoot = right[index];
        return otherRoot
          && root.id === otherRoot.id
          && root.name === otherRoot.name
          && root.rootPath === otherRoot.rootPath
          && root.isPrimary === otherRoot.isPrimary;
      });
  }

  function resetProjectThreadState({ emitChange = true }: { emitChange?: boolean } = {}) {
    selectedObservation?.release();
    selectedObservation = null;
    const retainedThreadIds = new Set<string>([...threadControllers.values()].filter(controller => controller.hasConsumers).map(controller => controller.threadId));
    const retainedKeys = new Set(Object.entries(threadDocuments.getSnapshot().documentsByKey)
      .filter(([, document]) => document && retainedThreadIds.has(document.id)).map(([key]) => key));
    projectContextGeneration += 1;
    threadProjectContextGeneration += 1;
    selectedThreadProjectContext = null;
    for (const harness of new Set([...installedProviderKeys, ...pendingUserInputRequestGenerationsByHarness.keys()])) {
      bumpPendingUserInputRequestGeneration(harness);
    }
    messageAdmissionIntentRevision += 1;

    account.reset();

    state.subagents = [];
    state.threads = [];
    state.currentThread = null;
    state.currentThreadId = "";
    state.threadsError = "";
    state.hasLoadedThreads = false;
    state.isLoading = Boolean(getProjectRootPaths(state).length);
    threadDocuments.selectDocumentKey("");
    for (const key of Object.keys(threadDocuments.getSnapshot().documentsByKey)) {
      if (retainedKeys.has(key)) continue;
      findDocumentController(key)?.clear();
      documentControllers.delete(key);
      optimisticInputs.deleteThread(key);
    }
    browseResultReadGenerationByKey.clear();
    questionnaireHistoryReadGenerationByKey.clear();
    questionnaireHistoryWarningKeys.clear();
    steerHistoryReadGenerationByKey.clear();
    steerHistoryWarningKeys.clear();
    for (const map of [state.questionnaireHistoryByThreadId, state.steerHistoryByThreadId, state.browseResultEntriesByThreadId, state.pendingUserInputRequestsByThreadId]) {
      for (const threadId of map.keys()) if (!retainedThreadIds.has(threadId)) map.delete(threadId);
    }
    questionnaireListSyncPromisesByHarness.clear();
    questionnaireListSyncedHarnesses.clear();
    providerPendingUserInputRequestsByHarness.clear();
    resolvedDurableQuestionnaireKeysByThreadId.clear();
    if (!retainedKeys.size) {
      for (const controller of documentControllers.values()) controller.clear();
      documentControllers.clear();
      optimisticInputs.clear();
      textPresentation.clear();
    }
    if (!disposed) reconcileObservedQuestionnaires();
    if (emitChange) {
      emit();
    }
  }

  function resetConnectionState() {
    resetProjectThreadState();
  }

  function setProjectContext(context: { projectId?: ProjectId | ""; root: string; rootPath: string; roots?: WorkbenchProjectRoot[] }) {
    const nextRoots = context.roots?.length
      ? context.roots.map((root) => ({ ...root }))
      : context.rootPath
        ? [{
          id: context.root,
          isPrimary: true,
          name: context.root,
          relativePath: context.root,
          rootPath: context.rootPath,
        }]
        : [];
    if (
      state.projectId === (context.projectId ?? "")
      && state.projectRoot === context.root
      && state.projectRootPath === context.rootPath
      && areProjectRootsEquivalent(state.projectRoots, nextRoots)
    ) {
      return;
    }

    state.projectId = context.projectId ?? "";
    state.projectRoot = context.root;
    state.projectRootPath = context.rootPath;
    state.projectRoots = nextRoots;
    resetProjectThreadState();
  }

  function applyPersistedQuestionnaireHistory(thread: ThreadPayload | null) {
    if (!thread) {
      return thread;
    }

    return applyQuestionnaireHistoryToThread(
      thread,
      state.questionnaireHistoryByThreadId.get(thread.id) ?? [],
    );
  }

  function applyPersistedSteerHistory(thread: ThreadPayload | null) {
    if (!thread) {
      return thread;
    }

    return applySteerHistoryToThread(
      thread,
      state.steerHistoryByThreadId.get(thread.id) ?? [],
    );
  }

  function applyPersistedBrowseResultEntries(thread: ThreadPayload | null) {
    if (!thread) {
      return thread;
    }

    const browseResultEntries = state.browseResultEntriesByThreadId.get(thread.id) ?? [];
    return browseResultEntries.length
      ? { ...thread, browseResultEntries }
      : thread.browseResultEntries?.length
        ? { ...thread, browseResultEntries: [] }
        : thread;
  }

  function getOverlayRevisionRecord(key: string) {
    return getDocumentController(key).getOverlayRevision();
  }

  function getOverlayKeysForThreadId(threadId: string) {
    const selectedThreadKey = threadDocuments.getSelectedThreadKey();
    if (selectedThreadKey) {
      const selectedSource = findDocumentController(selectedThreadKey)?.getSource();
      if (selectedSource?.id === threadId) {
        return [selectedThreadKey];
      }
    }

    const matchingKeys = Object.entries(threadDocuments.getSnapshot().documentsByKey)
      .filter(([key, document]) => document?.id === threadId && findDocumentController(key)?.hasSource())
      .map(([key]) => key);
    if (matchingKeys.length === 1) {
      return matchingKeys;
    }

    if (matchingKeys.length > 1) {
      return [];
    }

    return [getThreadStateKey(getThreadHarness(threadId), threadId)];
  }

  function bumpOverlayRevisionForKey(key: string, revisionKey: keyof ThreadDocumentOverlayRevision) {
    getDocumentController(key).bumpOverlay(revisionKey);
  }

  function bumpOverlayRevision(threadId: string, revisionKey: keyof ThreadDocumentOverlayRevision) {
    for (const key of getOverlayKeysForThreadId(threadId)) {
      bumpOverlayRevisionForKey(key, revisionKey);
    }
  }

  function prepareCanonicalThreadSource(thread: ThreadPayload | null) {
    return normalizeThreadPayloadItems(thread ? ensureThreadHistory(thread) : thread);
  }

  function getThreadSourceKey(thread: Pick<ThreadPayload, "harness" | "id">) {
    return getThreadStateKey(thread.harness, thread.id);
  }

  function captureStablePreferenceSource(thread: ThreadPayload) {
    return getDocumentController(getThreadSourceKey(thread)).captureStablePreferences(thread);
  }

  function getStablePreferenceRevision(key: string) {
    return findDocumentController(key)?.getRevision().stablePreferenceRevision ?? 0;
  }

  function updateStablePreferenceSource(
    thread: Pick<ThreadPayload, "harness" | "id">,
    updater: (record: Omit<ThreadStablePreferences, "revision">) => void,
  ) {
    const key = getThreadSourceKey(thread);
    const controller = findDocumentController(key);
    if (!controller?.updateStablePreferences(updater)) return false;
    if (key === threadDocuments.getSelectedThreadKey()) {
      flushSelectedThreadRendering();
    } else {
      const previousSnapshot = threadDocuments.getSnapshot();
      materializeFinalVisibleThread(key);
      if (previousSnapshot !== threadDocuments.getSnapshot()) {
        emit();
      }
    }
    return true;
  }

  function updateThreadSourceFields(
    thread: Pick<ThreadPayload, "harness" | "id">,
    fields: Partial<Omit<ThreadPayload, "turns" | "id" | "isDraft">>,
  ) {
    const key = getThreadSourceKey(thread);
    const controller = findDocumentController(key);
    if (!controller?.updateSource(source => ({ ...source, ...fields }))) return false;
    if (key === threadDocuments.getSelectedThreadKey()) {
      flushSelectedThreadRendering();
    } else {
      const previousSnapshot = threadDocuments.getSnapshot();
      materializeFinalVisibleThread(key);
      if (previousSnapshot !== threadDocuments.getSnapshot()) {
        emit();
      }
    }
    return true;
  }

  function setThreadStatusSource(thread: Pick<ThreadPayload, "harness" | "id">, status: string | null) {
    return getDocumentController(getThreadSourceKey(thread)).setStatus(status);
  }

  function getStatusRevision(key: string) {
    return findDocumentController(key)?.getRevision().statusRevision ?? 0;
  }

  function stripProjectedThreadSource(thread: ThreadPayload) {
    const withoutOptimistic = optimisticInputs.strip(thread);
    let changed = withoutOptimistic !== thread;
    const turns = withoutOptimistic.turns.map((turn) => {
      const items = turn.items.filter((item) => (
        !isSyntheticQuestionnaireHistoryItem(item)
        && !isSyntheticSteerHistoryItem(item)
      ));
      if (items.length === turn.items.length) {
        return turn;
      }
      changed = true;
      return { ...turn, items };
    });
    const nextThread = changed ? { ...withoutOptimistic, turns } : withoutOptimistic;
    return nextThread.browseResultEntries?.length
      ? { ...nextThread, browseResultEntries: [] }
      : nextThread;
  }

  function captureThreadOperationFence(
    harness: WorkbenchHarness,
    threadId: string,
    { selectionBound = false, ownerIsCurrent }: { selectionBound?: boolean; ownerIsCurrent?: () => boolean } = {},
  ): ThreadOperationFence {
    const threadKey = getThreadStateKey(harness, threadId);
    const overlay = getOverlayRevisionRecord(threadKey);
    return {
      ownerIsCurrent,
      overlayRevisions: {
        browseResultRevision: overlay.browseResultRevision,
        optimisticRevision: overlay.optimisticRevision,
        questionnaireForceProjectionEpoch: overlay.questionnaireForceProjectionEpoch,
        questionnaireRevision: overlay.questionnaireRevision,
        steerRevision: overlay.steerRevision,
      },
      projectContextGeneration,
      projectId: state.projectId,
      projectRootPath: state.projectRootPath,
      selectedThreadKey: selectionBound ? threadDocuments.getSelectedThreadKey() : null,
      sourceRevision: threadSources.getRevision(threadKey),
      stablePreferenceRevision: getStablePreferenceRevision(threadKey),
      statusRevision: getStatusRevision(threadKey),
      threadProjectContextGeneration,
      threadKey,
    };
  }

  function observedQuestionnaireEntries() {
    return threadObservations.getObservations().flatMap(observation => observation.entries);
  }

  function reconcileObservedQuestionnaires() {
    const durableQuestionnaireEntries = observedQuestionnaireEntries();
    const durableQuestionnairesByThreadId = new Map<string, NonNullable<Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>["pendingQuestionnaire"]>>(
      durableQuestionnaireEntries.flatMap((entry) => (
        entry.entryKind !== "draft" && entry.pendingQuestionnaire
          ? [[entry.identity.threadId, entry.pendingQuestionnaire] as const]
          : []
      )),
    );
    for (const [threadId, requestKey] of resolvedDurableQuestionnaireKeysByThreadId) {
      if (durableQuestionnairesByThreadId.get(threadId)?.requestKey !== requestKey) {
        resolvedDurableQuestionnaireKeysByThreadId.delete(threadId);
      }
    }

    for (const entry of durableQuestionnaireEntries) {
      if (entry.entryKind === "draft") continue;
      const durableHistory = entry.questionnaireHistory ?? [];
      if (durableHistory.length) {
        const normalizedHistory = durableHistory.map(normalizeQuestionnaireHistoryEntryState);
        setQuestionnaireHistoryEntries(
          entry.identity.threadId,
          mergeQuestionnaireHistoryEntries(
            state.questionnaireHistoryByThreadId.get(entry.identity.threadId) ?? [],
            normalizedHistory,
          ),
        );
      }
    }
    for (const harness of new Set([...installedProviderKeys, ...providerPendingUserInputRequestsByHarness.keys()])) {
      replacePendingUserInputRequests(
        harness,
        Array.from(providerPendingUserInputRequestsByHarness.get(harness)?.values() ?? []),
      );
      if (installedProviderKeys.some(key => key === harness) && !questionnaireListSyncedHarnesses.has(harness)) {
        void refreshPendingUserInputRequests(harness);
      }
    }
  }

  function installThreadStateSources({ activeProjectSnapshot }: { activeProjectSnapshot: WorkbenchThreadSidebarSnapshot | null }) {
    if (!activeProjectSnapshot) {
      state.threads = [];
      state.threadsError = "";
      state.hasLoadedThreads = false;
      state.isLoading = false;
      emit();
      return;
    }

    const priorThreadsByKey = new Map(state.threads.map((thread) => [`${thread.harness}:${thread.id}`, thread]));
    state.threads = activeProjectSnapshot.entries.flatMap((entry): ThreadSummary[] => {
      if (entry.entryKind !== "thread") return [];
      const prior = priorThreadsByKey.get(`${entry.identity.harness}:${entry.identity.threadId}`);
      const activitySeconds = Math.trunc(entry.activityAt / 1000);
      return [{
        agentNickname: prior?.agentNickname ?? null,
        agentRole: prior?.agentRole ?? null,
        createdAt: prior?.createdAt ?? activitySeconds,
        cwd: prior?.cwd ?? state.projectRootPath,
        harness: entry.identity.harness,
        id: entry.identity.threadId,
        name: entry.title,
        path: prior?.path ?? null,
        preview: entry.title,
        source: prior?.source ?? "workbench",
        status: entry.lifecycle.kind === "working" ? "active" : "idle",
        updatedAt: activitySeconds,
      }];
    });
    // The sidebar snapshot owns the live title, so keep any open document copy in step.
    for (const entry of activeProjectSnapshot.entries) {
      if (entry.entryKind !== "thread") continue;
      const thread = { harness: entry.identity.harness, id: entry.identity.threadId };
      const source = threadSources.get(getThreadSourceKey(thread));
      if (!source || (source.name === entry.title && source.preview === entry.title)) continue;
      updateThreadSourceFields(thread, { name: entry.title, preview: entry.title });
    }
    state.threadsError = activeProjectSnapshot.error ?? "";
    state.hasLoadedThreads = activeProjectSnapshot.freshness !== "loading";
    state.isLoading = activeProjectSnapshot.freshness === "loading";
    emit();
  }

  function isThreadOperationIdentityCurrent(fence: ThreadOperationFence) {
    if (fence.ownerIsCurrent) return !disposed && fence.ownerIsCurrent();
    return !disposed
      && fence.projectContextGeneration === projectContextGeneration
      && fence.projectId === state.projectId
      && fence.projectRootPath === state.projectRootPath
      && fence.threadProjectContextGeneration === threadProjectContextGeneration
      && (fence.selectedThreadKey === null || fence.selectedThreadKey === threadDocuments.getSelectedThreadKey());
  }

  function isThreadOperationOwnerFenceCurrent(fence: ThreadOperationFence) {
    return isThreadOperationIdentityCurrent(fence)
      && fence.sourceRevision === threadSources.getRevision(fence.threadKey)
      && fence.stablePreferenceRevision === getStablePreferenceRevision(fence.threadKey)
      && fence.statusRevision === getStatusRevision(fence.threadKey);
  }

  function isThreadOperationFenceCurrent(fence: ThreadOperationFence) {
    const overlay = getOverlayRevisionRecord(fence.threadKey);
    return isThreadOperationOwnerFenceCurrent(fence)
      && fence.overlayRevisions.browseResultRevision === overlay.browseResultRevision
      && fence.overlayRevisions.optimisticRevision === overlay.optimisticRevision
      && fence.overlayRevisions.questionnaireForceProjectionEpoch === overlay.questionnaireForceProjectionEpoch
      && fence.overlayRevisions.questionnaireRevision === overlay.questionnaireRevision
      && fence.overlayRevisions.steerRevision === overlay.steerRevision;
  }

  function isHistoricalThreadReadFenceCurrent(fence: ThreadOperationFence) {
    return isThreadOperationIdentityCurrent(fence)
      && threadSources.has(fence.threadKey);
  }

  function isThreadReadFenceCurrent(fence: ThreadOperationFence) {
    if (!isThreadOperationIdentityCurrent(fence)) {
      return false;
    }
    return fence.sourceRevision === threadSources.getRevision(fence.threadKey)
      || threadSources.has(fence.threadKey);
  }

  function captureProjectOperationIdentity(): ProjectOperationIdentity {
    return {
      projectContextGeneration,
      projectId: state.projectId,
      projectRootPath: state.projectRootPath,
      threadProjectContextGeneration,
    };
  }

  function isProjectOperationIdentityCurrent(identity: ProjectOperationIdentity) {
    return !disposed
      && identity.projectContextGeneration === projectContextGeneration
      && identity.projectId === state.projectId
      && identity.projectRootPath === state.projectRootPath
      && identity.threadProjectContextGeneration === threadProjectContextGeneration;
  }

  function commitThreadOperation<TResult>(
    fence: ThreadOperationFence,
    responseThread: ThreadPayload,
    commit: () => TResult,
  ) {
    if (
      getThreadSourceKey(responseThread) !== fence.threadKey
      || !isThreadOperationFenceCurrent(fence)
    ) {
      return null;
    }
    return commit();
  }

  function commitThreadReadResult<TResult>(
    fence: ThreadOperationFence,
    cursor: string | null,
    result: ThreadReadResult,
    commit: (payload: ThreadPayload) => TResult,
  ) {
    if (cursor !== null) {
      if (!isHistoricalThreadReadFenceCurrent(fence)) {
        return null;
      }
      if (getThreadSourceKey(result.payload) !== fence.threadKey) {
        throw new Error("Canonical historical page returned a different thread identity.");
      }
      const beforeTurnIndex = result.payload.turnHistory.findIndex((entry) => entry.turnId === cursor);
      if (beforeTurnIndex < 0) {
        throw new Error("Canonical historical page omitted its requested cursor boundary.");
      }
      const expectedTurnId = beforeTurnIndex > 0 ? result.payload.turnHistory[beforeTurnIndex - 1]?.turnId ?? null : null;
      if (
        result.payload.turns.length !== (expectedTurnId ? 1 : 0)
        || result.payload.turns.some((turn) => turn.id !== expectedTurnId)
      ) {
        throw new Error(`Canonical historical page returned ${result.payload.turns.length} bodies instead of its exact predecessor.`);
      }
      const currentSource = threadSources.get(fence.threadKey);
      if (!currentSource) {
        return null;
      }
      const liveTurnsById = new Map(currentSource.turns.map((turn) => [turn.id, turn]));
      const turnHistory = mergeThreadTurnHistory(result.payload.turnHistory, currentSource.turnHistory);
      const streaming = getThreadStreaming(fence.threadKey);
      const incomingTurns = result.payload.turns.map((turn) => mergeLiveStreamingTurn(turn, liveTurnsById.get(turn.id), streaming));
      const historicalPayload: ThreadPayload = {
        ...currentSource,
        nextPageCursor: result.payload.nextPageCursor,
        turnHistory,
        turns: mergeThreadTurnBodies(incomingTurns, currentSource.turns, turnHistory),
      };
      setThreadContextReadEntries(historicalPayload.id, result.pageResponse, historicalPayload.turnHistory);
      return commit(historicalPayload);
    }

    if (
      getThreadSourceKey(result.payload) !== fence.threadKey
      || !isThreadReadFenceCurrent(fence)
    ) {
      return null;
    }
    const currentSource = threadSources.get(fence.threadKey);
    const stablePreferenceAdvanced = fence.stablePreferenceRevision !== getStablePreferenceRevision(fence.threadKey);
    const statusAdvanced = fence.statusRevision !== getStatusRevision(fence.threadKey);
    let payload = mergeLiveStreamingThreadSnapshot(result.payload, {
      preserveUnmatchedLiveItems: true,
    });
    if (stablePreferenceAdvanced && currentSource) {
      payload = {
        ...payload,
        agentNickname: currentSource.agentNickname,
        agentPath: currentSource.agentPath,
        agentRole: currentSource.agentRole,
        model: currentSource.model,
        reasoningEffort: currentSource.reasoningEffort,
        serviceTier: currentSource.serviceTier,
        tokenUsage: currentSource.tokenUsage,
      };
    }
    if (statusAdvanced && currentSource) {
      payload = {
        ...payload,
        status: findDocumentController(fence.threadKey)?.getStatus() ?? currentSource.status,
      };
    }
    setThreadContextReadEntries(payload.id, result.pageResponse, payload.turnHistory, fence);
    return commit(payload);
  }

  function installAuthoritativeThreadSource(thread: ThreadPayload) {
    const rawThread = stripProjectedThreadSource(thread);
    const sourceThread = prepareCanonicalThreadSource(rawThread) ?? rawThread;
    captureStablePreferenceSource(sourceThread);
    setThreadStatusSource(
      sourceThread,
      state.pendingUserInputRequestsByThreadId.has(sourceThread.id)
        ? addThreadActiveFlag(sourceThread.status, "waitingOnUserInput")
        : sourceThread.status,
    );
    const key = threadSources.install(sourceThread);
    return key;
  }

  function commitCanonicalThreadSource(thread: ThreadPayload) {
    const rawThread = stripProjectedThreadSource(thread);
    const sourceThread = prepareCanonicalThreadSource(rawThread) ?? rawThread;
    const key = threadSources.install(sourceThread);
    return key;
  }

  function projectThreadSource(key: string) {
    return findDocumentController(key)?.render({
      selected: key === threadDocuments.getSelectedThreadKey(),
    }) ?? null;
  }

  function materializeFinalVisibleThread(key: string, options: { select?: boolean } = {}) {
    const rawThread = threadSources.get(key);
    if (!rawThread) {
      if (options.select) {
        threadDocuments.selectDocumentKey("");
      }
      return null;
    }

    return findDocumentController(key)?.materialize({ select: options.select }) ?? null;
  }

  function refreshFinalVisibleThreadForOverlay(threadId: string) {
    const selectedThreadKey = threadDocuments.getSelectedThreadKey();
    const previousSnapshot = threadDocuments.getSnapshot();
    let didFlushSelectedThread = false;
    for (const key of getOverlayKeysForThreadId(threadId)) {
      if (key === selectedThreadKey) {
        didFlushSelectedThread = true;
        flushSelectedThreadRendering();
      } else {
        materializeFinalVisibleThread(key);
      }
    }

    if (previousSnapshot !== threadDocuments.getSnapshot() && !didFlushSelectedThread) {
      emit();
    }
  }

  function setProjectedCurrentThread(
    nextThread: ThreadPayload | null,
    {
      publishRuntime = true,
    }: {
      publishRuntime?: boolean;
    } = {},
  ) {
    if (areThreadPayloadsEquivalent(state.currentThread, nextThread)) {
      return;
    }

    const previousThread = state.currentThread;
    const selectionChanged = !previousThread || !nextThread || previousThread.id !== nextThread.id || previousThread.harness !== nextThread.harness;
    state.currentThread = nextThread;
    state.currentThreadId = nextThread?.id ?? "";
    if (selectionChanged) {
    }
    if (publishRuntime) emit();
    if (selectionChanged) scheduleActiveTurnRateLimitRefresh();

    if (!nextThread) {
      return;
    }

    if (selectionChanged) {
      void account.refreshIfStale(nextThread.harness);
    }
  }

  function flushSelectedThreadRendering(options: {
    publishRuntime?: boolean;
  } = {}) {
    const selectedThreadKey = threadDocuments.getSelectedThreadKey();
    if (!selectedThreadKey) {
      threadDocuments.selectDocumentKey("");
      setProjectedCurrentThread(null);
      return;
    }

    const projectedThread = materializeFinalVisibleThread(selectedThreadKey, { select: true });
    setProjectedCurrentThread(projectedThread, options);
  }

  function upsertThreadDocument(
    thread: ThreadPayload,
    options: {
      emitChange?: boolean;
      preserveStableServiceTier?: boolean;
      select?: boolean;
    } = {},
  ) {
    const sourceKey = installAuthoritativeThreadSource(thread);
    if (options.select) {
      threadDocuments.selectDocumentKey(sourceKey);
    }
    const previousSnapshot = threadDocuments.getSnapshot();
    const document = materializeFinalVisibleThread(sourceKey, { select: options.select }) ?? threadSources.get(sourceKey) ?? thread;
    if (options.emitChange && previousSnapshot !== threadDocuments.getSnapshot()) {
      emit();
    }
    return document;
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

    return areDeeplyEqual(leftTurn, rightTurn);
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
      && left.agentNickname === right.agentNickname
      && left.agentRole === right.agentRole
      && areDeeplyEqual(left.browseResultEntries ?? [], right.browseResultEntries ?? [])
      && areDeeplyEqual(left.tokenUsage, right.tokenUsage)
      && areDeeplyEqual(left.turnHistory, right.turnHistory)
      && areTurnListsEquivalent(left.turns, right.turns)
      && areCurrentTurnsEquivalent(left, right);
  }

  function isWorkbenchSyntheticUserMessageItem(item: ThreadItem) {
    return isOptimisticUserMessageItem(item) || isSyntheticSteerHistoryItem(item);
  }

  function mergeDuplicateNormalizedThreadItem(existingItem: ThreadItem, incomingItem: ThreadItem) {
    if (existingItem.type === "userMessage" && incomingItem.type === "userMessage") {
      const existingIsSynthetic = isWorkbenchSyntheticUserMessageItem(existingItem);
      const incomingIsSynthetic = isWorkbenchSyntheticUserMessageItem(incomingItem);
      if (existingIsSynthetic && !incomingIsSynthetic) {
        return incomingItem;
      }

      if (!existingIsSynthetic && incomingIsSynthetic) {
        return existingItem;
      }
    }

    return mergeLiveStreamingItem(existingItem, incomingItem);
  }

  function normalizeThreadPayloadItems(thread: ThreadPayload | null) {
    if (!thread) {
      return thread;
    }

    let changed = false;
    const turns = thread.turns.map((turn) => {
      const items = normalizeThreadItems(turn.items, { mergeDuplicateItems: mergeDuplicateNormalizedThreadItem });
      if (items === turn.items) {
        return turn;
      }

      changed = true;
      return {
        ...turn,
        items,
      };
    });

    return changed ? { ...thread, turns } : thread;
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

    void account.refreshIfStale(harness);

    lifecycle.scheduleRepeat(RATE_LIMIT_REFRESH_TASK_ID, RATE_LIMIT_REFRESH_INTERVAL_MS, () => {
      if (disposed || state.currentThread?.harness !== harness || !getCurrentInProgressTurn(state.currentThread)) {
        lifecycle.cancel(RATE_LIMIT_REFRESH_TASK_ID);
        return;
      }

      return account.refreshIfStale(harness);
    });
  }

  function setCurrentThread(
    thread: ThreadPayload | null,
    _options: {
      preserveStableServiceTier?: boolean;
    } = {},
  ) {
    if (!thread) {
      threadDocuments.selectDocumentKey("");
      flushSelectedThreadRendering();
      return;
    }

    const sourceKey = installAuthoritativeThreadSource(thread);
    threadDocuments.selectDocumentKey(sourceKey);
    flushSelectedThreadRendering();
  }

  function deleteThreadOwnedState(key: string) {
    const didDeleteSource = threadSources.delete(key);
    const didDeleteDocument = threadDocuments.deleteDocumentKey(key);
    optimisticInputs.deleteThread(key);
    return didDeleteSource || didDeleteDocument;
  }

  function releaseHistoricalTurns(
    harness: WorkbenchHarness,
    threadId: string,
    candidateTurnIds: readonly string[],
  ) {
    const key = getThreadStateKey(harness, threadId);
    const source = threadSources.get(key);
    if (!source || source.isDraft || source.turns.length <= 1) return source;

    const currentTurnId = source.turns.at(-1)?.id;
    const releasedTurnIds = new Set(candidateTurnIds.filter((turnId) => turnId !== currentTurnId
      && source.turns.some((turn) => turn.id === turnId)));
    if (!releasedTurnIds.size) return source;

    const turns = source.turns.filter((turn) => !releasedTurnIds.has(turn.id));
    const retainedTurnIds = new Set(turns.map(({ id }) => id));
    const turnHistory = source.turnHistory.map((entry) => {
      if (!releasedTurnIds.has(entry.turnId)) return entry;
      const { itemIds: _itemIds, itemTimeline: _itemTimeline, ...metadata } = entry;
      return { ...metadata, loadState: "unloaded" as const };
    });
    const earliestRetainedHistoryIndex = turnHistory.findIndex((entry) => retainedTurnIds.has(entry.turnId));
    const nextPageCursor = earliestRetainedHistoryIndex > 0
      ? turnHistory[earliestRetainedHistoryIndex]!.turnId
      : null;
    const nextSource: ThreadPayload = {
      ...source,
      browseResultEntries: (source.browseResultEntries ?? []).filter((entry) => !releasedTurnIds.has(entry.turnId)),
      nextPageCursor,
      turnHistory,
      turns,
    };

    function pruneEntries<TEntry extends { turnId: string }>(
      entries: Map<string, TEntry[]>,
      revisionKey: keyof ThreadDocumentOverlayRevision,
    ) {
      const current = entries.get(threadId) ?? [];
      const retained = current.filter((entry) => !releasedTurnIds.has(entry.turnId));
      if (retained.length === current.length) return;
      if (retained.length) entries.set(threadId, retained);
      else entries.delete(threadId);
      bumpOverlayRevisionForKey(key, revisionKey);
    }

    pruneEntries(state.browseResultEntriesByThreadId, "browseResultRevision");
    pruneEntries(state.questionnaireHistoryByThreadId, "questionnaireRevision");
    pruneEntries(state.steerHistoryByThreadId, "steerRevision");
    threadSources.install(nextSource);
    findDocumentController(key)?.invalidateProjection();
    const selected = threadDocuments.getSelectedThreadKey() === key;
    const retained = materializeFinalVisibleThread(key, { select: selected }) ?? nextSource;
    if (selected) setProjectedCurrentThread(retained, { publishRuntime: false });
    emit();
    return retained;
  }

  function updateThreadSource(
    key: string,
    updater: (thread: ThreadPayload) => ThreadPayload | null,
    options: {
      preserveStableServiceTier?: boolean;
      publishSelected?: boolean;
      pruneStreamingDuplicates?: boolean;
    } = {},
  ) {
    const currentSource = threadSources.get(key);
    if (!currentSource) {
      return false;
    }

    const nextThread = updater(currentSource);
    if (!nextThread) {
      return false;
    }

    const nextKey = getThreadSourceKey(nextThread);
    if (nextKey !== key) {
      throw new Error(`Canonical thread update cannot change key from ${key} to ${nextKey}.`);
    }
    commitCanonicalThreadSource(nextThread);
    if (threadDocuments.getSelectedThreadKey() === key) {
      flushSelectedThreadRendering({
        publishRuntime: options.publishSelected,
      });
    }
    return true;
  }

  function updateCurrentThread(
    updater: (thread: ThreadPayload) => ThreadPayload | null,
    options: {
      preserveStableServiceTier?: boolean;
      pruneStreamingDuplicates?: boolean;
    } = {},
  ) {
    const selectedThreadKey = threadDocuments.getSelectedThreadKey();
    return selectedThreadKey
      ? updateThreadSource(selectedThreadKey, updater, options)
      : false;
  }

  function updateCanonicalThreadFields(key: string, fields: Partial<Omit<ThreadPayload, "turns" | "id" | "isDraft">>) {
    const hasField = (field: keyof typeof fields) => Object.prototype.hasOwnProperty.call(fields, field);
    return updateThreadSource(key, (thread) => ({
      ...thread,
      ...fields,
      agentNickname: hasField("agentNickname") ? fields.agentNickname ?? null : thread.agentNickname,
      agentPath: hasField("agentPath") ? fields.agentPath ?? null : thread.agentPath,
      agentRole: hasField("agentRole") ? fields.agentRole ?? null : thread.agentRole,
      model: hasField("model") ? fields.model ?? null : thread.model,
      name: hasField("name") ? fields.name ?? null : thread.name,
      reasoningEffort: hasField("reasoningEffort") ? fields.reasoningEffort ?? null : thread.reasoningEffort,
      serviceTier: hasField("serviceTier") ? fields.serviceTier ?? null : thread.serviceTier,
      tokenUsage: hasField("tokenUsage") ? fields.tokenUsage ?? null : thread.tokenUsage,
    }), { preserveStableServiceTier: false });
  }

  function updateCurrentThreadFields(fields: Partial<Omit<ThreadPayload, "turns" | "id" | "isDraft">>) {
    const selectedThreadKey = threadDocuments.getSelectedThreadKey();
    return selectedThreadKey ? updateCanonicalThreadFields(selectedThreadKey, fields) : false;
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

    if (
      incomingItem.type === "fileChange"
      && liveItem.type === "fileChange"
      && incomingItem.status === "inProgress"
      && liveItem.status === "inProgress"
    ) {
      return {
        ...incomingItem,
        changes: incomingItem.changes.length ? incomingItem.changes : liveItem.changes,
      };
    }

    return incomingItem;
  }

  function isOptimisticUserMessageItem(item: ThreadItem) {
    return getWorkbenchInputState(item)?.kind === "optimistic";
  }

  function getOptimisticThreadSource(harness: WorkbenchHarness, threadId: string) {
    const key = getThreadStateKey(harness, threadId);
    return threadSources.get(key)
      ?? threadDocuments.getDocumentByKey(key)
      ?? (state.currentThread?.harness === harness && state.currentThread.id === threadId ? state.currentThread : null);
  }

  function enqueueOptimisticUserMessage(
    harness: WorkbenchHarness,
    threadId: string,
    turnId: string,
    input: UserInput[],
    placement: OptimisticUserMessagePlacement,
    status: OptimisticUserMessageStatus,
    sourceThread?: ThreadPayload,
  ) {
    const thread = sourceThread ?? getOptimisticThreadSource(harness, threadId);
    if (!thread) {
      throw new Error(`Cannot enqueue optimistic input for unknown thread ${harness}:${threadId}.`);
    }
    const entry = placement === "steer"
      ? optimisticInputs.enqueueSteer(thread, turnId, input, status)
      : optimisticInputs.enqueueInitial(thread, turnId, input, { status });
    bumpOverlayRevisionForKey(entry.threadKey, "optimisticRevision");
    return entry.item;
  }

  function updateOptimisticUserMessageStatus(
    harness: WorkbenchHarness,
    threadId: string,
    _turnId: string,
    itemId: string,
    status: OptimisticUserMessageStatus,
  ) {
    const result = status === "pending"
      ? null
      : optimisticInputs.transition(itemId, status);
    if (!result) {
      return false;
    }
    bumpOverlayRevisionForKey(getThreadStateKey(harness, threadId), "optimisticRevision");
    return true;
  }

  function updatePendingOptimisticSteersForTurn(
    harness: WorkbenchHarness,
    threadId: string,
    turnId: string,
    status: Extract<OptimisticUserMessageStatus, "interrupted" | "failed">,
  ) {
    const key = getThreadStateKey(harness, threadId);
    const changed = optimisticInputs.transitionPendingSteers(key, turnId, status);
    if (changed) {
      bumpOverlayRevisionForKey(key, "optimisticRevision");
    }
    return changed;
  }

  function refreshCurrentThreadOptimisticUserMessages() {
    const threadId = state.currentThread?.id;
    if (!threadId) {
      return false;
    }
    refreshFinalVisibleThreadForOverlay(threadId);
    return true;
  }

  function applyOptimisticUserMessageOverlay(thread: ThreadPayload | null) {
    return thread
      ? optimisticInputs.apply(thread, state.steerHistoryByThreadId.get(thread.id) ?? [])
      : null;
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
    if (isSyntheticQuestionnaireHistoryItem(liveItem)) {
      return false;
    }

    if (incomingTurn.itemsView === "full" && getWorkbenchThreadItemIdentityKind(liveItem) === "provisional") {
      return false;
    }

    if (preserveAllUnmatchedLiveItems) {
      return true;
    }

    if (preserveToolItemsFromThinnerTurn && isToolLikeThreadItem(liveItem)) {
      return true;
    }

    return incomingTurn.status === "inProgress"
      && liveTurn.status === "inProgress"
      && (liveItem.type === "agentMessage" || liveItem.type === "reasoning");
  }

  function mergeLiveStreamingTurn(
    incomingTurn: Turn,
    liveTurn: Turn | undefined,
    streaming: ThreadDocumentController["streaming"],
    options: {
      preserveUnmatchedLiveItems?: boolean;
      settleStreamingKeys?: boolean;
    } = {},
  ) {
    if (!liveTurn) {
      return incomingTurn;
    }

    if (
      incomingTurn.itemsView === "full"
      && incomingTurn.status !== "inProgress"
      && liveTurn.status !== "inProgress"
      && !streaming.hasClientCreatedItemForTurn(incomingTurn.id)
      && !options.preserveUnmatchedLiveItems
    ) {
      return incomingTurn;
    }

    const liveItemsById = new Map(liveTurn.items.map((item) => [item.id, item]));
    const preserveAllUnmatchedLiveItems = options.preserveUnmatchedLiveItems
      || shouldPreserveUnmatchedLiveTurnItems(incomingTurn, liveTurn);
    const preserveToolItemsFromThinnerTurn = incomingTurn.itemsView === "full"
      && incomingTurn.items.length < liveTurn.items.length;
    const nextItems = incomingTurn.items.map((item) => {
      const liveItem = liveItemsById.get(item.id);
      let matchedLiveItem: ThreadItem | null = null;
      if (!liveItem) {
        for (const [liveItemId, candidateLiveItem] of liveItemsById) {
          if (
            streaming.hasClientCreatedItemKey(getThreadItemKey(incomingTurn.id, liveItemId))
            && streaming.isStructurallyMatchingItem(item, candidateLiveItem)
          ) {
            matchedLiveItem = candidateLiveItem;
            liveItemsById.delete(liveItemId);
            streaming.forgetStreamingItemKey(getThreadItemKey(incomingTurn.id, liveItemId), options);
            break;
          }
        }
        return matchedLiveItem ? mergeLiveStreamingItem(item, matchedLiveItem) : item;
      }

      liveItemsById.delete(item.id);
      streaming.forgetStreamingItemKey(getThreadItemKey(incomingTurn.id, item.id), options);
      return mergeLiveStreamingItem(item, liveItem);
    });

    for (const liveItem of liveItemsById.values()) {
      if (shouldPreserveUnmatchedLiveItem(incomingTurn, liveTurn, liveItem, preserveAllUnmatchedLiveItems, preserveToolItemsFromThinnerTurn)) {
        nextItems.push(liveItem);
      }
    }

    return {
      ...incomingTurn,
      itemsView: incomingTurn.itemsView === "full" || liveTurn.itemsView === "notLoaded"
        ? incomingTurn.itemsView
        : liveTurn.itemsView,
      items: streaming.pruneDuplicateItems(incomingTurn.id, nextItems, mergeLiveStreamingItem, options),
    };
  }

  function mergeLiveStreamingThreadSnapshot(
    incomingThread: ThreadPayload,
    options: { preserveUnmatchedLiveItems?: boolean } = {},
  ) {
    const liveThread = threadSources.get(getThreadSourceKey(incomingThread));
    if (!liveThread || liveThread.id !== incomingThread.id || liveThread.harness !== incomingThread.harness) {
      return ensureThreadHistory(incomingThread);
    }

    const liveTurnsById = new Map(liveThread.turns.map((turn) => [turn.id, turn]));
    const turnHistory = mergeThreadTurnHistory(incomingThread.turnHistory, liveThread.turnHistory);
    const streaming = getThreadStreaming(getThreadSourceKey(incomingThread));
    const incomingTurns = incomingThread.turns.map((turn) => mergeLiveStreamingTurn(
      turn,
      liveTurnsById.get(turn.id),
      streaming,
      options,
    ));
    return {
      ...incomingThread,
      agentNickname: incomingThread.agentNickname ?? liveThread.agentNickname,
      agentPath: incomingThread.agentPath ?? liveThread.agentPath,
      agentRole: incomingThread.agentRole ?? liveThread.agentRole,
      model: incomingThread.model ?? liveThread.model,
      name: incomingThread.name ?? liveThread.name,
      nextPageCursor: Object.hasOwn(incomingThread, "nextPageCursor")
        ? incomingThread.nextPageCursor ?? null
        : liveThread.nextPageCursor ?? null,
      preview: incomingThread.preview.trim() ? incomingThread.preview : liveThread.preview,
      reasoningEffort: incomingThread.reasoningEffort ?? liveThread.reasoningEffort,
      serviceTier: incomingThread.serviceTier ?? liveThread.serviceTier,
      turnHistory,
      turns: mergeThreadTurnBodies(incomingTurns, liveThread.turns, turnHistory),
    };
  }


  async function requestThreadPage(
    threadId: string,
    harness: WorkbenchHarness,
    options: WorkbenchReadThreadOptions = {},
    recover?: () => Promise<void>,
  ): Promise<WorkbenchThreadPageResponse> {
    const input = {
      threadId,
      cursor: options.cursor ?? null,
      ...(options.readScope ? { readScope: options.readScope } : {}),
      recoveryAware: true,
    };
    const reconcile = recover ?? (async () => {
      await daemon.threads.reconcile({
        threadId, target: input.cursor ? { mode: "previous", beforeTurnId: input.cursor } : { mode: "latest" }, refresh: false,
      });
    });
    let page: WorkbenchThreadPageResponse;
    try {
      page = await daemon.threads.page(input);
    } catch (error) {
      if (!(error instanceof WorkbenchDaemonRequestError) || error.code !== WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED) throw error;
      await reconcile();
      page = await daemon.threads.page(input);
      if (page.recovery) throw new Error("Requested transcript history is still unavailable after reconciliation.");
      return page;
    }
    if (!page.recovery) return page;
    await reconcile();
    page = await daemon.threads.page(input);
    if (page.recovery) throw new Error("Requested transcript history is still unavailable after reconciliation.");
    return page;
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
      && areDeeplyEqual(existing.request, request)
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
    bumpPendingUserInputRequestGeneration(harness);
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
    bumpPendingUserInputRequestGeneration(existing.harness);
    return true;
  }

  function clearThreadWaitingOnUserInputFlag(threadId: string) {
    let changed = false;
    if (state.currentThread?.id === threadId) {
      const nextStatus = removeThreadActiveFlag(state.currentThread.status, "waitingOnUserInput");
      if (nextStatus !== state.currentThread.status) {
        setThreadStatusSource(state.currentThread, nextStatus);
        refreshFinalVisibleThreadForOverlay(threadId);
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
      return { ...thread, status: nextStatus };
    });

    return changed;
  }

  function markThreadWaitingOnUserInput(threadId: string) {
    let changed = false;
    if (state.currentThread?.id === threadId) {
      const nextStatus = addThreadActiveFlag(state.currentThread.status, "waitingOnUserInput");
      if (nextStatus !== state.currentThread.status) {
        setThreadStatusSource(state.currentThread, nextStatus);
        refreshFinalVisibleThreadForOverlay(threadId);
        changed = true;
      }
    }

    state.threads = state.threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }

      const nextStatus = addThreadActiveFlag(thread.status, "waitingOnUserInput");
      if (nextStatus === thread.status) {
        return thread;
      }

      changed = true;
      return { ...thread, status: nextStatus };
    });

    return changed;
  }

  function replacePendingUserInputRequests(
    harness: WorkbenchHarness,
    requests: WorkbenchPendingUserInputRequest[],
  ) {
    const priorHarnessThreadIds = Array.from(state.pendingUserInputRequestsByThreadId.values())
      .filter((entry) => entry.harness === harness)
      .map((entry) => entry.threadId);
    const nextRequests = new Map(
      Array.from(state.pendingUserInputRequestsByThreadId.entries()).filter(([, entry]) => entry.harness !== harness),
    );
    for (const request of requests) {
      nextRequests.set(request.threadId, request);
    }
    for (const entry of observedQuestionnaireEntries()) {
      if (entry.entryKind === "draft" || entry.identity.harness !== harness || !entry.pendingQuestionnaire) continue;
      if (resolvedDurableQuestionnaireKeysByThreadId.get(entry.identity.threadId) === entry.pendingQuestionnaire.requestKey) continue;
      if (!nextRequests.has(entry.identity.threadId)) {
        nextRequests.set(entry.identity.threadId, {
          harness,
          itemId: entry.pendingQuestionnaire.itemId ?? null,
          request: entry.pendingQuestionnaire.request,
          requestKey: entry.pendingQuestionnaire.requestKey,
          threadId: entry.identity.threadId,
          turnId: entry.pendingQuestionnaire.turnId ?? null,
        });
      }
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
          || !areDeeplyEqual(existing.request, request.request)
        ) {
          unchanged = false;
          break;
        }
      }
      const statusChanged = requests.some((request) => markThreadWaitingOnUserInput(request.threadId));
      if (unchanged && !statusChanged) {
        return false;
      }
      if (unchanged) {
        return true;
      }
    }

    state.pendingUserInputRequestsByThreadId = nextRequests;
    bumpPendingUserInputRequestGeneration(harness);
    for (const request of nextRequests.values()) {
      markThreadWaitingOnUserInput(request.threadId);
    }
    for (const threadId of priorHarnessThreadIds) {
      if (!nextRequests.has(threadId)) clearThreadWaitingOnUserInputFlag(threadId);
    }
    return true;
  }

  async function refreshPendingUserInputRequests(harness: WorkbenchHarness) {
    const existing = questionnaireListSyncPromisesByHarness.get(harness);
    if (existing) return await existing;
    const generation = projectContextGeneration;
    const questionnaireGeneration = getPendingUserInputRequestGeneration(harness);
    const promise = (async () => {
      let requests: WorkbenchPendingUserInputRequest[] = [];
      try {
        const response = await daemon.questionnaires.pending();
        requests = response.data.filter(request => request.harness === harness);
      } catch (error) {
        emitStatusMessage(`Workbench could not reconcile ${harness} questionnaires: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (disposed || generation !== projectContextGeneration) return false;
      if (questionnaireGeneration !== getPendingUserInputRequestGeneration(harness)) return false;
      questionnaireListSyncedHarnesses.add(harness);
      providerPendingUserInputRequestsByHarness.set(
        harness,
        new Map(requests.map((request) => [request.threadId, request])),
      );
      if (replacePendingUserInputRequests(harness, requests)) emit();
      return true;
    })().finally(() => questionnaireListSyncPromisesByHarness.delete(harness));
    questionnaireListSyncPromisesByHarness.set(harness, promise);
    return await promise;
  }

  function createDraftThreadId() {
    return DraftIdSchema.parse(crypto.randomUUID());
  }

  function isDraftThreadId(threadId: string): threadId is DraftId {
    return threadDocuments.getDocumentByThreadId(threadId)?.isDraft === true;
  }

  function createDraftThread(harness: WorkbenchHarness, threadId: DraftId = createDraftThreadId()): ThreadPayload<DraftId> {
    const timestampSeconds = Math.floor(Date.now() / 1000);
    return {
      id: threadId,
      harness,
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      agentPath: null,
      isDraft: true,
      name: "Create new thread",
      preview: "",
      createdAt: timestampSeconds,
      updatedAt: timestampSeconds,
    status: "idle",
    cwd: state.projectRootPath || state.projectRoot,
    source: harness,
    path: null,
    agentNickname: null,
    agentRole: null,
    tokenUsage: null,
    turnHistory: [],
    turns: [],
  };
}

  function getKnownThreadHarness(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return state.currentThread.harness;
    }

    return state.threads.find((thread) => thread.id === threadId)?.harness ?? null;
  }

  function getThreadHarness(threadId: string, fallback: WorkbenchHarness = defaultProviderKey) {
    return getKnownThreadHarness(threadId) ?? fallback;
  }

  function getThreadHarnessCandidates(threadId: string, harness?: WorkbenchHarness) {
    const knownHarness = harness ?? getKnownThreadHarness(threadId);
    return knownHarness ? [knownHarness] : [...installedProviderKeys];
  }

  function getThreadModel(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return findDocumentController(getThreadSourceKey(state.currentThread))?.getStablePreferences()?.model ?? state.currentThread.model;
    }

    return null;
  }

  function getThreadReasoningEffort(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return findDocumentController(getThreadSourceKey(state.currentThread))?.getStablePreferences()?.reasoningEffort ?? state.currentThread.reasoningEffort;
    }

    return null;
  }

  function getThreadServiceTier(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return findDocumentController(getThreadSourceKey(state.currentThread))?.getStablePreferences()?.serviceTier ?? state.currentThread.serviceTier;
    }

    return null;
  }

  function resolvePreferredReasoningEffort(harness: WorkbenchHarness, modelId: string | null) {
    if (!modelId) {
      return null;
    }

    const selectedModel = account.getModels(harness).find((model) => model.id === modelId) ?? null;
    if (!selectedModel?.supportsReasoningEffort) {
      return null;
    }

    return selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? null;
  }

  async function listModels(harness: WorkbenchHarness, options: WorkbenchListModelsOptions = {}) {
    return await account.listModels(harness, options);
  }

  function setQuestionnaireHistoryEntries(threadId: string, entries: WorkbenchQuestionnaireHistoryEntry[]) {
    const durableEntries = observedQuestionnaireEntries().flatMap((entry) => (
      entry.entryKind !== "draft" && entry.identity.threadId === threadId
        ? (entry.questionnaireHistory ?? []).map(normalizeQuestionnaireHistoryEntryState)
        : []
    ));
    const nextEntries = mergeQuestionnaireHistoryEntries(
      entries.filter((entry) => entry.threadId === threadId),
      durableEntries,
    );
    const existingEntries = state.questionnaireHistoryByThreadId.get(threadId) ?? [];
    if (areDeeplyEqual(existingEntries, nextEntries)) {
      return false;
    }

    if (nextEntries.length) {
      state.questionnaireHistoryByThreadId.set(threadId, nextEntries);
    } else {
      state.questionnaireHistoryByThreadId.delete(threadId);
    }
    bumpOverlayRevision(threadId, "questionnaireRevision");
    return true;
  }

  function refreshFinalVisibleQuestionnaireHistory(threadId: string) {
    refreshFinalVisibleThreadForOverlay(threadId);
  }

  function setSteerHistoryEntries(threadId: string, entries: WorkbenchSteerHistoryEntry[]) {
    const nextEntries = entries.filter((entry) => entry.threadId === threadId);
    const existingEntries = state.steerHistoryByThreadId.get(threadId) ?? [];
    if (areDeeplyEqual(existingEntries, nextEntries)) {
      return false;
    }

    if (nextEntries.length) {
      state.steerHistoryByThreadId.set(threadId, nextEntries);
    } else {
      state.steerHistoryByThreadId.delete(threadId);
    }
    bumpOverlayRevision(threadId, "steerRevision");
    return true;
  }

  function refreshFinalVisibleSteerHistory(threadId: string) {
    refreshFinalVisibleThreadForOverlay(threadId);
  }

  function setBrowseResultEntries(threadId: string, entries: WorkbenchBrowseResultEntry[] = []) {
    const nextEntries = entries.filter((entry) => entry.threadId === threadId);
    const existingEntries = state.browseResultEntriesByThreadId.get(threadId) ?? [];
    if (areDeeplyEqual(existingEntries, nextEntries)) {
      return false;
    }

    if (nextEntries.length) {
      state.browseResultEntriesByThreadId.set(threadId, nextEntries);
    } else {
      state.browseResultEntriesByThreadId.delete(threadId);
    }
    bumpOverlayRevision(threadId, "browseResultRevision");
    return true;
  }

  function refreshFinalVisibleBrowseResultEntries(threadId: string) {
    refreshFinalVisibleThreadForOverlay(threadId);
  }

  function setThreadContextReadEntries(
    threadId: string,
    response: WorkbenchThreadPageResponse,
    turnHistory: WorkbenchThreadTurnHistoryEntry[],
    readFence?: ThreadOperationFence,
  ) {
    const turnIds = response.entryScope?.mode === "turns" ? response.entryScope.turnIds : null;
    let browseResultEntries = turnIds
      ? mergeScopedThreadContextEntries(state.browseResultEntriesByThreadId.get(threadId) ?? [], response.browseResultEntries, turnIds, turnHistory)
      : response.browseResultEntries;
    let questionnaireEntries = turnIds
      ? mergeScopedThreadContextEntries(state.questionnaireHistoryByThreadId.get(threadId) ?? [], response.questionnaireEntries, turnIds, turnHistory)
      : response.questionnaireEntries;
    let steerEntries = turnIds
      ? mergeScopedThreadContextEntries(state.steerHistoryByThreadId.get(threadId) ?? [], response.steerEntries, turnIds, turnHistory)
      : response.steerEntries;
    if (readFence && !turnIds) {
      const currentOverlay = getOverlayRevisionRecord(readFence.threadKey);
      if (readFence.overlayRevisions.browseResultRevision !== currentOverlay.browseResultRevision) {
        browseResultEntries = mergeThreadContextEntriesByKey(
          browseResultEntries,
          state.browseResultEntriesByThreadId.get(threadId) ?? [],
        );
      }
      if (readFence.overlayRevisions.questionnaireRevision !== currentOverlay.questionnaireRevision) {
        questionnaireEntries = mergeQuestionnaireHistoryEntries(
          questionnaireEntries,
          state.questionnaireHistoryByThreadId.get(threadId) ?? [],
        );
      }
      if (readFence.overlayRevisions.steerRevision !== currentOverlay.steerRevision) {
        steerEntries = mergeThreadContextEntriesByKey(
          steerEntries,
          state.steerHistoryByThreadId.get(threadId) ?? [],
        );
      }
    }
    const browseChanged = setBrowseResultEntries(threadId, browseResultEntries);
    const questionnaireChanged = setQuestionnaireHistoryEntries(threadId, questionnaireEntries);
    const steerChanged = setSteerHistoryEntries(threadId, steerEntries);
    return browseChanged || questionnaireChanged || steerChanged;
  }

  async function readCompletedQuestionnaireHistory(threadId: string, options: { refreshProjection?: boolean } = {}) {
    const key = getThreadStateKey(getThreadHarness(threadId), threadId);
    const generation = (questionnaireHistoryReadGenerationByKey.get(key) ?? 0) + 1;
    const projectGeneration = projectContextGeneration;
    questionnaireHistoryReadGenerationByKey.set(key, generation);
    try {
      const response = await daemon.threads.history.questionnaires({ threadId });
      const entries = response.data ?? [];
      if (projectGeneration !== projectContextGeneration || questionnaireHistoryReadGenerationByKey.get(key) !== generation) {
        return state.questionnaireHistoryByThreadId.get(threadId) ?? [];
      }
      questionnaireHistoryWarningKeys.delete(key);
      const changed = setQuestionnaireHistoryEntries(threadId, entries);
      if (!changed && entries.length) {
        bumpOverlayRevision(threadId, "questionnaireForceProjectionEpoch");
      }
      if ((options.refreshProjection ?? true) && (changed || entries.length)) {
        refreshFinalVisibleQuestionnaireHistory(threadId);
      }
      return entries;
    } catch {
      const retainedEntries = state.questionnaireHistoryByThreadId.get(threadId) ?? [];
      if (projectGeneration !== projectContextGeneration || questionnaireHistoryReadGenerationByKey.get(key) !== generation) {
        return retainedEntries;
      }
      if (!questionnaireHistoryWarningKeys.has(key)) {
        questionnaireHistoryWarningKeys.add(key);
        emitStatusMessage("Unable to refresh questionnaire history; showing the last known answers.");
      }
      return retainedEntries;
    }
  }

  async function readCompletedQuestionnaireHistoryForHarness(threadId: string, harness: WorkbenchHarness) {
    return await readCompletedQuestionnaireHistory(threadId);
  }

  async function readCompletedSteerHistory(threadId: string, options: { refreshProjection?: boolean } = {}) {
    const key = getThreadStateKey(getThreadHarness(threadId), threadId);
    const generation = (steerHistoryReadGenerationByKey.get(key) ?? 0) + 1;
    const projectGeneration = projectContextGeneration;
    steerHistoryReadGenerationByKey.set(key, generation);
    try {
      const response = await daemon.threads.history.steers({ threadId });
      const entries = response.data ?? [];
      if (projectGeneration !== projectContextGeneration || steerHistoryReadGenerationByKey.get(key) !== generation) {
        return state.steerHistoryByThreadId.get(threadId) ?? [];
      }
      steerHistoryWarningKeys.delete(key);
      if (setSteerHistoryEntries(threadId, entries) && (options.refreshProjection ?? true)) {
        refreshFinalVisibleSteerHistory(threadId);
      }
      return entries;
    } catch {
      const retainedEntries = state.steerHistoryByThreadId.get(threadId) ?? [];
      if (projectGeneration !== projectContextGeneration || steerHistoryReadGenerationByKey.get(key) !== generation) {
        return retainedEntries;
      }
      if (!steerHistoryWarningKeys.has(key)) {
        steerHistoryWarningKeys.add(key);
        emitStatusMessage("Unable to refresh steer delivery history; showing the last known state.");
      }
      return retainedEntries;
    }
  }

  async function readBrowseResultEntries(threadId: string, options: { refreshProjection?: boolean } = {}) {
    const key = getThreadStateKey(getThreadHarness(threadId), threadId);
    const generation = (browseResultReadGenerationByKey.get(key) ?? 0) + 1;
    const projectGeneration = projectContextGeneration;
    browseResultReadGenerationByKey.set(key, generation);
    try {
      const response = await daemon.threads.history.browse({ threadId });
      const entries = response.data ?? [];
      if (projectGeneration !== projectContextGeneration || browseResultReadGenerationByKey.get(key) !== generation) {
        return state.browseResultEntriesByThreadId.get(threadId) ?? [];
      }
      if (setBrowseResultEntries(threadId, entries) && (options.refreshProjection ?? true)) {
        refreshFinalVisibleBrowseResultEntries(threadId);
      }
      return entries;
    } catch {
      if (projectGeneration !== projectContextGeneration || browseResultReadGenerationByKey.get(key) !== generation) {
        return state.browseResultEntriesByThreadId.get(threadId) ?? [];
      }
      if (setBrowseResultEntries(threadId, []) && (options.refreshProjection ?? true)) {
        refreshFinalVisibleBrowseResultEntries(threadId);
      }
      return [];
    }
  }

  async function readCompletedThreadWorkbenchHistory(threadId: string) {
    const projectGeneration = projectContextGeneration;
    const [browseResultEntries, questionnaireEntries, steerEntries] = await Promise.all([
      readBrowseResultEntries(threadId, { refreshProjection: false }),
      readCompletedQuestionnaireHistory(threadId, { refreshProjection: false }),
      readCompletedSteerHistory(threadId, { refreshProjection: false }),
    ]);
    if (projectGeneration === projectContextGeneration) {
      refreshFinalVisibleThreadForOverlay(threadId);
    }
    return {
      browseResultEntries,
      questionnaireEntries,
      steerEntries,
    };
  }

  function getDefaultWorkflowIdsForThread(threadId: string) {
    const thread = state.currentThread?.id === threadId
      ? state.currentThread
      : state.threads.find((candidateThread) => candidateThread.id === threadId);
    return thread?.source.toLowerCase().startsWith("subagent")
      ? SUBAGENT_WORKFLOW_IDS
      : DEFAULT_WORKFLOW_IDS;
  }


  async function fetchThreadPayload(
    threadId: string,
    harness: WorkbenchHarness,
    options: WorkbenchReadThreadOptions = {},
    commit: (payload: ThreadPayload) => ThreadPayload | null = (payload) => payload,
    { selectionBound = false, beforeCommit, ownerIsCurrent, recover }: { selectionBound?: boolean; beforeCommit?: () => Promise<void>; ownerIsCurrent?: () => boolean; recover?: () => Promise<void> } = {},
  ): Promise<ThreadPayloadFetchOutcome> {
    const operationFence = captureThreadOperationFence(harness, threadId, { selectionBound, ownerIsCurrent });
    const cursor = options.cursor ?? null;
    const projectContext = effectiveThreadProjectContext(harness, threadId);
    const requestedCwd = options.cwd?.trim() || projectContext.projectRootPath || null;
    const projectRootPaths = getThreadProjectRootPaths(projectContext);
    const currentThread = state.currentThread?.id === threadId && state.currentThread.harness === harness
      ? state.currentThread
      : null;
    const isCurrentThread = currentThread !== null;
    const currentModel = isCurrentThread ? getThreadModel(threadId) : null;
    const currentReasoningEffort = isCurrentThread ? getThreadReasoningEffort(threadId) : null;
    try {
      const selectedAgentPath = isCurrentThread
        ? currentThread?.agentPath ?? null
        : null;

      const pageResponse = await requestThreadPage(threadId, harness, {
        ...options,
        cursor,
        ...(requestedCwd ? { cwd: requestedCwd } : {}),
      }, recover);

      if (projectRootPaths.length && !isProjectThreadAtExpectedCwd(pageResponse.thread, projectRootPaths, options.cwd)) {
        const message = `That ${harness} thread doesn't belong to this project.`;
        if (!isThreadOperationIdentityCurrent(operationFence)) {
          return { kind: "superseded" };
        }
        return {
          failure: { harness, message, transientRollout: false },
          kind: "failure",
        };
      }

      const nextModel = isCurrentThread
        ? currentModel
        : pageResponse.thread.model;
      const nextServiceTier = isCurrentThread
        ? getThreadServiceTier(threadId)
        : pageResponse.thread.serviceTier;
      const result: ThreadReadResult = {
        pageResponse,
        payload: {
          ...pageResponse.thread,
          model: nextModel,
          reasoningEffort: isCurrentThread ? currentReasoningEffort : pageResponse.thread.reasoningEffort,
          serviceTier: nextServiceTier,
          agentPath: selectedAgentPath ?? pageResponse.thread.agentPath,
          nextPageCursor: pageResponse.nextCursor,
        },
      };
      await beforeCommit?.();
      const payload = commitThreadReadResult(operationFence, cursor, result, commit);
      return payload
        ? { kind: "success", payload }
        : { kind: "superseded" };
    } catch (error) {
      if (!isThreadOperationIdentityCurrent(operationFence)) {
        return { kind: "superseded" };
      }
      if (isThreadHistoryPending(error)) {
        return {
          failure: {
            harness,
            message: THREAD_HISTORY_PENDING_STATUS_MESSAGE,
            transientRollout: true,
          },
          kind: "failure",
        };
      }

      const message = error instanceof Error ? error.message : `Unable to open ${harness} thread.`;
      return {
        failure: { harness, message, transientRollout: false },
        kind: "failure",
      };
    }
  }

  async function readSubagentBackgroundThread(
    threadId: string,
    harness: WorkbenchHarness,
    options: WorkbenchReadThreadOptions,
  ) {
    const operationFence = captureThreadOperationFence(harness, threadId);
    const subagent = state.subagents.find((candidate) => (
      candidate.threadId === threadId && candidate.harness === harness
    ));
    if (!subagent) {
      return null;
    }

    const cursor = options.cursor ?? null;
    const projectContext = effectiveThreadProjectContext(harness, threadId);
    const projectRootPaths = getThreadProjectRootPaths(projectContext);
    const expectedCwd = options.cwd?.trim() || subagent.cwd;
    const nextModel = getThreadModel(threadId);
    const nextReasoningEffort = getThreadReasoningEffort(threadId);
    const nextServiceTier = getThreadServiceTier(threadId);
    const selectedAgentPath = state.currentThread?.id === threadId
      ? state.currentThread.agentPath
      : null;
    try {
      const pageResponse = await requestThreadPage(threadId, harness, {
        ...options,
        cursor,
        cwd: expectedCwd,
        readScope: "subagentBackground",
      });
      if (
        projectRootPaths.length
        && !isProjectThreadAtExpectedCwd(pageResponse.thread, projectRootPaths, expectedCwd)
      ) {
        return null;
      }

      const result: ThreadReadResult = {
        pageResponse,
        payload: {
          ...pageResponse.thread,
          model: nextModel,
          reasoningEffort: nextReasoningEffort,
          serviceTier: nextServiceTier,
          agentPath: selectedAgentPath ?? pageResponse.thread.agentPath,
          nextPageCursor: pageResponse.nextCursor,
        },
      };
      return commitThreadReadResult(operationFence, cursor, result, (payload) => upsertThreadDocument(payload, {
        emitChange: true,
      }));
    } catch {
      return null;
    }
  }

  async function readThread(threadId: string, harness?: WorkbenchHarness, readOptions?: WorkbenchReadThreadOptions) {
    if (options.resolveThreadIdentity) {
      const identity = await options.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), harness });
      if (!identity) throw new Error("Thread identity has not been observed.");
      threadId = identity.threadId;
      harness = identity.harness;
    }
    const isKnownSubagent = state.subagents.some((candidate) => (
      candidate.threadId === threadId && candidate.harness === harness
    ));
    return readOptions?.readScope === "subagentBackground" && harness && isKnownSubagent
      ? await readSubagentBackgroundThread(threadId, harness, readOptions)
      : await fetchThreadPayloadFromCandidates(threadId, harness, readOptions, (payload) => {
        if (threadDocuments.getSelectedThreadKey() === getThreadSourceKey(payload)) {
          setCurrentThread(payload);
          return state.currentThread;
        }
        return upsertThreadDocument(payload, { emitChange: true });
      });
  }

  async function refreshCurrentThread() {
    const currentThread = state.currentThread;
    if (!currentThread || isDraftThreadId(currentThread.id)) {
      return currentThread;
    }
    const outcome = await fetchThreadPayload(currentThread.id, currentThread.harness, {}, (payload) => {
      if (threadDocuments.getSelectedThreadKey() === getThreadSourceKey(payload)) {
        setCurrentThread(payload);
        return state.currentThread;
      }
      return upsertThreadDocument(payload, { emitChange: true });
    });
    if (outcome.kind === "failure") {
      throw new Error(outcome.failure.message);
    }
    return outcome.kind === "success" ? outcome.payload : state.currentThread;
  }

  async function fetchThreadPayloadFromCandidates(
    threadId: string,
    harness?: WorkbenchHarness,
    options: WorkbenchReadThreadOptions = {},
    commit: (payload: ThreadPayload) => ThreadPayload | null = (payload) => payload,
    operationOptions: { selectionBound?: boolean } = {},
  ) {
    if (harness) {
      const outcome = await fetchThreadPayload(threadId, harness, options, commit, operationOptions);
      if (outcome.kind === "success") {
        return outcome.payload;
      }
      if (outcome.kind === "failure") {
        emitStatusMessage(outcome.failure.message);
      }
      return null;
    }

    const failures: ThreadReadFailure[] = [];
    for (const candidateHarness of getThreadHarnessCandidates(threadId)) {
      const outcome = await fetchThreadPayload(threadId, candidateHarness, options, commit, operationOptions);
      if (outcome.kind === "success") {
        return outcome.payload;
      }
      if (outcome.kind === "superseded") {
        return null;
      }
      failures.push(outcome.failure);
    }

    const actionableFailure = failures.find((failure) => !failure.transientRollout) ?? failures[0]!;
    const message = `Unable to open ${actionableFailure.harness} thread ${threadId}: ${actionableFailure.message}`;
    state.threadsError = message;
    emitStatusMessage(message);
    emit();
    return null;
  }

  async function refreshRateLimits(harness = state.currentThread?.harness ?? defaultProviderKey) {
    await account.refresh(harness);
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

  function upsertTurnMetadata(threadKey: string, incomingTurn: Turn) {
    return updateThreadSource(threadKey, (thread) => {
      const turnIndex = thread.turns.findIndex((turn) => turn.id === incomingTurn.id);
      if (turnIndex === -1) {
        const turnHistory = mergeThreadTurnHistory([createLoadedTurnHistoryEntry(incomingTurn)], thread.turnHistory);
        return {
          ...thread,
          turnHistory,
          turns: [...thread.turns, incomingTurn],
        };
      }

      const turnHistory = mergeThreadTurnHistory([createLoadedTurnHistoryEntry(incomingTurn)], thread.turnHistory);
      return {
        ...thread,
        turnHistory,
        turns: thread.turns.map((turn, index) => (
          index === turnIndex ? mergeTurnMetadata(turn, incomingTurn) : turn
        )),
      };
    });
  }

  function updateTurnItems(
    threadKey: string,
    turnId: string,
    updater: (items: ThreadItem[]) => ThreadItem[] | null,
    {
      publishSelected = true,
      pruneStreamingDuplicates = false,
    }: {
      publishSelected?: boolean;
      pruneStreamingDuplicates?: boolean;
    } = {},
  ) {
    const streaming = getThreadStreaming(threadKey);
    return updateThreadSource(threadKey, (thread) => {
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
          ? streaming.pruneDuplicateItems(turn.id, nextItems, mergeLiveStreamingItem)
          : nextItems;
        updated = true;
        return {
          ...turn,
          items: prunedItems,
        };
      });

      return updated
        ? {
          ...thread,
          turnHistory: mergeThreadTurnHistory(turns.map(createLoadedTurnHistoryEntry), thread.turnHistory),
          turns,
        }
        : null;
    }, { preserveStableServiceTier: false, publishSelected, pruneStreamingDuplicates: false });
  }

  function upsertThreadItem(threadKey: string, turnId: string, incomingItem: ThreadItem) {
    const streaming = getThreadStreaming(threadKey);
    const compactedIncomingItem = compactCommandExecutionItemOutput(incomingItem);
    return updateTurnItems(threadKey, turnId, (items) => {
      const itemIndex = items.findIndex((item) => item.id === compactedIncomingItem.id);
      if (itemIndex === -1) {
        const contextCompactionItemIndex = findContextCompactionLifecycleItemIndex(items, compactedIncomingItem);
        if (contextCompactionItemIndex !== -1) {
          return items.map((item, index) => (
            index === contextCompactionItemIndex
              ? mergeContextCompactionLifecycleItem(compactedIncomingItem, item)
              : item
          ));
        }

        let matchedClientItem: ThreadItem | null = null;
        const nextItems = items.filter((item) => {
          const itemKey = getThreadItemKey(turnId, item.id);
          if (!streaming.hasClientCreatedItemKey(itemKey) || !streaming.isStructurallyMatchingItem(compactedIncomingItem, item)) {
            return true;
          }

          matchedClientItem = item;
          streaming.forgetStreamingItemKey(getThreadItemKey(turnId, item.id));
          return false;
        });
        return [...nextItems, matchedClientItem ? mergeLiveStreamingItem(compactedIncomingItem, matchedClientItem) : compactedIncomingItem];
      }

      streaming.forgetStreamingItemKey(getThreadItemKey(turnId, compactedIncomingItem.id));
      return items.map((item, index) => (
        index === itemIndex ? mergeLiveStreamingItem(compactedIncomingItem, item) : item
      ));
    });
  }

  function upsertThreadItemTimeline(
    threadKey: string,
    turnId: string,
    incomingItem: ThreadItem,
    method: "item/started" | "item/completed",
    timestamp: number,
  ) {
    return updateThreadSource(threadKey, (thread) => {
      const turn = thread.turns.find((candidate) => candidate.id === turnId);
      if (!turn) {
        return null;
      }

      const exactItem = turn.items.find((item) => item.id === incomingItem.id);
      const lifecycleItem = exactItem ?? (() => {
        const index = findContextCompactionLifecycleItemIndex(turn.items, incomingItem);
        return index === -1 ? null : turn.items[index] ?? null;
      })();
      const itemId = lifecycleItem?.id ?? incomingItem.id;
      const aliases = itemId === incomingItem.id ? undefined : [incomingItem.id];
      let updated = false;
      const turnHistory = thread.turnHistory.map((entry) => {
        if (entry.turnId !== turnId) {
          return entry;
        }

        const itemTimeline = upsertWorkbenchThreadItemTimelineEntry(entry.itemTimeline, {
          ...(aliases ? { aliases } : {}),
          completedAt: method === "item/completed" ? timestamp : null,
          firstSeenAt: timestamp,
          itemId,
          lastSeenAt: timestamp,
          startedAt: method === "item/started" ? timestamp : null,
        });
        updated = true;
        return { ...entry, itemTimeline };
      });

      return updated ? { ...thread, turnHistory } : null;
    }, { pruneStreamingDuplicates: false });
  }

  function mergeContextCompactionLifecycleItem(incomingItem: ThreadItem, existingItem: ThreadItem) {
    if (incomingItem.type !== "contextCompaction" || existingItem.type !== "contextCompaction") {
      return incomingItem;
    }

    if (getWorkbenchThreadItemIdentityKind(incomingItem) === "provisional" && getWorkbenchThreadItemIdentityKind(existingItem) !== "provisional") {
      return existingItem;
    }

    return incomingItem;
  }

  function findContextCompactionLifecycleItemIndex(items: ThreadItem[], incomingItem: ThreadItem) {
    if (incomingItem.type !== "contextCompaction") {
      return -1;
    }

    const compactionIndexes = items
      .map((item, index) => item.type === "contextCompaction" ? index : -1)
      .filter((index) => index !== -1);
    if (!compactionIndexes.length) {
      return -1;
    }

    const incomingIdIsGeneric = getWorkbenchThreadItemIdentityKind(incomingItem) === "provisional";
    const preferredIndex = incomingIdIsGeneric
      ? compactionIndexes.findLast((index) => getWorkbenchThreadItemIdentityKind(items[index]!) !== "provisional")
      : compactionIndexes.findLast((index) => getWorkbenchThreadItemIdentityKind(items[index]!) === "provisional");
    if (preferredIndex !== undefined) {
      return preferredIndex;
    }

    return -1;
  }

  function createStreamingAgentMessageItem(itemId: string): Extract<ThreadItem, { type: "agentMessage" }> {
    return {
      type: "agentMessage",
      id: itemId,
      text: "",
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
      questions: null,
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

  function createStreamingFileChangeItem(itemId: string): Extract<ThreadItem, { type: "fileChange" }> {
    return {
      type: "fileChange",
      id: itemId,
      changes: [],
      status: "inProgress",
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

  function ensureTurnForStreamingDelta(threadKey: string, turnId: string) {
    const source = threadSources.get(threadKey);
    if (!source || source.turns.some((turn) => turn.id === turnId)) {
      return false;
    }

    return updateThreadSource(threadKey, (thread) => {
      const turn = createStreamingTurn(turnId);
      return {
        ...thread,
        turnHistory: mergeThreadTurnHistory([createLoadedTurnHistoryEntry(turn)], thread.turnHistory),
        turns: [...thread.turns, turn],
        status: isThreadStatusActive(thread.status) ? thread.status : "active",
      };
    });
  }

  function updateOrCreateThreadItem(
    threadKey: string,
    turnId: string,
    itemId: string,
    createItem: () => ThreadItem,
    updater: (item: ThreadItem, isExisting: boolean) => ThreadItem | null,
    { publishSelected = true }: { publishSelected?: boolean } = {},
  ) {
    const streaming = getThreadStreaming(threadKey);
    const itemKey = getThreadItemKey(turnId, itemId);
    ensureTurnForStreamingDelta(threadKey, turnId);
    return updateTurnItems(threadKey, turnId, (items) => {
      const itemIndex = items.findIndex((item) => item.id === itemId);
      if (itemIndex === -1) {
        const nextItem = updater(createItem(), false);
        if (!nextItem) {
          return null;
        }

        streaming.addClientCreatedItemKey(itemKey);
        return [...items, nextItem];
      }

      let updated = false;
      const nextItems = items.map((item, index) => {
        if (index !== itemIndex) {
          return item;
        }

        const nextItem = updater(item, true);
        if (!nextItem) {
          return item;
        }

        updated = true;
        return nextItem;
      });

      return updated ? nextItems : null;
    }, { publishSelected, pruneStreamingDuplicates: false });
  }

  function discardAbandonedStreamingFileChanges(threadKey: string, turnId: string, incomingItemId: string) {
    const streaming = getThreadStreaming(threadKey);
    return updateTurnItems(threadKey, turnId, (items) => {
      const abandonedItemIds = items
        .filter((item) => (
          item.id !== incomingItemId
          && item.type === "fileChange"
          && item.status === "inProgress"
          && streaming.hasClientCreatedItemKey(getThreadItemKey(turnId, item.id))
        ))
        .map((item) => item.id);
      if (!abandonedItemIds.length) {
        return null;
      }

      const abandonedItemIdSet = new Set(abandonedItemIds);
      for (const itemId of abandonedItemIds) {
        streaming.forgetStreamingItemKey(getThreadItemKey(turnId, itemId));
      }
      return items.filter((item) => !abandonedItemIdSet.has(item.id));
    }, { pruneStreamingDuplicates: false });
  }

  function areFileChangeSnapshotsEqual(
    left: Extract<ThreadItem, { type: "fileChange" }>["changes"],
    right: Extract<ThreadItem, { type: "fileChange" }>["changes"],
  ) {
    return left.length === right.length && left.every((change, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && change.path === candidate.path
        && change.diff === candidate.diff
        && change.kind.type === candidate.kind.type
        && (
          change.kind.type !== "update"
          || (
            candidate.kind.type === "update"
            && change.kind.move_path === candidate.kind.move_path
          )
        );
    });
  }

  function updateThreadItem(
    threadKey: string,
    turnId: string,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem | null,
    { publishSelected = true }: { publishSelected?: boolean } = {},
  ) {
    return updateTurnItems(threadKey, turnId, (items) => {
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
    }, { publishSelected, pruneStreamingDuplicates: false });
  }

  function readPresentationText(
    threadKey: string,
    turnId: string,
    itemId: string,
    field: ThreadTextPresentationField,
    index: number | null,
  ) {
    const item = threadSources.get(threadKey)?.turns
      .find((turn) => turn.id === turnId)?.items
      .find((candidate) => candidate.id === itemId);
    if (!item) return null;
    if (field === "agentMessageText") return item.type === "agentMessage" ? item.text : null;
    if (field === "commandExecutionOutput") {
      return item.type === "commandExecution" ? item.aggregatedOutput ?? "" : null;
    }
    if (item.type !== "reasoning" || index === null || index < 0) return null;
    return field === "reasoningSummary"
      ? item.summary[index] ?? ""
      : item.content[index] ?? "";
  }

  function presentationKey(
    threadKey: string,
    threadId: string,
    turnId: string,
    itemId: string,
    field: ThreadTextPresentationField,
    index: number | null,
    kind: "json" | "sqlite",
  ): ThreadTextPresentationKey {
    return {
      field,
      index,
      itemId,
      source: { kind, sourceKey: threadKey },
      threadId,
      turnId,
    };
  }

  function acceptPresentationDelta({
    apply,
    delta,
    field,
    index = null,
    itemId,
    threadId,
    threadKey,
    turnId,
  }: {
    apply: (publishSelected: boolean) => boolean;
    delta: string;
    field: ThreadTextPresentationField;
    index?: number | null;
    itemId: string;
    threadId: string;
    threadKey: string;
    turnId: string;
  }) {
    const priorText = readPresentationText(threadKey, turnId, itemId, field, index);
    const isReasoningField = field === "reasoningContent" || field === "reasoningSummary";
    const hasVisibleLeaf = priorText !== null && (!isReasoningField || Boolean(priorText.trim()));
    const selected = threadDocuments.getSelectedThreadKey() === threadKey;
    const kinds: readonly ("json" | "sqlite")[] = transcripts.incremental ? ["json"] : ["json", "sqlite"];
    const keys = kinds.map((kind) => (
      presentationKey(threadKey, threadId, turnId, itemId, field, index, kind)
    ));
    const useLeafPresentation = selected
      && hasVisibleLeaf
      && (transcripts.incremental || keys.some((key) => textPresentation.hasSubscribers(key)));
    const applied = apply(!useLeafPresentation);
    if (!applied || !useLeafPresentation) return applied;
    const canonicalText = readPresentationText(threadKey, turnId, itemId, field, index);
    if (canonicalText === null) return applied;
    for (const key of keys) {
      textPresentation.acceptDelta({
        canonicalText,
        delta,
        key,
      });
    }
    return applied;
  }

  function completePresentationItem(
    threadKey: string,
    threadId: string,
    turnId: string,
    item: ThreadItem,
  ) {
    const fields: Array<{
      field: ThreadTextPresentationField;
      index: number | null;
      text: string;
    }> = [];
    if (item.type === "agentMessage") {
      fields.push({ field: "agentMessageText", index: null, text: item.text });
    } else if (item.type === "commandExecution") {
      fields.push({ field: "commandExecutionOutput", index: null, text: item.aggregatedOutput ?? "" });
    } else if (item.type === "reasoning") {
      item.summary.forEach((text, index) => fields.push({ field: "reasoningSummary", index, text }));
      item.content.forEach((text, index) => fields.push({ field: "reasoningContent", index, text }));
    }
    for (const entry of fields) {
      const kinds: readonly ("json" | "sqlite")[] = transcripts.incremental ? ["json"] : ["json", "sqlite"];
      for (const kind of kinds) {
        textPresentation.complete(
          presentationKey(threadKey, threadId, turnId, item.id, entry.field, entry.index, kind),
          entry.text,
          { snap: entry.field === "commandExecutionOutput" },
        );
      }
    }
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

  function getNotificationTargetThreadId(notification: WorkbenchClientNotification) {
    return "threadId" in notification.params
      ? notification.params.threadId
      : "thread" in notification.params
        ? notification.params.thread.id
        : null;
  }

  function doesNotificationTargetSelectedThread(
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) {
    const threadId = getNotificationTargetThreadId(notification);
    return threadId !== null
      && state.currentThread?.harness === harness
      && state.currentThreadId === threadId;
  }

  function doesNotificationTargetKnownThread(
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) {
    const threadId = getNotificationTargetThreadId(notification);
    if (!threadId) {
      return false;
    }

    return state.currentThread?.harness === harness && state.currentThreadId === threadId
      ? true
      : threadSources.has(getThreadStateKey(harness, threadId));
  }

  function applyUserMessageNotificationToKnownThreadSource(
    notification: Extract<WorkbenchClientNotification, { method: "item/started" | "item/completed" }>,
    harness: WorkbenchHarness,
  ) {
    if (notification.params.item.type !== "userMessage") {
      return false;
    }

    const key = getThreadStateKey(harness, notification.params.threadId);
    if (!threadSources.has(key)) {
      return false;
    }

    const didUpdate = threadSources.update(key, (thread) => {
      const turnIndex = thread.turns.findIndex((turn) => turn.id === notification.params.turnId);
      if (turnIndex < 0) {
        const turn = createStreamingTurn(notification.params.turnId);
        return {
          ...thread,
          turns: [...thread.turns, { ...turn, items: [notification.params.item] }],
        };
      }
      const turn = thread.turns[turnIndex]!;
      const nextTurn = {
        ...turn,
        items: normalizeThreadItems([...turn.items, notification.params.item], {
          mergeDuplicateItems: mergeDuplicateNormalizedThreadItem,
        }),
      };
      return {
        ...thread,
        turns: thread.turns.map((candidate, index) => index === turnIndex ? nextTurn : candidate),
      };
    });
    const confirmedHandle = optimisticInputs.confirmCanonicalUserMessage(
      key,
      notification.params.turnId,
      notification.params.item,
    );
    if (!didUpdate && !confirmedHandle) {
      return false;
    }

    if (confirmedHandle) {
      bumpOverlayRevisionForKey(key, "optimisticRevision");
    }
    if (threadDocuments.getSelectedThreadKey() === key) {
      flushSelectedThreadRendering();
    }
    return true;
  }

  function applyNotificationToKnownThreadSource(
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) {
    const threadId = getNotificationTargetThreadId(notification);
    if (!threadId) {
      return false;
    }
    const threadKey = getThreadStateKey(harness, threadId);
    const targetThread = threadSources.get(threadKey);
    if (!targetThread) {
      return false;
    }

    switch (notification.method) {
      case "thread/started": {
        const summary = notification.params.thread;
        return updateThreadSource(threadKey, source => source.isDraft ? source : ({
          ...source,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          status: summary.status,
          cwd: summary.cwd,
          source: summary.source,
          path: summary.path,
          isDraft: false,
          agentNickname: summary.agentNickname ?? null,
          agentRole: summary.agentRole ?? null,
          name: summary.name ?? null,
          preview: summary.preview.trim() || targetThread.preview,
        }), { preserveStableServiceTier: false });
      }
      case "thread/status/changed":
        {
          const status = state.pendingUserInputRequestsByThreadId.has(notification.params.threadId)
            ? addThreadActiveFlag(formatThreadStatus(notification.params.status), "waitingOnUserInput")
            : formatThreadStatus(notification.params.status);
          setThreadStatusSource(targetThread, status);
          return updateCanonicalThreadFields(threadKey, { status });
        }
      case "thread/name/updated":
        return updateCanonicalThreadFields(threadKey, {
          name: notification.params.threadName ?? null,
        });
      case "thread/tokenUsage/updated":
        updateStablePreferenceSource(targetThread, (record) => {
          record.tokenUsage = notification.params.tokenUsage;
        });
        return updateCanonicalThreadFields(threadKey, {
          tokenUsage: notification.params.tokenUsage,
        });
      case "turn/started":
      case "turn/completed":
        if (
          notification.method === "turn/completed"
          && notification.params.turn.status === "interrupted"
          && updatePendingOptimisticSteersForTurn(harness, notification.params.threadId, notification.params.turn.id, "interrupted")
          && threadDocuments.getSelectedThreadKey() === threadKey
        ) {
          refreshCurrentThreadOptimisticUserMessages();
        }
        return upsertTurnMetadata(threadKey, notification.params.turn);
      case "item/started":
      case "item/completed": {
        if (!isSupportedWorkbenchTranscriptItem(notification.params.item)) return false;
        const didDiscardAbandonedFileChanges = notification.method === "item/started"
          ? discardAbandonedStreamingFileChanges(threadKey, notification.params.turnId, notification.params.item.id)
          : false;
        const didUpdateItem = upsertThreadItem(threadKey, notification.params.turnId, notification.params.item);
        const timestamp = notification.method === "item/started"
          ? notification.params.startedAtMs
          : notification.params.completedAtMs;
        const didUpdateTimeline = Number.isFinite(timestamp)
          ? upsertThreadItemTimeline(
            threadKey,
            notification.params.turnId,
            notification.params.item,
            notification.method,
            timestamp,
          )
          : false;
        if (notification.method === "item/completed") {
          completePresentationItem(
            threadKey,
            notification.params.threadId,
            notification.params.turnId,
            notification.params.item,
          );
        }
        return didDiscardAbandonedFileChanges || didUpdateItem || didUpdateTimeline;
      }
      case "item/agentMessage/delta":
        return acceptPresentationDelta({
          apply: (publishSelected) => updateOrCreateThreadItem(
            threadKey,
            notification.params.turnId,
            notification.params.itemId,
            () => createStreamingAgentMessageItem(notification.params.itemId),
            (item) => item.type === "agentMessage"
              ? { ...item, text: `${item.text}${notification.params.delta}` }
              : null,
            { publishSelected },
          ),
          delta: notification.params.delta,
          field: "agentMessageText",
          itemId: notification.params.itemId,
          threadId: notification.params.threadId,
          threadKey,
          turnId: notification.params.turnId,
        });
      case "item/commandExecution/outputDelta":
        return acceptPresentationDelta({
          apply: (publishSelected) => updateThreadItem(
            threadKey,
            notification.params.turnId,
            notification.params.itemId,
            (item) => item.type === "commandExecution"
              ? { ...item, aggregatedOutput: appendCommandOutputDelta(item.aggregatedOutput, notification.params.delta) }
              : null,
            { publishSelected },
          ),
          delta: notification.params.delta,
          field: "commandExecutionOutput",
          itemId: notification.params.itemId,
          threadId: notification.params.threadId,
          threadKey,
          turnId: notification.params.turnId,
        });
      case "item/fileChange/patchUpdated":
        return updateOrCreateThreadItem(threadKey, notification.params.turnId, notification.params.itemId, () => createStreamingFileChangeItem(notification.params.itemId), (item, isExisting) => (
          item.type === "fileChange"
            ? isExisting && areFileChangeSnapshotsEqual(item.changes, notification.params.changes)
              ? null
              : { ...item, changes: notification.params.changes }
            : null
        ));
      case "item/reasoning/summaryPartAdded":
        return updateOrCreateThreadItem(threadKey, notification.params.turnId, notification.params.itemId, () => createStreamingReasoningItem(notification.params.itemId), (item) => (
          item.type === "reasoning"
            ? { ...item, summary: ensureIndexedText(item.summary, notification.params.summaryIndex) }
            : null
        ));
      case "item/reasoning/summaryTextDelta":
        return acceptPresentationDelta({
          apply: (publishSelected) => updateOrCreateThreadItem(
            threadKey,
            notification.params.turnId,
            notification.params.itemId,
            () => createStreamingReasoningItem(notification.params.itemId),
            (item) => item.type === "reasoning"
              ? { ...item, summary: appendIndexedText(item.summary, notification.params.summaryIndex, notification.params.delta) }
              : null,
            { publishSelected },
          ),
          delta: notification.params.delta,
          field: "reasoningSummary",
          index: notification.params.summaryIndex,
          itemId: notification.params.itemId,
          threadId: notification.params.threadId,
          threadKey,
          turnId: notification.params.turnId,
        });
      case "item/reasoning/textDelta":
        return acceptPresentationDelta({
          apply: (publishSelected) => updateOrCreateThreadItem(
            threadKey,
            notification.params.turnId,
            notification.params.itemId,
            () => createStreamingReasoningItem(notification.params.itemId),
            (item) => item.type === "reasoning"
              ? { ...item, content: appendIndexedText(item.content, notification.params.contentIndex, notification.params.delta) }
              : null,
            { publishSelected },
          ),
          delta: notification.params.delta,
          field: "reasoningContent",
          index: notification.params.contentIndex,
          itemId: notification.params.itemId,
          threadId: notification.params.threadId,
          threadKey,
          turnId: notification.params.turnId,
        });
      case "thread/goal/updated":
      case "thread/goal/cleared":
      case "item/plan/delta":
      case "item/fileChange/outputDelta":
      case "questionnaire/requested":
      case "questionnaire/resolved":
      case "browse/result/recorded":
      case "account/updated":
      case "account/rateLimits/updated":
        return false;
    }

    const unhandledNotification: never = notification;
    return unhandledNotification;
  }

  async function openThread(
    threadId: string,
    {
      harness,
      project,
      source = "open",
      isCurrent = () => true,
    }: { harness?: WorkbenchHarness; project?: WorkbenchProjectOption; source?: "open" | "reload"; isCurrent?: () => boolean } = {},
  ) {
    if (source === "open") messageAdmissionIntentRevision += 1;
    const intentRevision = messageAdmissionIntentRevision;
    if (options.resolveThreadIdentity) {
      try {
        const identity = await options.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), harness, projectId: project?.id ?? ProjectIdSchema.parse(state.projectId) });
        if (!isCurrent() || intentRevision !== messageAdmissionIntentRevision) return { kind: "superseded" } satisfies ThreadPayloadFetchOutcome;
        if (!identity) throw new Error("Thread identity has not been observed in this project.");
        threadId = identity.threadId;
        harness = identity.harness;
      } catch (error) {
        return { kind: "failure", failure: {
          harness: harness ?? defaultProviderKey, transientRollout: false,
          message: error instanceof Error ? error.message : "Thread identity lookup failed.",
        } } satisfies ThreadPayloadFetchOutcome;
      }
    }
    if (!isCurrent()) return { kind: "superseded" } as const;
    const resolvedHarness = harness ?? getKnownThreadHarness(threadId) ?? defaultProviderKey;
    const nextProjectId = project?.id ?? state.projectId;
    const selectedProjectId = selectedThreadProjectContext?.projectId ?? state.projectId;
    const reuseCurrent = (
      source === "open"
      && state.currentThread?.id === threadId
      && state.currentThread.harness === resolvedHarness
      && nextProjectId === selectedProjectId
    );
    installSelectedThreadProjectContext({ kind: "provider", harness: resolvedHarness, threadId: ThreadReferenceSchema.parse(threadId) }, project, isCurrent);

    try {
      const owner = getThreadController(nextProjectId, { kind: "provider", harness: resolvedHarness, threadId: ThreadReferenceSchema.parse(threadId) });
      if (reuseCurrent) {
        await owner.waitForAdmission();
        if (!isCurrent() || intentRevision !== messageAdmissionIntentRevision || state.currentThread?.id !== threadId) return { kind: "superseded" } as const;
        return { kind: "success", payload: state.currentThread } as const;
      }
      const payload = await owner.read({}, { selectionBound: source === "open" });
      if (!isCurrent() || (source === "open" && (
        selectedThreadProjectContext?.projectId !== nextProjectId
        || selectedThreadProjectContext.harness !== resolvedHarness
        || selectedThreadProjectContext.rootThreadId !== threadId
      ))) return { kind: "superseded" } as const;
      return payload ? { kind: "success", payload } as const : { kind: "superseded" } as const;
    } catch (error) {
      return { kind: "failure", failure: error instanceof ThreadPayloadReadError ? error.failure : {
        harness: resolvedHarness, transientRollout: false,
        message: error instanceof Error ? error.message : "Unable to open thread.",
      } } as const;
    }
  }

  function selectThreadPayload(thread: ThreadPayload) {
    installSelectedThreadProjectContext(thread.isDraft
      ? { kind: "draft", harness: thread.harness, draftId: thread.id }
      : { kind: "provider", harness: thread.harness, threadId: thread.id }, undefined);
    messageAdmissionIntentRevision += 1;
    setCurrentThread(thread);
  }

  function prepareMessageAdmission(
    thread: ThreadPayload,
    sendOptions: WorkbenchSendThreadMessageOptions,
  ) {
    if (
      thread.isDraft
      || !thread.id.trim()
    ) {
      return null;
    }

    const key = getThreadStateKey(thread.harness, thread.id);
    if (sendOptions.selectThread !== false && threadDocuments.getSelectedThreadKey() !== key) {
      throw new ThreadMessageNotSentError();
    }
    let source = threadSources.get(key);
    if (!source) {
      installAuthoritativeThreadSource(thread);
      source = threadSources.get(key);
    }
    if (
      !source
      || source.harness !== thread.harness
      || source.id !== thread.id
      || source.cwd !== thread.cwd
    ) {
      throw new ThreadMessageNotSentError();
    }
    return key;
  }

  async function reconcileAdmittedThreadMessage(context: ReconcileAdmittedThreadMessageContext) {
    const {
      harness,
      isDraftThread,
      optimisticTurnId,
      resolvedThreadId,
      resumedThread,
      sendOptions,
      isFreshCreation,
      workbenchOrigin,
    } = context;
    const targetKey = getThreadStateKey(harness, resolvedThreadId);
    const projectContext = effectiveThreadProjectContext(harness, resolvedThreadId);
    const wasExplicitBackgroundSend = sendOptions.selectThread === false;
    const shouldSelectTarget = !wasExplicitBackgroundSend
      && threadDocuments.getSelectedThreadKey() === targetKey;
    if (!wasExplicitBackgroundSend && !threadSources.has(targetKey)) {
      return null;
    }
    const providerFence = captureThreadOperationFence(harness, resolvedThreadId, {
      selectionBound: shouldSelectTarget,
    });
    try {
      let refreshedThread = await daemon.threads.read({ threadId: resolvedThreadId });
      refreshedThread = {
        ...refreshedThread,
        model: resumedThread.model,
        reasoningEffort: resumedThread.reasoningEffort,
        serviceTier: resumedThread.serviceTier,
        agentPath: resumedThread.agentPath,
      };

      if (sendOptions.composerProfileSlot) {
        refreshedThread = await readThreadProfileSnapshot(refreshedThread, sendOptions.composerProfileSlot.projectId);
      }

      if (isDraftThread && optimisticTurnId) {
        refreshedThread = {
          ...refreshedThread,
          turnHistory: refreshedThread.turnHistory.filter((entry) => entry.turnId === optimisticTurnId || entry.itemCount > 0),
          turns: refreshedThread.turns.filter((turn) => turn.id === optimisticTurnId || turn.items.length > 0),
        };
      }

      if (!isThreadOperationFenceCurrent(providerFence)) {
        return null;
      }
      await readCompletedThreadWorkbenchHistory(resolvedThreadId);
      if (!isThreadOperationOwnerFenceCurrent(providerFence)) {
        return null;
      }

      const commitFence = captureThreadOperationFence(harness, resolvedThreadId, {
        selectionBound: shouldSelectTarget,
      });
      const payload = commitThreadOperation(commitFence, refreshedThread, () => {
        const merged = mergeLiveStreamingThreadSnapshot(refreshedThread);
        const visible = applyOptimisticUserMessageOverlay(merged) ?? merged;
        if (shouldSelectTarget && threadDocuments.getSelectedThreadKey() === targetKey) {
          setCurrentThread(visible);
          return state.currentThread ?? visible;
        }
        const key = installAuthoritativeThreadSource(visible);
        if (!wasExplicitBackgroundSend) {
          return projectThreadSource(key) ?? visible;
        }
        return threadDocuments.materializeFinalVisibleDocument(
          key,
          projectThreadSource(key) ?? visible,
          { select: false },
        ).document;
      });
      if (!payload) {
        return null;
      }
      if (
        disposed
        || providerFence.projectContextGeneration !== projectContextGeneration
        || providerFence.projectId !== state.projectId
        || providerFence.projectRootPath !== state.projectRootPath
      ) {
        return null;
      }
      return payload;
    } catch (error) {
      if (!isThreadOperationOwnerFenceCurrent(providerFence)) {
        return null;
      }
      if (!(isFreshCreation && isThreadHistoryPending(error))) {
        emitStatusMessage(`The message was admitted, but immediate thread reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        emitStatusMessage(THREAD_HISTORY_PENDING_STATUS_MESSAGE);
      }
      return null;
    }
  }

  async function readThreadProfileSnapshot<Thread extends ThreadPayload>(thread: Thread, projectId: ProjectId): Promise<Thread> {
    if (thread.isDraft) return thread;
    try {
      const { selection } = await daemon.profiles.target.read({ slot: { kind: "thread", projectId, harness: thread.harness, threadId: thread.id } });
      const settings = selection?.settings;
      return { ...thread, model: settings?.model ?? null, reasoningEffort: settings?.reasoningEffort ?? null, serviceTier: settings?.serviceTier ?? null, agentPath: settings?.agentPath ?? null, contextWindowTokens: settings?.contextWindowTokens ?? null };
    } catch (error) {
      emitStatusMessage(`The thread was accepted, but its profile could not be read: ${error instanceof Error ? error.message : "Profile unavailable."}`);
      return thread;
    }
  }

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    sendOptions: WorkbenchSendThreadMessageOptions = {},
  ) {
    if (!installedProviderKeys.some(key => key === thread.harness)) throw new Error(`Provider ${thread.harness} is not installed.`);
    let resolvedThreadId = thread.id;
    let harness = thread.harness;
    const previousThread = state.currentThread;
    const sendSelectedThreadKey = threadDocuments.getSelectedThreadKey();
    const sendMessageAdmissionIntentRevision = messageAdmissionIntentRevision;
    const operationProjectContext = effectiveThreadProjectContext(harness, resolvedThreadId);
    const sendProjectContext = {
      generation: projectContextGeneration,
      projectId: operationProjectContext.projectId,
      projectRootPath: operationProjectContext.projectRootPath,
      threadGeneration: threadProjectContextGeneration,
    };
    const isSendProjectCurrent = () => !disposed
      && sendProjectContext.generation === projectContextGeneration
      && sendProjectContext.threadGeneration === threadProjectContextGeneration
      && sendProjectContext.projectId === effectiveThreadProjectContext(harness, resolvedThreadId).projectId
      && sendProjectContext.projectRootPath === effectiveThreadProjectContext(harness, resolvedThreadId).projectRootPath;
    const isInitialSendSelectionCurrent = () => sendOptions.selectThread === false || (
      sendSelectedThreadKey === threadDocuments.getSelectedThreadKey()
      && sendMessageAdmissionIntentRevision === messageAdmissionIntentRevision
    );
    const selectedModel = thread.model;
    const selectedReasoningEffort = thread.reasoningEffort;
    const selectedServiceTier = thread.serviceTier;
    const selectedAgentPath = normalizeWorkbenchAgentPath(thread.agentPath);
    const normalizedInput = normalizeThreadMessageInput(input);
    const firstMessagePreview = normalizedInput.find((entry) => entry.type === "text")?.text ?? "";
    const recoveryClientUserMessageId = isWorkbenchThreadRecoveryInput(normalizedInput)
      ? createWorkbenchThreadRecoveryId()
      : null;
    const workbenchOrigin = readLocalWorkbenchOrigin();
    const isDraftThread = thread.isDraft;
    const materializingDraftId = isDraftThread ? thread.id : undefined;
    const initialClientUserMessageId = isDraftThread && !recoveryClientUserMessageId
      ? optimisticInputs.createClientUserMessageId()
      : null;
    const isFreshCreation = isDraftThread;
    let bootstrapThread: ThreadPayload | null = null;
    let connectingTurnId: string | null = null;
    let pendingInitialOptimisticHandle: string | null = null;

    if (!normalizedInput.length) {
      throw new Error("Message input cannot be empty.");
    }

    const admissionThreadKey = prepareMessageAdmission(thread, sendOptions);
    if (admissionThreadKey) {
      const threadKey = admissionThreadKey;
      let pendingProjection: { handle: string; turnId: PendingTurnId } | null = null;
      const withoutPendingProjection = (source: ThreadPayload) => {
        if (!pendingProjection) return source;
        const turns = source.turns.filter((turn) => turn.id !== pendingProjection?.turnId);
        const turnHistory = source.turnHistory.filter((entry) => entry.turnId !== pendingProjection?.turnId);
        return turns.length === source.turns.length && turnHistory.length === source.turnHistory.length
          ? source
          : { ...source, turnHistory, turns };
      };
      const discardPendingProjection = (clientUserMessageId: string) => {
        const currentSource = threadSources.get(threadKey);
        const deliveredTurn = currentSource?.turns.find((turn) => turn.items.some((item) => (
          item.type === "userMessage" && item.clientId === clientUserMessageId
        ))) ?? null;
        const nextSource = currentSource ? withoutPendingProjection(currentSource) : null;
        const didDiscard = optimisticInputs.discard(clientUserMessageId);
        pendingProjection = null;
        if (nextSource && nextSource !== currentSource) {
          commitCanonicalThreadSource(nextSource);
        }
        if (didDiscard || nextSource !== currentSource) {
          bumpOverlayRevisionForKey(threadKey, "optimisticRevision");
          if (threadDocuments.getSelectedThreadKey() === threadKey) {
            flushSelectedThreadRendering();
          }
        }
        return deliveredTurn ? WorkbenchTurnIdSchema.parse(deliveredTurn.id) : null;
      };
      const admission = await messageAdmissionController.admit(thread.id, normalizedInput, {
        projectFailedTurn: ({ clientUserMessageId }) => discardPendingProjection(clientUserMessageId),
        projectPendingTurn: ({
          clientUserMessageId,
          input: pendingInput,
          projectContextGeneration: admissionProjectGeneration,
          threadKey: pendingThreadKey,
        }) => {
          if (
            disposed
            || admissionProjectGeneration !== projectContextGeneration
            || pendingThreadKey !== threadKey
          ) {
            throw new ThreadMessageNotSentError();
          }
          const currentSource = threadSources.get(pendingThreadKey);
          if (!currentSource) {
            throw new ThreadMessageNotSentError();
          }
          const pendingTurnId = PendingTurnIdSchema.parse(crypto.randomUUID());
          const pendingTurn = withWorkbenchTurnAdmission(createStreamingTurn(pendingTurnId), "providerPending");
          const pendingSource = {
            ...currentSource,
            turnHistory: mergeThreadTurnHistory([createLoadedTurnHistoryEntry(pendingTurn)], currentSource.turnHistory),
            turns: [...currentSource.turns, pendingTurn],
          };
          const entry = optimisticInputs.enqueueInitial(pendingSource, pendingTurnId, pendingInput, {
            clientUserMessageId,
          });
          pendingProjection = { handle: entry.handle, turnId: pendingTurnId };
          try {
            commitCanonicalThreadSource(pendingSource);
            bumpOverlayRevisionForKey(entry.threadKey, "optimisticRevision");
            if (threadDocuments.getSelectedThreadKey() === pendingThreadKey) {
              flushSelectedThreadRendering();
            }
          } catch (error) {
            discardPendingProjection(clientUserMessageId);
            throw error;
          }
        },
        projectStartedTurn: ({
          clientUserMessageId,
          input: startedInput,
          projectContextGeneration: admissionProjectGeneration,
          sourceRevision,
          threadKey: startedThreadKey,
          turn,
        }) => {
          if (
            disposed
            || admissionProjectGeneration !== projectContextGeneration
            || startedThreadKey !== threadKey
          ) {
            discardPendingProjection(clientUserMessageId);
            return;
          }
          const currentSource = threadSources.get(startedThreadKey);
          if (!currentSource) {
            optimisticInputs.discard(clientUserMessageId);
            pendingProjection = null;
            return;
          }
          const sourceAdvanced = threadSources.getRevision(startedThreadKey) !== sourceRevision;
          const liveTurn = currentSource.turns.find((candidate) => candidate.id === turn.id);
          const streaming = getThreadStreaming(startedThreadKey);
          const mergedTurn = sourceAdvanced && liveTurn
            ? mergeLiveStreamingTurn(liveTurn, turn, streaming)
            : mergeLiveStreamingTurn(turn, liveTurn, streaming);
          const sourceWithoutPending = withoutPendingProjection(currentSource);
          const nextSource = {
            ...sourceWithoutPending,
            status: sourceAdvanced ? currentSource.status : "active",
            turnHistory: mergeThreadTurnHistory(
              [createLoadedTurnHistoryEntry(mergedTurn)],
              sourceWithoutPending.turnHistory,
            ),
            turns: sourceWithoutPending.turns.some((candidate) => candidate.id === turn.id)
              ? sourceWithoutPending.turns.map((candidate) => candidate.id === turn.id ? mergedTurn : candidate)
              : [...sourceWithoutPending.turns, mergedTurn],
          };
          if (!sourceAdvanced) {
            setThreadStatusSource(nextSource, "active");
          }
          commitCanonicalThreadSource(nextSource);
          const committedSource = threadSources.get(startedThreadKey);
          if (!committedSource) {
            return;
          }
          sendOptions.onTurnAdmitted?.(turn.id);
          const movedPending = optimisticInputs.movePending(clientUserMessageId, turn.id);
          if (movedPending) {
            optimisticInputs.transition(clientUserMessageId, "sent");
          } else if (!committedSource.turns.some((candidate) => candidate.items.some((item) => (
            item.type === "userMessage" && item.clientId === clientUserMessageId
          )))) {
            optimisticInputs.enqueueInitial(committedSource, turn.id, startedInput, {
              clientUserMessageId,
              status: "sent",
            });
          }
          pendingProjection = null;
          bumpOverlayRevisionForKey(startedThreadKey, "optimisticRevision");
          if (threadDocuments.getSelectedThreadKey() === startedThreadKey) {
            flushSelectedThreadRendering();
            options.onThreadStarted?.(projectThreadSource(startedThreadKey) ?? committedSource);
          }
        },
        projectSteeredTurn: ({
          clientUserMessageId,
          projectContextGeneration: admissionProjectGeneration,
          threadKey: steeredThreadKey,
          turnId,
        }) => {
          if (
            disposed
            || admissionProjectGeneration !== projectContextGeneration
            || steeredThreadKey !== threadKey
          ) {
            discardPendingProjection(clientUserMessageId);
            return;
          }
          const currentSource = threadSources.get(steeredThreadKey);
          if (!currentSource) {
            optimisticInputs.discard(clientUserMessageId);
            pendingProjection = null;
            return;
          }
          const sourceWithoutPending = withoutPendingProjection(currentSource);
          const steeredTurn = sourceWithoutPending.turns.find((candidate) => candidate.id === turnId)
            ?? createStreamingTurn(turnId);
          const nextSource = {
            ...sourceWithoutPending,
            status: "active",
            turnHistory: mergeThreadTurnHistory(
              [createLoadedTurnHistoryEntry(steeredTurn)],
              sourceWithoutPending.turnHistory,
            ),
            turns: sourceWithoutPending.turns.some((candidate) => candidate.id === turnId)
              ? sourceWithoutPending.turns
              : [...sourceWithoutPending.turns, steeredTurn],
          };
          setThreadStatusSource(nextSource, "active");
          commitCanonicalThreadSource(nextSource);
          optimisticInputs.movePending(clientUserMessageId, turnId, "steer");
          pendingProjection = null;
          bumpOverlayRevisionForKey(steeredThreadKey, "optimisticRevision");
          if (threadDocuments.getSelectedThreadKey() === steeredThreadKey) {
            flushSelectedThreadRendering();
          }
        },
        context: {
          workbenchOrigin,
          instructionScope: "full",
          instructionInjections: sendOptions.instructionInjections,
          workflowIds: [...(sendOptions.workflowIds ?? getDefaultWorkflowIdsForThread(thread.id))],
          activatedSkillPaths: sendOptions.activatedSkillPaths ? [...sendOptions.activatedSkillPaths] : undefined,
        },
      }, {
        selectionBound: sendOptions.selectThread !== false,
        startNewTurn: sendOptions.startNewTurn === true,
        threadKey,
      });
      if (sendOptions.selectThread !== false && (
        admission.kind === "admitted"
        || admission.kind === "turnStarted"
      )) {
        if (sendOptions.composerProfileSlot) {
          const source = threadSources.get(threadKey);
          if (source) {
            const fence = captureThreadOperationFence(harness, thread.id, { selectionBound: true });
            const configured = await readThreadProfileSnapshot(source, sendOptions.composerProfileSlot.projectId);
            if (isThreadOperationFenceCurrent(fence)) updateThreadSourceFields(source, {
              model: configured.model, reasoningEffort: configured.reasoningEffort, serviceTier: configured.serviceTier,
              agentPath: configured.agentPath, contextWindowTokens: configured.contextWindowTokens,
            });
          }
        }
        return null;
      }
      const source = threadSources.get(threadKey);
      if (!source) {
        return null;
      }
      return reconcileAdmittedThreadMessage({
        harness,
        isDraftThread,
        normalizedInput,
        optimisticTurnId: admission.kind === "turnStarted"
          ? admission.turn.id
          : admission.kind === "admittedNeedsReconciliation"
            ? admission.acknowledgedTurnId
            : getCurrentInProgressTurn(source)?.id ?? null,
        previousThread,
        resolvedThreadId: thread.id,
        resumedThread: source,
        selectedAgentPath,
        selectedModel,
        selectedReasoningEffort,
        selectedServiceTier,
        sendOptions,
        isFreshCreation,
        workbenchOrigin,
      });
    }

    if (isDraftThread || !resolvedThreadId.trim()) {
      let startedPayload = await daemon.threads.create({
        projectId: operationProjectContext.projectId,
        profile: sendOptions.composerProfileSlot
          ? { kind: "target", slot: sendOptions.composerProfileSlot }
          : { kind: "snapshot", selection: { kind: "custom", settings: {
            harness, model: selectedModel ?? "", reasoningEffort: selectedReasoningEffort,
            serviceTier: selectedServiceTier === "fast" ? "fast" : null, agentPath: selectedAgentPath, agentSource: null,
            contextWindowTokens: thread.contextWindowTokens ?? null,
          } } },
        context: {
          workbenchOrigin, instructionInjections: sendOptions.instructionInjections,
          workflowIds: [...(sendOptions.workflowIds ?? getDefaultWorkflowIdsForThread(thread.id))],
        },
        additionalWritableRoots: sendOptions.additionalWritableRoots,
      });
      if (!isSendProjectCurrent() || !isInitialSendSelectionCurrent()) {
        throw new ThreadMessageNotSentError();
      }

      if (sendOptions.composerProfileSlot) startedPayload = await readThreadProfileSnapshot(startedPayload, sendOptions.composerProfileSlot.projectId);
      if (!isSendProjectCurrent() || !isInitialSendSelectionCurrent()) {
        throw new ThreadMessageNotSentError();
      }
      bootstrapThread = startedPayload;
      resolvedThreadId = bootstrapThread.id;
      if (selectedThreadProjectContext?.rootThreadId === thread.id && selectedThreadProjectContext.harness === harness) {
        selectedThreadProjectContext.rootThreadId = resolvedThreadId;
      }
      if (isDraftThread) {
        connectingTurnId = crypto.randomUUID();
        const connectingTurn = withWorkbenchTurnAdmission(createStreamingTurn(connectingTurnId), "connecting");
        const connectingThread: ThreadPayload = {
          ...startedPayload,
          preview: firstMessagePreview || startedPayload.preview,
          status: "active",
          turnHistory: [createLoadedTurnHistoryEntry(connectingTurn)],
          turns: [connectingTurn],
        };
        const pendingEntry = optimisticInputs.enqueueInitial(connectingThread, connectingTurnId, normalizedInput, {
          clientUserMessageId: initialClientUserMessageId,
        });
        pendingInitialOptimisticHandle = pendingEntry.handle;
        const connectingKey = getThreadStateKey(connectingThread.harness, connectingThread.id);
        bumpOverlayRevisionForKey(connectingKey, "optimisticRevision");
        if (sendOptions.selectThread !== false) {
          setCurrentThread(connectingThread);
        } else {
          installAuthoritativeThreadSource(connectingThread);
        }
        sendOptions.onThreadCreated?.(projectThreadSource(connectingKey) ?? connectingThread);
      } else if (sendOptions.selectThread !== false) {
        setCurrentThread(bootstrapThread);
      }
      if (!isFreshCreation) {
        if (
          !isSendProjectCurrent()
        ) {
          throw new ThreadMessageNotSentError();
        }
      }
    }

    let resumedThread = bootstrapThread;

    if (!resumedThread) {
      throw new Error(`Unable to prepare the new ${harness} thread for its first turn.`);
    }
    if (resumedThread.isDraft) throw new Error("Message preparation did not materialize the thread.");
    const admittedThreadId = resumedThread.id;

    harness = resumedThread.harness;
    const providerThreadIsActive = isThreadStatusActive(resumedThread.status);
    const currentInProgressTurn = providerThreadIsActive
      ? getCurrentInProgressTurn(resumedThread)
      : null;
    if (sendOptions.startNewTurn && providerThreadIsActive) {
      throw new Error(currentInProgressTurn
        ? "The questionnaire response cannot start a new turn while the provider reports an active turn."
        : "The questionnaire response cannot start a new turn while the provider reports an active thread without a turn identity.");
    }
    if (providerThreadIsActive && !currentInProgressTurn) {
      throw new ThreadMessageNotSentError();
    }
    let optimisticTurnId: string | null = null;

    if (currentInProgressTurn) {
      optimisticTurnId = currentInProgressTurn.id;
      const pendingSteerItem = enqueueOptimisticUserMessage(harness, resolvedThreadId, optimisticTurnId, normalizedInput, "steer", "pending", resumedThread);
      if (sendOptions.selectThread !== false) {
        resumedThread = applyOptimisticUserMessageOverlay(resumedThread) ?? resumedThread;
        setCurrentThread(resumedThread);
      }

      let steerResponse: ProviderSteerAcknowledgement;
      try {
        const result = await daemon.threads.message({
          threadId: resolvedThreadId, input: normalizedInput, intent: "steer",
          expectedTurnId: currentInProgressTurn.id,
          clientMessageId: pendingSteerItem.clientId ?? pendingSteerItem.id,
          context: {
            workbenchOrigin, instructionInjections: sendOptions.instructionInjections,
            workflowIds: [...(sendOptions.workflowIds ?? getDefaultWorkflowIdsForThread(thread.id))],
            activatedSkillPaths: sendOptions.activatedSkillPaths ? [...sendOptions.activatedSkillPaths] : undefined,
          },
        });
        if (result.warning) emitStatusMessage(result.warning);
        steerResponse = { turnId: result.kind === "steered" ? result.turnId : result.turn.id };
      } catch (error) {
        if (!isSendProjectCurrent()) {
          throw error;
        }
        const admissionStatus = optimisticInputs.transition(pendingSteerItem.id, "failed");
        bumpOverlayRevisionForKey(getThreadStateKey(harness, resolvedThreadId), "optimisticRevision");
        if (sendOptions.selectThread !== false) {
          refreshCurrentThreadOptimisticUserMessages();
        }
        if (admissionStatus === "sent") {
          return null;
        }
        throw error;
      }
      if (!isSendProjectCurrent()) {
        return null;
      }

      const acknowledgedTurnId = "turnId" in steerResponse
        ? steerResponse.turnId.trim()
        : currentInProgressTurn.id;
      if (!acknowledgedTurnId) {
        const admissionStatus = optimisticInputs.transition(pendingSteerItem.id, "failed");
        bumpOverlayRevisionForKey(getThreadStateKey(harness, resolvedThreadId), "optimisticRevision");
        if (sendOptions.selectThread !== false) {
          refreshCurrentThreadOptimisticUserMessages();
        }
        if (admissionStatus === "sent") {
          return null;
        }
        throw new Error("turn/steer returned an empty turn id.");
      }
      const optimisticHandle = pendingSteerItem.id;
      if (optimisticInputs.movePending(optimisticHandle, acknowledgedTurnId)) {
        if (acknowledgedTurnId !== optimisticTurnId) {
          optimisticTurnId = acknowledgedTurnId;
          bumpOverlayRevisionForKey(getThreadStateKey(harness, resolvedThreadId), "optimisticRevision");
        }
      } else {
        const admissionStatus = optimisticInputs.transition(optimisticHandle, "failed");
        if (admissionStatus !== "sent") {
          bumpOverlayRevisionForKey(getThreadStateKey(harness, resolvedThreadId), "optimisticRevision");
          if (sendOptions.selectThread !== false) {
            refreshCurrentThreadOptimisticUserMessages();
          }
          throw new Error(admissionStatus === "interrupted"
            ? "The turn stopped before this steer was delivered."
            : "The steer could not be admitted to the active turn.");
        }
      }
      if (sendOptions.selectThread !== false) {
        refreshCurrentThreadOptimisticUserMessages();
      }
    } else {
      const turnStartFence = captureThreadOperationFence(harness, resolvedThreadId, {
        selectionBound: sendOptions.selectThread !== false,
      });
      let turnStartResponse: { turn: Turn };
      try {
        const result = await daemon.threads.message({
          threadId: resolvedThreadId, input: normalizedInput, intent: "newTurn",
          clientMessageId: recoveryClientUserMessageId ?? initialClientUserMessageId ?? optimisticInputs.createClientUserMessageId(),
          context: {
            workbenchOrigin, instructionInjections: sendOptions.instructionInjections,
            workflowIds: [...(sendOptions.workflowIds ?? getDefaultWorkflowIdsForThread(thread.id))],
            activatedSkillPaths: sendOptions.activatedSkillPaths ? [...sendOptions.activatedSkillPaths] : undefined,
          },
        });
        if (result.warning) emitStatusMessage(result.warning);
        turnStartResponse = { turn: result.kind === "started" ? result.turn : createStreamingTurn(result.turnId) };
      } catch (error) {
        if (pendingInitialOptimisticHandle) {
          const threadKey = getThreadStateKey(harness, resolvedThreadId);
          const currentSource = threadSources.get(threadKey);
          const bootstrapTurnIds = new Set(bootstrapThread?.turns.map((turn) => turn.id) ?? []);
          const admittedTurn = currentSource?.turns.find((turn) => (
            turn.id !== connectingTurnId
            && !bootstrapTurnIds.has(turn.id)
          ));
          if (currentSource && admittedTurn) {
            optimisticInputs.movePending(pendingInitialOptimisticHandle, admittedTurn.id);
            optimisticInputs.transition(pendingInitialOptimisticHandle, "sent");
            bumpOverlayRevisionForKey(threadKey, "optimisticRevision");
            const admittedSource = {
              ...currentSource,
              turnHistory: currentSource.turnHistory.filter((entry) => entry.turnId !== connectingTurnId),
              turns: currentSource.turns.filter((turn) => turn.id !== connectingTurnId),
            };
            commitCanonicalThreadSource(admittedSource);
            const projectedSource = projectThreadSource(threadKey) ?? admittedSource;
            sendOptions.onTurnAdmitted?.(admittedTurn.id);
            if (materializingDraftId) void publishAcceptedIntent({
              draftId: materializingDraftId,
              harness,
              projectId: operationProjectContext.projectId,
              threadId: admittedThreadId,
              title: firstMessagePreview || "New thread",
              turnId: WorkbenchTurnIdSchema.parse(admittedTurn.id),
            });
            if (isDraftThread) {
              sendOptions.onThreadMaterialized?.(projectedSource);
            }
            if (threadDocuments.getSelectedThreadKey() === threadKey) {
              flushSelectedThreadRendering();
              options.onThreadStarted?.(projectedSource);
            }
            return null;
          }

          optimisticInputs.transition(pendingInitialOptimisticHandle, "failed");
          optimisticInputs.deleteThread(threadKey);
          bumpOverlayRevisionForKey(threadKey, "optimisticRevision");
          if (bootstrapThread) {
            const settledSource = currentSource
              ? {
                ...currentSource,
                status: bootstrapThread.status,
                turnHistory: currentSource.turnHistory.filter((entry) => entry.turnId !== connectingTurnId),
                turns: currentSource.turns.filter((turn) => turn.id !== connectingTurnId),
              }
              : bootstrapThread;
            installAuthoritativeThreadSource(settledSource);
            if (threadDocuments.getSelectedThreadKey() === threadKey) {
              flushSelectedThreadRendering();
            }
          }
        }
        throw error;
      }
      if (materializingDraftId) void publishAcceptedIntent({
        draftId: materializingDraftId,
        harness,
        projectId: operationProjectContext.projectId,
        threadId: admittedThreadId,
        title: firstMessagePreview || "New thread",
        turnId: WorkbenchTurnIdSchema.parse(turnStartResponse.turn.id),
      });
      if (
        !isSendProjectCurrent()
        || !isThreadOperationIdentityCurrent(turnStartFence)
      ) {
        return null;
      }
      sendOptions.onTurnAdmitted?.(turnStartResponse.turn.id);
      const liveThread = threadSources.get(turnStartFence.threadKey) ?? resumedThread;
      const admittedTurn = mergeLiveStreamingTurn(
        turnStartResponse.turn,
        liveThread.turns.find((turn) => turn.id === turnStartResponse.turn.id),
        getThreadStreaming(turnStartFence.threadKey),
      );
      optimisticTurnId = admittedTurn.id;
      if (pendingInitialOptimisticHandle) {
        optimisticInputs.movePending(pendingInitialOptimisticHandle, optimisticTurnId);
        optimisticInputs.transition(pendingInitialOptimisticHandle, "sent");
        bumpOverlayRevisionForKey(getThreadStateKey(harness, resolvedThreadId), "optimisticRevision");
      }
      if (!pendingInitialOptimisticHandle && !recoveryClientUserMessageId) {
        enqueueOptimisticUserMessage(harness, resolvedThreadId, optimisticTurnId, normalizedInput, "initial", "sent", liveThread);
      }
      resumedThread = applyOptimisticUserMessageOverlay({
        ...liveThread,
        preview: firstMessagePreview || liveThread.preview,
        status: isThreadStatusActive(liveThread.status) ? liveThread.status : "active",
        turnHistory: isDraftThread
          ? [createLoadedTurnHistoryEntry(admittedTurn)]
          : liveThread.turnHistory,
        turns: isDraftThread
          ? [admittedTurn]
          : [
            ...liveThread.turns.filter((turn) => turn.id !== connectingTurnId && turn.id !== admittedTurn.id),
            admittedTurn,
          ],
      }) ?? liveThread;
      if (isDraftThread) {
        sendOptions.onThreadMaterialized?.(resumedThread);
      }
      if (sendOptions.selectThread !== false) {
        setCurrentThread(resumedThread);
        options.onThreadStarted?.(resumedThread);
      }
    }

    return reconcileAdmittedThreadMessage({
      harness,
      isDraftThread,
      normalizedInput,
      optimisticTurnId,
      previousThread,
      resolvedThreadId,
      resumedThread,
      selectedAgentPath,
      selectedModel,
      selectedReasoningEffort,
      selectedServiceTier,
      sendOptions,
      isFreshCreation,
      workbenchOrigin,
    });
  }

  async function stopThread(thread: ThreadPayload) {
    if (thread.isDraft) {
      return thread;
    }

    const activeTurn = getCurrentInProgressTurn(thread);
    const pendingRequest = state.pendingUserInputRequestsByThreadId.get(thread.id);
    if (!activeTurn && !pendingRequest) {
      return thread;
    }

    messageAdmissionIntentRevision += 1;
    const projectIdentity = captureProjectOperationIdentity();
    await daemon.threads.stop({
      threadId: thread.id,
      intent: "stop",
      ...(activeTurn ? { turnId: activeTurn.id } : {}),
      ...(pendingRequest ? { requestKey: pendingRequest.requestKey } : {}),
    });
    if (!isProjectOperationIdentityCurrent(projectIdentity)) {
      return thread;
    }

    if (pendingRequest) {
      resolvedDurableQuestionnaireKeysByThreadId.set(thread.id, pendingRequest.requestKey);
      const clearedPendingRequest = clearPendingUserInputRequest(thread.id, pendingRequest.requestKey);
      const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(thread.id);
      if (clearedPendingRequest || clearedWaitingFlag) {
        emit();
      }
    }

    return thread;
  }

  async function submitPendingUserInputRequest(
    threadId: string,
    response: WorkbenchUserInputResponse,
    options: WorkbenchSubmitUserInputRequestOptions = {},
  ) {
    messageAdmissionIntentRevision += 1;
    let pendingRequest = state.pendingUserInputRequestsByThreadId.get(threadId);
    if (!pendingRequest) {
      throw new Error("There is no pending question for this thread.");
    }
    const submissionProjectGeneration = projectContextGeneration;
    const legacyAnchorId = isWorkbenchMcpQuestionnaireRequestKey(pendingRequest.requestKey) ? null : pendingRequest.itemId;

    if (isWorkbenchApprovalRequest(pendingRequest.request) && !hasWorkbenchApprovalDecisionSelection(pendingRequest.request, response)) {
      throw new Error("Choose one of the approval options before submitting.");
    }

    const supplementalApprovalSteerText = getWorkbenchApprovalSupplementalSteerText(pendingRequest.request, response);
    const supplementalInput = [
      ...(supplementalApprovalSteerText ? [createTextInput(supplementalApprovalSteerText)] : []),
      ...(options.supplementalInput ?? []),
    ];
    const hasActivatedSkills = Boolean(options.activatedSkillPaths?.length);
    const projectId = effectiveThreadProjectContext(pendingRequest.harness, pendingRequest.threadId).projectId;
    if (!projectId) throw new Error("The questionnaire thread has no selected project.");
    const submitResult = await daemon.threads.questionnaire.respond({
      ...(options.activatedSkillPaths?.length ? { activatedSkillPaths: options.activatedSkillPaths } : {}),
      insertAfterItemId: options.insertAfterItemId ?? legacyAnchorId,
      insertAfterItemIndex: options.insertAfterItemIndex ?? null,
      projectId,
      requestKey: pendingRequest.requestKey,
      response,
      ...(supplementalInput.length ? { supplementalInput } : {}),
      threadId,
      turnId: options.turnId ?? pendingRequest.turnId,
    });
    if (disposed || submissionProjectGeneration !== projectContextGeneration) {
      return;
    }
    if (submitResult.warning) {
      emitStatusMessage(submitResult.warning);
    }
    const providerRequests = providerPendingUserInputRequestsByHarness.get(pendingRequest.harness);
    if (providerRequests?.get(threadId)?.requestKey === pendingRequest.requestKey) {
      providerRequests.delete(threadId);
    }
    resolvedDurableQuestionnaireKeysByThreadId.set(threadId, pendingRequest.requestKey);
    const clearedPendingRequest = clearPendingUserInputRequest(threadId, pendingRequest.requestKey);
    const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(threadId);
    if (clearedPendingRequest || clearedWaitingFlag) {
      emit();
    }
    if (supplementalInput.length || hasActivatedSkills) {
      await readCompletedThreadWorkbenchHistory(threadId);
    } else {
      await readCompletedQuestionnaireHistoryForHarness(threadId, pendingRequest.harness);
    }
  }

  function handleProviderNotification(
    notification: WorkbenchClientNotification,
    harness: WorkbenchHarness,
  ) {
    if (notification.method === "thread/goal/updated" || notification.method === "thread/goal/cleared") {
      threadGoals.observeNotification(notification);
    }

    if (notification.method === "questionnaire/requested") {
      const providerRequests = providerPendingUserInputRequestsByHarness.get(harness) ?? new Map<string, WorkbenchPendingUserInputRequest>();
      providerRequests.set(notification.params.threadId, {
        harness,
        itemId: notification.params.itemId,
        request: notification.params.request,
        requestKey: notification.params.requestKey,
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
      });
      providerPendingUserInputRequestsByHarness.set(harness, providerRequests);
      const selectedTurn = getCurrentInProgressTurn(state.currentThread);
      if (
        state.currentThread?.harness === harness
        && state.currentThread.id === notification.params.threadId
        && selectedTurn?.id === notification.params.turnId
      ) {
        messageAdmissionIntentRevision += 1;
      }
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
        markThreadWaitingOnUserInput(notification.params.threadId);
        emit();
      }
      return;
    }

    if (notification.method === "questionnaire/resolved") {
      const providerRequests = providerPendingUserInputRequestsByHarness.get(harness);
      if (providerRequests?.get(notification.params.threadId)?.requestKey === notification.params.requestKey) {
        providerRequests.delete(notification.params.threadId);
      }
      const clearedPendingRequest = clearPendingUserInputRequest(notification.params.threadId, notification.params.requestKey);
      const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(notification.params.threadId);
      if (clearedPendingRequest || clearedWaitingFlag) {
        emit();
      }
      if (doesNotificationTargetKnownThread(notification, harness)) {
        void readCompletedQuestionnaireHistoryForHarness(notification.params.threadId, harness);
      }
      return;
    }

    if (notification.method === "turn/completed" && notification.params.turn.status === "interrupted") {
      const pendingRequest = state.pendingUserInputRequestsByThreadId.get(notification.params.threadId);
      if (pendingRequest && (!pendingRequest.turnId || pendingRequest.turnId === notification.params.turn.id)) {
        const providerRequests = providerPendingUserInputRequestsByHarness.get(harness);
        if (providerRequests?.get(notification.params.threadId)?.requestKey === pendingRequest.requestKey) {
          providerRequests.delete(notification.params.threadId);
        }
        if (isApprovalUserInputRequest(pendingRequest.request)) {
          const clearedPendingRequest = clearPendingUserInputRequest(notification.params.threadId, pendingRequest.requestKey);
          const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(notification.params.threadId);
          if (clearedPendingRequest || clearedWaitingFlag) emit();
        }
      }
    }

    if (notification.method === "account/rateLimits/updated") {
      void account.refresh(harness, "notification");
      return;
    }

    if (notification.method === "browse/result/recorded") {
      if (doesNotificationTargetKnownThread(notification, harness)) {
        void readBrowseResultEntries(notification.params.threadId);
      }
      return;
    }

    const appliedKnownUserMessage = (
      notification.method === "item/started" || notification.method === "item/completed"
    ) && applyUserMessageNotificationToKnownThreadSource(notification, harness);
    if (!appliedKnownUserMessage) {
      applyNotificationToKnownThreadSource(notification, harness);
    }
    if (
      (
      notification.method === "turn/completed"
        || (notification.method === "item/completed" && notification.params.item.type === "userMessage")
      )
      && doesNotificationTargetKnownThread(notification, harness)
    ) {
      void readCompletedSteerHistory(notification.params.threadId);
    }
    if (
      notification.method === "turn/completed"
      && doesNotificationTargetKnownThread(notification, harness)
    ) {
      void readCompletedQuestionnaireHistoryForHarness(notification.params.threadId, harness);
    }
  }

  const unsubscribeNotifications = socket.onNotification((notification, harness) => {
    handleProviderNotification(notification, harness);
  });
  lifecycle.addUnsubscribe(unsubscribeNotifications);
  lifecycle.addUnsubscribe(() => {
    socket.dispose();
  });

  function clearThreadSelection() {
    selectedObservation?.release();
    selectedObservation = null;
    if (!state.currentThread && !state.currentThreadId && !account.hasRateLimits() && !selectedThreadProjectContext) {
      return;
    }

    threadDocuments.selectDocumentKey("");
    threadProjectContextGeneration += 1;
    selectedThreadProjectContext = null;
    messageAdmissionIntentRevision += 1;
    state.currentThreadId = "";
    state.currentThread = null;
    emit();
  }

  function hasThread(threadId: string) {
    return state.threads.some((thread) => thread.id === threadId);
  }

  function setCurrentThreadModel(threadId: string, model: string) {
    const thread = threadDocuments.getDocumentByThreadId(threadId);
    if (!thread) return;
    const reasoningEffort = resolvePreferredReasoningEffort(thread.harness, model);
    updateStablePreferenceSource(thread, (record) => {
      record.model = model;
      record.reasoningEffort = reasoningEffort;
    });
    updateThreadSourceFields(thread, {
      model,
      reasoningEffort,
    });
  }

  function applyAcceptedThreadTitle(threadId: WorkbenchThreadId, harness: WorkbenchHarness, title: string) {
    return updateThreadSourceFields({ harness, id: threadId }, { name: title });
  }

  function setCurrentThreadAgent(threadId: string, agentPath: string | null) {
    const thread = threadDocuments.getDocumentByThreadId(threadId);
    if (!thread) return;

    const normalizedAgentPath = normalizeWorkbenchAgentPath(agentPath);
    updateStablePreferenceSource(thread, (record) => {
      record.agentPath = normalizedAgentPath;
    });
    updateThreadSourceFields(thread, { agentPath: normalizedAgentPath });
  }

  function setCurrentThreadReasoningEffort(threadId: string, effort: string | null) {
    const thread = threadDocuments.getDocumentByThreadId(threadId);
    if (!thread?.model) return;

    updateStablePreferenceSource(thread, (record) => {
      record.reasoningEffort = effort;
    });
    updateThreadSourceFields(thread, { reasoningEffort: effort });
  }

  async function compactThread(thread: ThreadPayload) {
    if (thread.isDraft) {
      return thread;
    }

    messageAdmissionIntentRevision += 1;
    await daemon.threads.compact({ threadId: thread.id });
    return thread;
  }

  function setCurrentThreadServiceTier(threadId: string, serviceTier: string | null) {
    const thread = threadDocuments.getDocumentByThreadId(threadId);
    if (!thread) return;

    const nextServiceTier = serviceTier === "fast" ? "fast" : null;
    updateStablePreferenceSource(thread, (record) => {
      record.serviceTier = nextServiceTier;
    });
    updateThreadSourceFields(thread, { serviceTier: nextServiceTier });
  }

  function setCurrentThreadComposerSettings(threadId: string, settings: WorkbenchComposerSettings) {
    const thread = threadDocuments.getDocumentByThreadId(threadId);
    if (!thread) return;
    if (!thread.isDraft && thread.harness !== settings.harness) {
      return;
    }

    if (thread.isDraft && thread.harness !== settings.harness) {
      setDraftThreadHarness(settings.harness, threadId);
    }
    setCurrentThreadModel(threadId, settings.model);
    setCurrentThreadReasoningEffort(threadId, settings.reasoningEffort);
    setCurrentThreadAgent(threadId, settings.agentPath);
    setCurrentThreadServiceTier(threadId, settings.serviceTier);
    const configuredThread = threadDocuments.getDocumentByThreadId(threadId);
    if (configuredThread) updateThreadSourceFields(configuredThread, { contextWindowTokens: settings.contextWindowTokens ?? null });
  }

  function setDraftThreadHarness(harness: WorkbenchHarness, threadId = state.currentThreadId) {
    const currentThread = threadDocuments.getDocumentByThreadId(threadId);
    if (!currentThread?.isDraft) return;
    const selected = state.currentThreadId === threadId;
    const oldKey = getThreadSourceKey(currentThread);
    const nextThread: ThreadPayload = {
      ...currentThread,
      harness,
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      agentPath: null,
      contextWindowTokens: null,
      source: harness,
    };
    const newKey = installAuthoritativeThreadSource(nextThread);
    threadDocuments.materializeFinalVisibleDocument(newKey, projectThreadSource(newKey) ?? nextThread, { select: selected });
    if (newKey !== oldKey) {
      deleteThreadOwnedState(oldKey);
      messageAdmissionIntentRevision += 1;
    }
    if (selected) flushSelectedThreadRendering();
    else emit();
  }

  function createThread(
    harness: WorkbenchHarness,
    threadId?: DraftId,
    options: { project?: WorkbenchProjectOption; select?: boolean } = {},
  ) {
    const rootThreadId = threadId ?? createDraftThreadId();
    const projectContext = options.project ? projectThreadContext(options.project) : currentThreadProjectContext();
    const draftThread = {
      ...createDraftThread(harness, rootThreadId),
      cwd: projectContext.projectRootPath || projectContext.projectRoot,
    };
    if (options.select !== false) {
      installSelectedThreadProjectContext({ kind: "draft", harness, draftId: rootThreadId }, options.project);
      messageAdmissionIntentRevision += 1;
      setCurrentThread(draftThread);
    } else upsertThreadDocument(draftThread, { emitChange: true });
    return draftThread;
  }

  function dispose() {
    disposed = true;
    for (const controller of threadControllers.values()) controller.dispose({ transportClosing: true });
    threadControllers.clear();
    // This owner closes the shared socket below, so disconnect owns server subscription cleanup.
    threadObservations.disconnect();
    threadObservations.dispose();
    resetProjectThreadState({ emitChange: false });
    listeners.clear();
    transcripts.dispose();
    threadGoals.dispose();
    account.dispose();
    textPresentation.dispose();
    lifecycle.dispose();
  }

  return {
    threadObservations,
    setAppAvailable: available => socket.setSuspended(!available),
    getThreadController,
    recoverThreadControllers: async () => {
      const results = await Promise.allSettled([...threadControllers.values()].map(controller => controller.recover()));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    activateThreadControllers: () => {
      for (const controller of threadControllers.values()) {
        void controller.activate().catch(() => { /* The thread owner publishes and reports activation failures. */ });
      }
    },
    applyAcceptedThreadTitle,
    clearThreadSelection,
    createThread,
    dispose,
    getSnapshot,
    hasThread,
    installThreadStateSources,
    isCurrentThreadUpToDate,
    isDraftThreadId,
    listModels,
    openThread,
    onReconnect,
    onDisconnect: listener => socket.onConnectionClose(listener),
    onWorkbenchNotification,
    refreshCurrentThread,
    requestWorkbench,
    readThread,
    resetConnectionState,
    selectThreadPayload,
    refreshRateLimits,
    sendThreadMessage,
    compactThread,
    stopThread,
    threadGoals,
    transcripts,
    submitPendingUserInputRequest,
    setCurrentThreadAgent,
    setCurrentThreadComposerSettings,
    setCurrentThreadModel,
    setCurrentThreadReasoningEffort,
    setCurrentThreadServiceTier,
    setDraftThreadHarness,
    setProjectContext,
    subscribe,
    textPresentation,
  };
}

export default WorkbenchThreadClient;
