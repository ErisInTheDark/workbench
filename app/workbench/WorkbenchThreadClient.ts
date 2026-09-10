/*
 * Exports:
 * - WorkbenchThreadState: owned thread, rate-limit, and model cache state for the workbench.
 * - WorkbenchAcceptedIntent: provider-confirmed sidebar admission evidence handed to the workbench coordinator.
 * - WorkbenchThreadClientOptions: creation options for the thread client manager hooks.
 * - default WorkbenchThreadClient: own provider thread state, observation leases, live questionnaire reconciliation, durable answer recovery, and notifications.
 */

import { CodexAppServerClient } from "workbench-shared/codex/app-server-client";
import ThreadObservationController, { getThreadObservationKey } from "./thread/ThreadObservationController";
import WorkbenchThreadController, { type ThreadControllerTarget } from "./WorkbenchThreadController";
import type { CodexAppServerNotification } from "workbench-shared/codex/app-server-notifications";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "workbench-shared/workbench/orchestrator-reload";
import { WORKBENCH_STATS_IMPORT_UPDATED_METHOD } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { GetAccountRateLimitsResponse } from "workbench-shared/codex/generated/app-server/v2/GetAccountRateLimitsResponse";
import type { Model as CodexModel } from "workbench-shared/codex/generated/app-server/v2/Model";
import type { ModelListResponse } from "workbench-shared/codex/generated/app-server/v2/ModelListResponse";
import type { RateLimitSnapshot } from "workbench-shared/codex/generated/app-server/v2/RateLimitSnapshot";
import type { WorkbenchControls } from "workbench-shared/types";
import type { SandboxPolicy } from "workbench-shared/codex/generated/app-server/v2/SandboxPolicy";
import type { ThreadActiveFlag } from "workbench-shared/codex/generated/app-server/v2/ThreadActiveFlag";
import { ThreadTokenUsageSchema } from "workbench-shared/workbench/thread/thread-context-usage";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { ThreadCompactStartResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadCompactStartResponse";
import type { ThreadGoalClearResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadGoalClearResponse";
import type { ThreadGoalGetResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadGoalSetResponse";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { ThreadReadResponse as ProviderThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { WorkbenchThreadResponse } from "workbench-shared/workbench/thread/workbench-thread-identity";
import { DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema, type DraftId, type ProjectId, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadResumeParams } from "workbench-shared/codex/generated/app-server/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadResumeResponse";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { TurnStartParams } from "workbench-shared/codex/generated/app-server/v2/TurnStartParams";
import type { TurnStartResponse as ProviderTurnStartResponse } from "workbench-shared/codex/generated/app-server/v2/TurnStartResponse";
import type { TurnSteerResponse } from "workbench-shared/codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import {
    createQuestionnaireCollaborationMode,
    createTextInput,
    createThreadStartRequest,
    isCodexJsonRpcFailure,
} from "workbench-shared/codex/protocol";
import {
    formatThreadStatus,
    isProjectCodexThread,
    isProjectCodexThreadAtExpectedCwd,
    toThreadPayload,
    toThreadResumePayload,
    toThreadSummary,
} from "workbench-shared/codex/thread-adapter";
import { appendCommandOutputDelta, compactCommandExecutionItemOutput } from "workbench-shared/codex/thread-command-output";
import { areUserInputsEquivalentForUserMessageDedupe, normalizeThreadItems } from "workbench-shared/codex/thread-item-normalization";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import { getCurrentInProgressTurn, getCurrentTurn } from "workbench-shared/codex/thread-state";
import type {
    ThreadPayload,
    ThreadSummary,
    WorkbenchBrowseResultEntry,
    WorkbenchComposerSettings,
    WorkbenchHarness,
    WorkbenchListModelsOptions,
    WorkbenchModelOption,
    WorkbenchPendingUserInputRequest,
    WorkbenchProjectOption,
    WorkbenchProjectRoot,
    WorkbenchQuestionnaireHistoryEntry,
    WorkbenchReadThreadOptions,
    WorkbenchSendThreadMessageOptions,
    WorkbenchSteerHistoryEntry,
    WorkbenchSubagentSummary,
    WorkbenchSubmitUserInputRequestOptions,
    WorkbenchThreadDocumentSnapshot,
    WorkbenchThreadGoalControls,
    WorkbenchThreadRuntimeSnapshot,
    WorkbenchThreadTurnHistoryEntry,
    WorkbenchUserInputRequest,
    WorkbenchUserInputResponse,
} from "workbench-shared/types";
import { normalizeWorkbenchAgentPath } from "workbench-shared/workbench/agent-paths";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchTranscriptClient from "./database/transcript/WorkbenchTranscriptClient";
import { workbenchTranscriptOperations } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import LifecycleScope from "./state/LifecycleScope";
import WorkbenchClientStateController from "./state/WorkbenchClientStateController";
import ThreadDocumentStore from "./state/ThreadDocumentStore";
import ThreadSourceStore from "./state/ThreadSourceStore";
import ThreadCanonicalLayer from "./thread/ThreadCanonicalLayer";
import ThreadGoalController from "./thread/ThreadGoalController";
import ThreadMessageAdmissionController from "./thread/ThreadMessageAdmissionController";
import ThreadOptimisticInputStore from "./thread/ThreadOptimisticInputStore";
import type { WorkbenchThreadIdentityResolution, WorkbenchThreadIdentityResolveRequest } from "workbench-shared/workbench/thread/workbench-thread-identity";
import ThreadRenderPipeline from "./thread/ThreadRenderPipeline";
import ThreadStreamingReconciler from "./thread/ThreadStreamingReconciler";
import ThreadTextPresentationController, {
    type ThreadTextPresentationField,
    type ThreadTextPresentationKey,
} from "./thread/ThreadTextPresentationController";
import ThreadVisibleLayer from "./thread/ThreadVisibleLayer";
import ThreadWorkbenchOverlayLayer from "./thread/ThreadWorkbenchOverlayLayer";
import { getWorkbenchThreadHarnessCandidates } from "workbench-shared/workbench/thread/thread-harness-candidates";
import {
    WORKBENCH_THREAD_PAGE_READ_METHOD,
    type WorkbenchThreadPageResponse as ProviderThreadPageResponse,
} from "workbench-shared/workbench/thread/workbench-thread-page";
import { getTurnRenderSignature } from "./thread/thread-item-signature";
import { upsertWorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { ThreadMessageNotSentError } from "./thread/thread-message-submission";
import { applyQuestionnaireHistoryToThread, isSyntheticQuestionnaireHistoryItem } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import {
    isWorkbenchMcpQuestionnaireRequestKey,
    mergeQuestionnaireHistoryEntries,
} from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import {
    createWorkbenchQuestionnaireResponseInput,
    createWorkbenchThreadRecoveryId,
    isWorkbenchThreadRecoveryInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchQuestionnaireHistoryEntryState, WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { applySteerHistoryToThread, isSyntheticSteerHistoryItem } from "workbench-shared/workbench/thread/thread-steer-history";
import { stopWorkbenchThread } from "workbench-shared/workbench/thread/thread-stop";
import {
    getWorkbenchApprovalSupplementalSteerText,
    hasWorkbenchApprovalDecisionSelection,
    isWorkbenchApprovalRequest,
} from "workbench-shared/workbench/thread/thread-user-input-requests";
import ThreadTranscriptProjectionController from "./transcript/ThreadTranscriptProjectionController";
import reconcileTranscriptProjectionWithLiveThread from "./transcript/reconcile-transcript-projection-with-live-thread";

const RATE_LIMIT_REFRESH_TASK_ID = "rate-limit-refresh";
const RATE_LIMIT_AUTO_REFRESH_INTERVAL_MS = 15_000;
const AUTO_REFRESH_REQUEST_SOURCE = "autoRefresh";
const WORKBENCH_PROMPT_CONTEXT_FIELD = "workbenchPromptContext";
const DEFAULT_TURN_REASONING_SUMMARY = "detailed" as const;
const CODEX_RESUME_LIFECYCLE_PAGE = {
  itemsView: "notLoaded",
  limit: 1,
  sortDirection: "desc",
} as const;
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
const EMPTY_ROLLOUT_ERROR_FRAGMENT = "rollout at";
const EMPTY_ROLLOUT_ERROR_SUFFIX = "is empty";
const MISSING_ROLLOUT_ERROR_FRAGMENTS = ["no rollout found by id", "no rollout found for thread id"] as const;
const FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE = "Started the thread. Its saved rollout is still warming up, so the live view will refresh automatically.";

type WorkspaceWriteSandboxPolicy = Extract<SandboxPolicy, { type: "workspaceWrite" }>;

function createWorkspaceWriteSandboxPolicy(rootPaths: string[], options: { force?: boolean } = {}): WorkspaceWriteSandboxPolicy | null {
  const writableRoots = Array.from(new Set(rootPaths.filter(Boolean)));
  return writableRoots.length > 1 || (options.force && writableRoots.length > 0)
    ? {
      type: "workspaceWrite",
      writableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
    : null;
}

export interface WorkbenchThreadState {
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  hasLoadedThreads: boolean;
  isLoading: boolean;
  modelsByHarness: Map<WorkbenchHarness, WorkbenchModelOption[]>;
  pendingUserInputRequestsByThreadId: Map<string, WorkbenchPendingUserInputRequest>;
  projectId: ProjectId | "";
  projectRoot: string;
  projectRootPath: string;
  projectRoots: WorkbenchProjectRoot[];
  questionnaireHistoryByThreadId: Map<string, WorkbenchQuestionnaireHistoryEntry[]>;
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByHarness: Map<WorkbenchHarness, RateLimitSnapshot | null>;
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
  openThread: (threadId: string, options?: { harness?: WorkbenchHarness; project?: WorkbenchProjectOption; source?: "open" | "reload" }) => Promise<ThreadPayloadFetchOutcome>;
  onReconnect: (listener: () => void) => () => void;
  onWorkbenchNotification: (listener: (notification: {
    method: "workbench/thread-state/reset" | "workbench/thread-state/updated" | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD | typeof WORKBENCH_STATS_IMPORT_UPDATED_METHOD;
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

type RateLimitSnapshotSource = "cache" | "notification" | "read";

type RateLimitSnapshotEntry = {
  generation: number;
  receivedAt: number;
  snapshot: RateLimitSnapshot | null;
  source: RateLimitSnapshotSource;
};

type OptimisticUserMessagePlacement = "initial" | "steer";
type OptimisticUserMessageStatus = "pending" | "sent" | "interrupted" | "failed";
type ProviderSteerAcknowledgement = TurnSteerResponse | { ok: true } | { turn: Turn };

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

interface ThreadOverlayRevisionRecord {
  key: string;
  optimisticRevision: number;
  questionnaireForceProjectionEpoch: number;
  questionnaireRevision: number;
  browseResultRevision: number;
  steerRevision: number;
}

interface ThreadOperationFence {
  ownerIsCurrent?: () => boolean;
  overlayRevisions: Omit<ThreadOverlayRevisionRecord, "key">;
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
  shouldBypassCodexDraftBootstrap: boolean;
  workbenchOrigin: string | null;
}

interface ThreadStablePreferenceRecord {
  agentNickname: string | null;
  agentPath: string | null;
  agentRole: string | null;
  model: string | null;
  reasoningEffort: string | null;
  revision: number;
  serviceTier: string | null;
  tokenUsage: ThreadPayload["tokenUsage"];
}

interface ThreadStatusRecord {
  revision: number;
  status: string | null;
}

type ThreadReadResponse = WorkbenchThreadResponse<ProviderThreadReadResponse>;
type WorkbenchThreadPageResponse = ProviderThreadPageResponse<WorkbenchThreadId>;
type TurnStartResponse = Omit<ProviderTurnStartResponse, "turn"> & { turn: Omit<ProviderTurnStartResponse["turn"], "id"> & { id: WorkbenchTurnId } };

type CodexThreadSessionResponse = {
  initialTurnsPage?: ThreadResumeResponse["initialTurnsPage"];
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
    hasLoadedThreads: false,
    isLoading: false,
    modelsByHarness: new Map(),
    pendingUserInputRequestsByThreadId: new Map(),
    projectId: "",
    projectRoot: "Project",
    projectRootPath: "",
    projectRoots: [],
    questionnaireHistoryByThreadId: new Map(),
    rateLimits: null,
    rateLimitsByHarness: new Map(),
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

  if (harness === "opencode") {
    return true;
  }

  return isProjectCodexThread(thread, projectRootPaths);
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

function isOpenCodePendingTurn(turn: Turn) {
  return /^opencode:turn:[^:]+:pending:\d+$/u.test(turn.id);
}

function firstUserMessageInput(turn: Turn) {
  return turn.items.find((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage")?.content ?? null;
}

function removeResolvedOpenCodePendingTurns(incomingTurns: Turn[], existingTurns: Turn[]) {
  const matchedIncomingIndexes = new Set<number>();
  let changed = false;
  const nextExistingTurns = existingTurns.filter((existingTurn) => {
    if (!isOpenCodePendingTurn(existingTurn)) {
      return true;
    }

    const existingInput = firstUserMessageInput(existingTurn);
    if (!existingInput) {
      return true;
    }

    const incomingIndex = incomingTurns.findIndex((incomingTurn, index) => {
      if (matchedIncomingIndexes.has(index) || isOpenCodePendingTurn(incomingTurn)) {
        return false;
      }

      const incomingInput = firstUserMessageInput(incomingTurn);
      return !!incomingInput && areUserInputsEquivalentForUserMessageDedupe(existingInput, incomingInput);
    });
    if (incomingIndex === -1) {
      return true;
    }

    matchedIncomingIndexes.add(incomingIndex);
    changed = true;
    return false;
  });

  return changed ? nextExistingTurns : existingTurns;
}

function mergeWorkbenchThreadTurnBodies(
  harness: WorkbenchHarness,
  incomingTurns: Turn[],
  existingTurns: Turn[],
  history: WorkbenchThreadTurnHistoryEntry[],
) {
  return mergeThreadTurnBodies(
    incomingTurns,
    harness === "opencode" ? removeResolvedOpenCodePendingTurns(incomingTurns, existingTurns) : existingTurns,
    history,
  );
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

function isEmptyRolloutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return normalizedMessage.includes(EMPTY_ROLLOUT_ERROR_FRAGMENT)
    && normalizedMessage.includes(EMPTY_ROLLOUT_ERROR_SUFFIX);
}

function isMissingRolloutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return MISSING_ROLLOUT_ERROR_FRAGMENTS.some((fragment) => normalizedMessage.includes(fragment));
}

function isTransientRolloutReadError(error: unknown) {
  return isEmptyRolloutError(error) || isMissingRolloutError(error);
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
  const codexClient = new CodexAppServerClient();

  async function requestWorkbench<TResponse>(method: string, params: unknown) {
    const response = await codexClient.sendRequest<TResponse>({ method, params }, { socketOnly: true });
    if (isCodexJsonRpcFailure(response)) {
      const data = response.error.data && typeof response.error.data === "object" && !Array.isArray(response.error.data)
        ? response.error.data
        : null;
      throw new WorkbenchDaemonRequestError(response.error.message, response.error.code, data);
    }
    return response.result;
  }

  const threadObservations = new ThreadObservationController({ request: requestWorkbench });
  lifecycle.addUnsubscribe(codexClient.onConnectionClose(() => threadObservations.disconnect()));
  lifecycle.addUnsubscribe(codexClient.onWorkbenchNotification(notification => {
    if (notification.method === "workbench/thread-state/reset") threadObservations.disconnect();
    else if (notification.method === "workbench/thread-state/updated"
      && notification.params && typeof notification.params === "object"
      && "updateKind" in notification.params && notification.params.updateKind === "threadObservation") {
      threadObservations.accept(notification.params);
    }
  }));
  let selectedObservation: ReturnType<ThreadObservationController["acquire"]> | null = null;

  function onWorkbenchNotification(listener: (notification: {
    method: "workbench/thread-state/reset" | "workbench/thread-state/updated" | typeof WORKBENCH_RELOAD_DIRT_UPDATED_METHOD | typeof WORKBENCH_STATS_IMPORT_UPDATED_METHOD;
    params: unknown;
  }) => void) {
    return codexClient.onWorkbenchNotification((notification) => {
      if (
        notification.method === "workbench/thread-state/reset"
        || notification.method === "workbench/thread-state/updated"
        || notification.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD
        || notification.method === WORKBENCH_STATS_IMPORT_UPDATED_METHOD
      ) {
        listener({ method: notification.method, params: notification.params });
      }
    });
  }

  function onReconnect(listener: () => void) {
    return codexClient.onReconnect(listener);
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
      onDisconnect: (listener) => codexClient.onConnectionClose(listener),
      onNotification: (listener) => codexClient.onWorkbenchNotification(listener),
      request: async (method, params) => await requestWorkbench<unknown>(method, params),
    },
  });
  const threadGoals = new ThreadGoalController({
    clear: (params) => sendBridgeRequest<ThreadGoalClearResponse>("codex", { method: "thread/goal/clear", params }),
    get: (params) => sendBridgeRequest<ThreadGoalGetResponse>("codex", { method: "thread/goal/get", params }),
    set: (params) => sendBridgeRequest<ThreadGoalSetResponse>("codex", { method: "thread/goal/set", params }),
  });
  const listeners = new Set<WorkbenchThreadListener>();
  const rateLimitSnapshotEntriesByHarness = new Map<WorkbenchHarness, RateLimitSnapshotEntry>();
  const state = createInitialThreadState();
  const threadDocuments = ThreadDocumentStore({
    areDocumentsEquivalent: areThreadPayloadsEquivalent,
  });
  const threadSources = ThreadSourceStore();
  const threadControllers = new Map<string, WorkbenchThreadController>();
  const overlayRevisionsByKey = new Map<string, ThreadOverlayRevisionRecord>();
  const stablePreferencesByKey = new Map<string, ThreadStablePreferenceRecord>();
  const statusRecordsByKey = new Map<string, ThreadStatusRecord>();
  const streamingReconciler = new ThreadStreamingReconciler();
  const textPresentation = new ThreadTextPresentationController();
  function getThreadController(projectId: string, target: ThreadControllerTarget) {
    const threadId = target.kind === "draft" ? target.draftId : target.threadId;
    const key = `${projectId}\0${threadId}`;
    let controller = threadControllers.get(key);
    if (!controller) {
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
        observations: threadObservations,
        getChild: subagent => getThreadController(projectId, {
          kind: "subagent", harness: subagent.harness, parentThreadId: subagent.parentThreadId, threadId: subagent.threadId,
        }),
        readNative: () => {
          const document = threadDocuments.getDocumentByThreadId(threadId);
          return {
            document,
            pendingQuestionnaire: state.pendingUserInputRequestsByThreadId.get(threadId) ?? null,
            rateLimits: state.rateLimitsByHarness.get(document?.harness ?? (target.kind === "draft" ? "codex" : target.harness ?? "codex")) ?? null,
          };
        },
        subscribeNative: listener => subscribe(listener),
        read: async (readOptions, beforeCommit, selectionBound) => {
          await beforeCommit();
          const observed = target.kind === "draft" ? null : threadObservations.getSnapshot(getThreadObservationKey(projectId, target))
            .observation?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === threadId);
          const harness = observed && observed.entryKind !== "draft" ? observed.identity.harness
            : target.kind === "draft" ? "codex" : target.harness ?? getKnownThreadHarness(threadId) ?? "codex";
          const cwd = observed?.entryKind === "subagent" ? observed.cwd : options.getProjectById?.(projectId)?.rootPath;
          readOptions = { ...(cwd ? { cwd } : {}), ...readOptions };
          const outcome = await fetchThreadPayload(threadId, harness, readOptions, payload => selectedThreadProjectContext?.projectId === projectId && selectedThreadProjectContext.rootThreadId === threadId
            ? (setCurrentThread(payload), state.currentThread)
            : upsertThreadDocument(payload, { emitChange: true }), {
              selectionBound, beforeCommit, ownerIsCurrent: selectionBound ? undefined : controller!.captureLifetime(),
            });
          if (outcome.kind === "failure") throw new ThreadPayloadReadError(outcome.failure);
          return outcome.kind === "success" ? outcome.payload : null;
        },
        createTranscript: publish => {
          const projection = new ThreadTranscriptProjectionController({
            onError: error => console.error("Workbench SQLite transcript projection lifecycle failed.", error),
            onStateChange: publish,
            reconcileProjection: (projection, selection) => reconcileTranscriptProjectionWithLiveThread({
              mergeLiveTurn: (incoming, live) => mergeLiveStreamingTurn(incoming, live, { settleStreamingKeys: false }),
              projection, thread: selection.thread,
            }),
            transcripts: {
              reportParity: diagnostic => transcripts.reportParity(diagnostic),
              subscribe: (params, listener) => transcripts.subscribe(params, listener),
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
  const threadRenderPipeline = new ThreadRenderPipeline({
    canonicalLayer: new ThreadCanonicalLayer({
      normalizeCanonicalThread: (thread) => prepareCanonicalThreadSource(thread) ?? thread,
    }),
    overlayLayer: new ThreadWorkbenchOverlayLayer({
      applyBrowseResultOverlay: (thread) => applyPersistedBrowseResultEntries(thread) ?? thread,
      applyOptimisticOverlay: (thread) => applyOptimisticUserMessageOverlay(thread) ?? thread,
      applyQuestionnaireOverlay: (thread) => applyPersistedQuestionnaireHistory(thread) ?? thread,
      applyStablePreferenceOverlay: (thread) => projectStableThreadMetadata(thread),
      applyStatusOverlay: (thread) => projectThreadStatus(thread),
      applySteerOverlay: (thread) => applyPersistedSteerHistory(thread) ?? thread,
    }),
    visibleLayer: new ThreadVisibleLayer(),
  });
  const optimisticInputs = ThreadOptimisticInputStore();
  let disposed = false;
  let projectContextGeneration = 0;
  let threadProjectContextGeneration = 0;
  let selectedThreadProjectContext: SelectedThreadProjectContext | null = null;
  let messageAdmissionIntentRevision = 0;
  let rateLimitGeneration = 0;
  const rateLimitRefreshStartedAtByHarness = new Map<WorkbenchHarness, number>();
  const refreshRateLimitsPromisesByHarness = new Map<WorkbenchHarness, Promise<void>>();
  const pendingUserInputRequestGenerationsByHarness = new Map<WorkbenchHarness, number>();
  const questionnaireListSyncPromisesByHarness = new Map<WorkbenchHarness, Promise<boolean>>();
  const questionnaireListSyncedHarnesses = new Set<WorkbenchHarness>();
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
    client: codexClient,
    documents: threadDocuments,
    emitWarning: emitStatusMessage,
    getLifecycleState: (threadId) => {
      const projectContext = effectiveThreadProjectContext("codex", threadId);
      return {
        disposed,
        projectContextGeneration,
        projectId: projectContext.projectId,
        projectRootPath: projectContext.projectRootPath,
        messageAdmissionIntentRevision,
      };
    },
    getThreadStatus: (thread) => statusRecordsByKey.get(getThreadStateKey(thread.harness, thread.id))?.status ?? thread.status,
    optimisticInputs,
    publishAccepted: ({ projectId, threadId, title, turnId }) => {
      void publishAcceptedIntent({ harness: "codex", projectId, threadId, title, turnId });
    },
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
    harness: WorkbenchHarness,
    rootThreadId: string,
    project: WorkbenchProjectOption | undefined,
  ) {
    const projectId = project?.id ?? state.projectId;
    const target = { kind: "provider" as const, harness, threadId: ThreadReferenceSchema.parse(rootThreadId) };
    const observationKey = projectId && !isDraftThreadId(rootThreadId) ? getThreadObservationKey(projectId, target) : null;
    if (selectedObservation?.key !== observationKey) {
      selectedObservation?.release();
      selectedObservation = observationKey ? { key: observationKey, release: getThreadController(projectId, target).acquire("summary") } : null;
    }
    if (selectedThreadProjectContext?.projectId !== projectId
      || selectedThreadProjectContext.harness !== harness
      || selectedThreadProjectContext.rootThreadId !== rootThreadId) threadProjectContextGeneration += 1;
    selectedThreadProjectContext = { projectId, harness, rootThreadId };
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
      rateLimits: state.rateLimits,
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
    rateLimitGeneration += 1;
    for (const harness of ["codex", "copilot", "opencode"] as const) {
      bumpPendingUserInputRequestGeneration(harness);
    }
    messageAdmissionIntentRevision += 1;

    refreshRateLimitsPromisesByHarness.clear();

    state.subagents = [];
    state.threads = [];
    state.currentThread = null;
    state.currentThreadId = "";
    state.threadsError = "";
    state.hasLoadedThreads = false;
    state.isLoading = Boolean(getProjectRootPaths(state).length);
    state.rateLimits = null;
    threadDocuments.selectDocumentKey("");
    for (const key of Object.keys(threadDocuments.getSnapshot().documentsByKey)) {
      if (retainedKeys.has(key)) continue;
      threadDocuments.deleteDocumentKey(key);
      threadSources.delete(key);
      optimisticInputs.deleteThread(key);
      threadRenderPipeline.delete(key);
    }
    for (const map of [overlayRevisionsByKey, stablePreferencesByKey, statusRecordsByKey]) {
      for (const key of map.keys()) if (!retainedKeys.has(key)) map.delete(key);
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
    resolvedDurableQuestionnaireKeysByThreadId.clear();
    if (!retainedKeys.size) {
      threadSources.clear();
      optimisticInputs.clear();
      threadRenderPipeline.clear();
      textPresentation.clear();
      streamingReconciler.clearClientCreatedItemKeys();
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
    if (!thread || thread.harness !== "codex") {
      return thread;
    }

    return applySteerHistoryToThread(
      thread,
      state.steerHistoryByThreadId.get(thread.id) ?? [],
    );
  }

  function applyPersistedBrowseResultEntries(thread: ThreadPayload | null) {
    if (!thread || thread.harness !== "codex") {
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
    let record = overlayRevisionsByKey.get(key);
    if (!record) {
      record = {
        key,
        optimisticRevision: 0,
        questionnaireForceProjectionEpoch: 0,
        questionnaireRevision: 0,
        browseResultRevision: 0,
        steerRevision: 0,
      };
      overlayRevisionsByKey.set(key, record);
    }
    return record;
  }

  function getOverlayKeysForThreadId(threadId: string) {
    const selectedThreadKey = threadDocuments.getSelectedThreadKey();
    if (selectedThreadKey) {
      const selectedSource = threadSources.get(selectedThreadKey);
      if (selectedSource?.id === threadId) {
        return [selectedThreadKey];
      }
    }

    const matchingKeys = Object.entries(threadDocuments.getSnapshot().documentsByKey)
      .filter(([key, document]) => document?.id === threadId && threadSources.has(key))
      .map(([key]) => key);
    if (matchingKeys.length === 1) {
      return matchingKeys;
    }

    if (matchingKeys.length > 1) {
      return [];
    }

    return [getThreadStateKey("codex", threadId)];
  }

  function bumpOverlayRevisionForKey(key: string, revisionKey: keyof Omit<ThreadOverlayRevisionRecord, "key">) {
    const record = getOverlayRevisionRecord(key);
    record[revisionKey] += 1;
  }

  function bumpOverlayRevision(threadId: string, revisionKey: keyof Omit<ThreadOverlayRevisionRecord, "key">) {
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

  function getOrCreateStablePreferenceRecord(thread: ThreadPayload) {
    const key = getThreadSourceKey(thread);
    let record = stablePreferencesByKey.get(key);
    if (!record) {
      record = {
        agentNickname: null,
        agentPath: null,
        agentRole: null,
        model: null,
        reasoningEffort: null,
        revision: 0,
        serviceTier: null,
        tokenUsage: null,
      };
      stablePreferencesByKey.set(key, record);
    }
    return record;
  }

  function captureStablePreferenceSource(thread: ThreadPayload) {
    const record = getOrCreateStablePreferenceRecord(thread);
    const agentNickname = thread.agentNickname ?? record.agentNickname;
    const agentPath = thread.agentPath ?? record.agentPath;
    const agentRole = thread.agentRole ?? record.agentRole;
    const model = thread.model ?? record.model;
    const reasoningEffort = thread.reasoningEffort ?? record.reasoningEffort;
    const serviceTier = thread.serviceTier ?? record.serviceTier;
    const tokenUsage = thread.tokenUsage ?? record.tokenUsage;
    if (
      record.agentNickname === agentNickname
      && record.agentPath === agentPath
      && record.agentRole === agentRole
      && record.model === model
      && record.reasoningEffort === reasoningEffort
      && record.serviceTier === serviceTier
      && areDeeplyEqual(record.tokenUsage, tokenUsage)
    ) {
      return record;
    }

    record.agentNickname = agentNickname;
    record.agentPath = agentPath;
    record.agentRole = agentRole;
    record.model = model;
    record.reasoningEffort = reasoningEffort;
    record.serviceTier = serviceTier;
    record.tokenUsage = tokenUsage ?? null;
    record.revision += 1;
    return record;
  }

  function getStablePreferenceRevision(key: string) {
    return stablePreferencesByKey.get(key)?.revision ?? 0;
  }

  function updateStablePreferenceSource(
    thread: Pick<ThreadPayload, "harness" | "id">,
    updater: (record: ThreadStablePreferenceRecord) => void,
  ) {
    const key = getThreadSourceKey(thread);
    const source = threadSources.get(key);
    if (!source) {
      return false;
    }

    const record = getOrCreateStablePreferenceRecord(source);
    const snapshot = { ...record };
    updater(record);
    if (
      snapshot.agentNickname === record.agentNickname
      && snapshot.agentPath === record.agentPath
      && snapshot.agentRole === record.agentRole
      && snapshot.model === record.model
      && snapshot.reasoningEffort === record.reasoningEffort
      && snapshot.serviceTier === record.serviceTier
      && areDeeplyEqual(snapshot.tokenUsage, record.tokenUsage)
    ) {
      return false;
    }

    record.revision += 1;
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
    if (!threadSources.has(key)) {
      return false;
    }

    threadSources.update(key, (source) => ({ ...source, ...fields }));
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

  function projectStableThreadMetadata(thread: ThreadPayload) {
    const record = stablePreferencesByKey.get(getThreadSourceKey(thread));
    if (!record) {
      return thread;
    }

    const nextThread = {
      ...thread,
      agentNickname: thread.agentNickname ?? record.agentNickname,
      agentPath: thread.agentPath ?? record.agentPath,
      agentRole: thread.agentRole ?? record.agentRole,
      model: thread.model ?? record.model,
      reasoningEffort: thread.reasoningEffort ?? record.reasoningEffort,
      serviceTier: thread.serviceTier ?? record.serviceTier,
      tokenUsage: thread.tokenUsage ?? record.tokenUsage,
    };
    return nextThread.agentNickname === thread.agentNickname
      && nextThread.agentPath === thread.agentPath
      && nextThread.agentRole === thread.agentRole
      && nextThread.model === thread.model
      && nextThread.reasoningEffort === thread.reasoningEffort
      && nextThread.serviceTier === thread.serviceTier
      && nextThread.tokenUsage === thread.tokenUsage
      ? thread
      : nextThread;
  }

  function setThreadStatusSource(thread: Pick<ThreadPayload, "harness" | "id">, status: string | null) {
    const key = getThreadSourceKey(thread);
    const existing = statusRecordsByKey.get(key);
    if (existing?.status === status) {
      return existing;
    }

    const record = {
      revision: (existing?.revision ?? 0) + 1,
      status,
    };
    statusRecordsByKey.set(key, record);
    return record;
  }

  function getStatusRevision(key: string) {
    return statusRecordsByKey.get(key)?.revision ?? 0;
  }

  function projectThreadStatus(thread: ThreadPayload) {
    const status = statusRecordsByKey.get(getThreadSourceKey(thread))?.status;
    return status && status !== thread.status ? { ...thread, status } : thread;
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
    for (const harness of ["codex", "copilot", "opencode"] as const) {
      replacePendingUserInputRequests(harness, Array.from(state.pendingUserInputRequestsByThreadId.values()).filter((request) => (
        request.harness === harness && request.responseMode === "native"
      )));
      if (!questionnaireListSyncedHarnesses.has(harness)) {
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
      if (
        getThreadSourceKey(result.payload) !== fence.threadKey
        || !isHistoricalThreadReadFenceCurrent(fence)
      ) {
        return null;
      }
      const beforeTurnIndex = result.payload.turnHistory.findIndex((entry) => entry.turnId === cursor);
      if (beforeTurnIndex < 0) {
        return null;
      }
      const expectedTurnId = beforeTurnIndex > 0 ? result.payload.turnHistory[beforeTurnIndex - 1]?.turnId ?? null : null;
      if (
        result.payload.turns.length !== (expectedTurnId ? 1 : 0)
        || result.payload.turns.some((turn) => turn.id !== expectedTurnId)
      ) {
        return null;
      }
      const currentSource = threadSources.get(fence.threadKey);
      if (!currentSource) {
        return null;
      }
      const liveTurnsById = new Map(currentSource.turns.map((turn) => [turn.id, turn]));
      const turnHistory = mergeThreadTurnHistory(result.payload.turnHistory, currentSource.turnHistory);
      const incomingTurns = result.payload.turns.map((turn) => mergeLiveStreamingTurn(turn, liveTurnsById.get(turn.id)));
      const historicalPayload: ThreadPayload = {
        ...currentSource,
        nextPageCursor: result.payload.nextPageCursor,
        turnHistory,
        turns: mergeWorkbenchThreadTurnBodies(currentSource.harness, incomingTurns, currentSource.turns, turnHistory),
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
        status: statusRecordsByKey.get(fence.threadKey)?.status ?? currentSource.status,
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
    const rawThread = threadSources.get(key);
    if (!rawThread) {
      return null;
    }
    const overlayRevision = getOverlayRevisionRecord(key);
    return threadRenderPipeline.render({
      canonicalRevision: threadSources.getRevision(key),
      key,
      optimisticRevision: overlayRevision.optimisticRevision,
      publicRevision: 0,
      questionnaireForceProjectionEpoch: overlayRevision.questionnaireForceProjectionEpoch,
      questionnaireRevision: overlayRevision.questionnaireRevision,
      rawThread,
      browseResultRevision: overlayRevision.browseResultRevision,
      selected: key === threadDocuments.getSelectedThreadKey(),
      stablePreferenceRevision: getStablePreferenceRevision(key),
      statusRevision: getStatusRevision(key),
      steerRevision: overlayRevision.steerRevision,
    });
  }

  function materializeFinalVisibleThread(key: string, options: { select?: boolean } = {}) {
    const rawThread = threadSources.get(key);
    if (!rawThread) {
      if (options.select) {
        threadDocuments.selectDocumentKey("");
      }
      return null;
    }

    const finalVisibleThread = projectThreadSource(key);
    if (!finalVisibleThread) {
      return null;
    }
    threadDocuments.materializeFinalVisibleDocument(key, finalVisibleThread, { select: options.select });
    return finalVisibleThread;
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
      state.rateLimits = nextThread ? state.rateLimitsByHarness.get(nextThread.harness) ?? null : null;
    }
    if (publishRuntime) emit();
    if (selectionChanged) scheduleActiveTurnRateLimitRefresh();

    if (!nextThread) {
      return;
    }

    if (selectionChanged) {
      void refreshRateLimitsIfStale(nextThread.harness);
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

  function scheduleActiveTurnRateLimitRefresh() {
    const harness = state.currentThread?.harness;
    if (!harness || !getCurrentInProgressTurn(state.currentThread)) {
      lifecycle.cancel(RATE_LIMIT_REFRESH_TASK_ID);
      return;
    }

    if (lifecycle.has(RATE_LIMIT_REFRESH_TASK_ID)) {
      return;
    }

    void refreshRateLimitsIfStale(harness);

    lifecycle.scheduleRepeat(RATE_LIMIT_REFRESH_TASK_ID, RATE_LIMIT_AUTO_REFRESH_INTERVAL_MS, () => {
      if (disposed || state.currentThread?.harness !== harness || !getCurrentInProgressTurn(state.currentThread)) {
        lifecycle.cancel(RATE_LIMIT_REFRESH_TASK_ID);
        return;
      }

      return refreshRateLimitsIfStale(harness);
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
    overlayRevisionsByKey.delete(key);
    stablePreferencesByKey.delete(key);
    statusRecordsByKey.delete(key);
    optimisticInputs.deleteThread(key);
    threadRenderPipeline.delete(key);
    return didDeleteSource || didDeleteDocument;
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

    if (incomingItem.type === "plan" && liveItem.type === "plan") {
      return {
        ...incomingItem,
        text: mergeLongerStreamingText(incomingItem.text, liveItem.text),
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
      && (liveItem.type === "agentMessage" || liveItem.type === "reasoning" || liveItem.type === "plan");
  }

  function mergeLiveStreamingTurn(
    incomingTurn: Turn,
    liveTurn: Turn | undefined,
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
      && !streamingReconciler.hasClientCreatedItemForTurn(incomingTurn.id)
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
            streamingReconciler.hasClientCreatedItemKey(getThreadItemKey(incomingTurn.id, liveItemId))
            && streamingReconciler.isStructurallyMatchingItem(item, candidateLiveItem)
          ) {
            matchedLiveItem = candidateLiveItem;
            liveItemsById.delete(liveItemId);
            streamingReconciler.forgetStreamingItemKey(getThreadItemKey(incomingTurn.id, liveItemId), options);
            break;
          }
        }
        return matchedLiveItem ? mergeLiveStreamingItem(item, matchedLiveItem) : item;
      }

      liveItemsById.delete(item.id);
      streamingReconciler.forgetStreamingItemKey(getThreadItemKey(incomingTurn.id, item.id), options);
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
      items: streamingReconciler.pruneDuplicateItems(incomingTurn.id, nextItems, mergeLiveStreamingItem, options),
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
    const incomingTurns = incomingThread.turns.map((turn) => mergeLiveStreamingTurn(
      turn,
      liveTurnsById.get(turn.id),
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
      turns: mergeWorkbenchThreadTurnBodies(incomingThread.harness, incomingTurns, liveThread.turns, turnHistory),
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

  async function requestThreadPage(
    threadId: string,
    harness: WorkbenchHarness,
    options: WorkbenchReadThreadOptions = {},
  ): Promise<WorkbenchThreadPageResponse> {
    const cwd = options.cwd?.trim();
    const cursor = options.cursor ?? null;
    const shouldResumeManagedCodexThread = harness === "codex"
      && cursor === null
      && options.readScope !== "subagentBackground";
    const selectedAgentPath = state.currentThread?.harness === harness && state.currentThread.id === threadId
      ? state.currentThread.agentPath
      : null;
    const page = await sendBridgeRequest<WorkbenchThreadPageResponse>(harness, {
      method: WORKBENCH_THREAD_PAGE_READ_METHOD,
      ...(shouldResumeManagedCodexThread
        ? {
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
            harness,
            threadId,
            selectedAgentPath,
            readLocalWorkbenchOrigin(),
          ),
        }
        : {}),
      params: {
        cursor,
        ...(cwd ? { cwd } : {}),
        ...(options.readScope ? { readScope: options.readScope } : {}),
        threadId,
      },
    });
    const usage = ThreadTokenUsageSchema.nullable().optional().safeParse(page.tokenUsage);
    if (!usage.success) {
      reportClientSchemaError("Rejected thread-page context usage", usage.error);
      const { tokenUsage: _rejectedUsage, ...content } = page;
      return content;
    }
    return { ...page, ...(usage.data !== undefined ? { tokenUsage: usage.data } : {}) };
  }

  function upsertPendingUserInputRequest(
    threadId: string,
    harness: WorkbenchHarness,
    requestKey: string,
    request: WorkbenchUserInputRequest,
    {
      itemId = null,
      responseMode = "native",
      turnId = null,
    }: {
      itemId?: string | null;
      responseMode?: WorkbenchPendingUserInputRequest["responseMode"];
      turnId?: string | null;
    } = {},
  ) {
    const existing = state.pendingUserInputRequestsByThreadId.get(threadId);
    if (
      existing?.requestKey === requestKey
      && existing.harness === harness
      && existing.turnId === turnId
      && existing.itemId === itemId
      && existing.responseMode === responseMode
      && areDeeplyEqual(existing.request, request)
    ) {
      return false;
    }

    state.pendingUserInputRequestsByThreadId.set(threadId, {
      harness,
      itemId,
      request,
      requestKey,
      responseMode,
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
      nextRequests.set(request.threadId, { ...request, responseMode: "native" });
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
          responseMode: "newTurn",
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
          || existing.responseMode !== request.responseMode
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
    const promise = (async () => {
      let requests: WorkbenchPendingUserInputRequest[] = [];
      try {
        const response = await sendBridgeRequest<{ data: Array<Omit<WorkbenchPendingUserInputRequest, "harness" | "responseMode">> }>(harness, {
          method: "questionnaire/list",
        });
        requests = response.data.map((request) => ({ ...request, harness, responseMode: "native" }));
      } catch (error) {
        emitStatusMessage(`Workbench could not reconcile ${harness} questionnaires: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (disposed || generation !== projectContextGeneration) return false;
      questionnaireListSyncedHarnesses.add(harness);
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

  function getThreadHarness(threadId: string, fallback: WorkbenchHarness = "codex") {
    return getKnownThreadHarness(threadId) ?? fallback;
  }

  function getThreadHarnessCandidates(threadId: string, harness?: WorkbenchHarness) {
    return getWorkbenchThreadHarnessCandidates(threadId, harness ?? getKnownThreadHarness(threadId));
  }

  function getThreadModel(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return stablePreferencesByKey.get(getThreadSourceKey(state.currentThread))?.model ?? state.currentThread.model;
    }

    return null;
  }

  function getThreadReasoningEffort(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return stablePreferencesByKey.get(getThreadSourceKey(state.currentThread))?.reasoningEffort ?? state.currentThread.reasoningEffort;
    }

    return null;
  }

  function getThreadServiceTier(threadId: string) {
    if (state.currentThread?.id === threadId) {
      return stablePreferencesByKey.get(getThreadSourceKey(state.currentThread))?.serviceTier ?? state.currentThread.serviceTier;
    }

    return null;
  }

  function resolvePreferredReasoningEffort(harness: WorkbenchHarness, modelId: string | null) {
    if (!modelId) {
      return null;
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

  async function listModels(harness: WorkbenchHarness, options: WorkbenchListModelsOptions = {}) {
    const cachedModels = state.modelsByHarness.get(harness);
    if (cachedModels && !options.forceRefresh) {
      return cachedModels;
    }

    if (harness === "copilot" || harness === "opencode") {
      const projectContext = state.currentThread?.harness === harness
        ? effectiveThreadProjectContext(harness, state.currentThread.id)
        : currentThreadProjectContext();
      const response = await sendBridgeRequest<{ data: WorkbenchModelOption[] }>(harness, {
        method: "model/list",
        params: harness === "opencode" && projectContext.projectRootPath ? { cwd: projectContext.projectRootPath } : undefined,
      });
      state.modelsByHarness.set(harness, response.data);
      return response.data;
    }

    const models: WorkbenchModelOption[] = [];
    let cursor: string | null = null;

    do {
      const response: ModelListResponse = await sendBridgeRequest<ModelListResponse>(harness, {
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

  function recordLocalQuestionnaireHistoryEntry(
    pendingRequest: WorkbenchPendingUserInputRequest,
    response: WorkbenchUserInputResponse,
    options: WorkbenchSubmitUserInputRequestOptions,
  ) {
    const turnId = options.turnId ?? pendingRequest.turnId;
    if (!turnId) {
      return false;
    }

    const existingEntries = state.questionnaireHistoryByThreadId.get(pendingRequest.threadId) ?? [];
    const legacyAnchorId = isWorkbenchMcpQuestionnaireRequestKey(pendingRequest.requestKey) ? null : pendingRequest.itemId;
    const entry: WorkbenchQuestionnaireHistoryEntry = {
      insertAfterItemId: options.insertAfterItemId ?? legacyAnchorId,
      insertAfterItemIndex: options.insertAfterItemIndex ?? null,
      itemId: pendingRequest.itemId,
      request: pendingRequest.request,
      requestKey: pendingRequest.requestKey,
      resolvedAt: Date.now(),
      response,
      threadId: pendingRequest.threadId,
      turnId,
    };
    return setQuestionnaireHistoryEntries(
      pendingRequest.threadId,
      mergeQuestionnaireHistoryEntries(existingEntries, [entry]),
    );
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
    const key = getThreadStateKey("codex", threadId);
    const generation = (questionnaireHistoryReadGenerationByKey.get(key) ?? 0) + 1;
    const projectGeneration = projectContextGeneration;
    questionnaireHistoryReadGenerationByKey.set(key, generation);
    try {
      const response = await sendBridgeRequest<{ data?: WorkbenchQuestionnaireHistoryEntry[] }>("codex", {
        method: "questionnaire/history/list",
        params: {
          threadId,
        },
      });
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
    if (harness !== "codex") {
      return [];
    }

    return await readCompletedQuestionnaireHistory(threadId);
  }

  async function readCompletedSteerHistory(threadId: string, options: { refreshProjection?: boolean } = {}) {
    const key = getThreadStateKey("codex", threadId);
    const generation = (steerHistoryReadGenerationByKey.get(key) ?? 0) + 1;
    const projectGeneration = projectContextGeneration;
    steerHistoryReadGenerationByKey.set(key, generation);
    try {
      const response = await sendBridgeRequest<{ data?: WorkbenchSteerHistoryEntry[] }>("codex", {
        method: "steer/history/list",
        params: {
          threadId,
        },
      });
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
    const key = getThreadStateKey("codex", threadId);
    const generation = (browseResultReadGenerationByKey.get(key) ?? 0) + 1;
    const projectGeneration = projectContextGeneration;
    browseResultReadGenerationByKey.set(key, generation);
    try {
      const response = await sendBridgeRequest<{ data?: WorkbenchBrowseResultEntry[] }>("codex", {
        method: "browse/result/list",
        params: {
          threadId,
        },
      });
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

  function shouldSendWorkbenchPromptContext(
    harness: WorkbenchHarness,
    options: Pick<WorkbenchSendThreadMessageOptions, "instructionInjections" | "workflowIds"> = {},
  ) {
    return harness === "codex"
      || harness === "opencode"
      || (harness === "copilot" && Boolean(options.instructionInjections || options.workflowIds));
  }

  function buildWorkbenchPromptContext(
    harness: WorkbenchHarness,
    threadId: string,
    agentPath: string | null,
    workbenchOrigin: string | null,
    instructionInjections: Record<string, string> | undefined = undefined,
    workflowIds: readonly string[] | undefined = undefined,
    instructionScope: "full" | "threadUtilities" = "full",
    activatedSkillPaths: readonly string[] | undefined = undefined,
  ) {
    const sourceCwd = threadSources.get(getThreadStateKey(harness, threadId))?.cwd;
    const currentCwd = state.currentThread?.harness === harness && state.currentThread.id === threadId
      ? state.currentThread.cwd
      : null;
    const projectContext = effectiveThreadProjectContext(harness, threadId);
    const selectedSkillPaths = Array.from(new Set(
      activatedSkillPaths?.map((skillPath) => skillPath.trim()).filter(Boolean) ?? [],
    ));
    return {
      ...(selectedSkillPaths.length ? { activatedSkillPaths: selectedSkillPaths } : {}),
      agentPath: normalizeWorkbenchAgentPath(agentPath),
      cwd: sourceCwd ?? currentCwd ?? projectContext.projectRootPath,
      harness,
      ...(instructionScope !== "full" ? { instructionScope } : {}),
      ...(instructionInjections ? { instructionInjections } : {}),
      projectId: projectContext.projectId,
      roots: projectContext.projectRoots,
      threadId,
      workbenchOrigin,
      workflowIds: workflowIds ?? getDefaultWorkflowIdsForThread(threadId),
    };
  }

  async function fetchThreadPayload(
    threadId: string,
    harness: WorkbenchHarness,
    options: WorkbenchReadThreadOptions = {},
    commit: (payload: ThreadPayload) => ThreadPayload | null = (payload) => payload,
    { selectionBound = false, beforeCommit, ownerIsCurrent }: { selectionBound?: boolean; beforeCommit?: () => Promise<void>; ownerIsCurrent?: () => boolean } = {},
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
      });

      if (projectRootPaths.length && !isProjectCodexThreadAtExpectedCwd(pageResponse.thread, projectRootPaths, options.cwd)) {
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
        : pageResponse.model ?? null;
      const nextServiceTier = harness === "codex"
        ? isCurrentThread
          ? getThreadServiceTier(threadId)
          : pageResponse.serviceTier ?? null
        : null;
      const result: ThreadReadResult = {
        pageResponse,
        payload: toThreadPayload(
          pageResponse.thread,
          harness,
          nextModel,
          isCurrentThread
            ? currentReasoningEffort
            : pageResponse.reasoningEffort ?? null,
          nextServiceTier,
          selectedAgentPath,
          pageResponse.tokenUsage ?? null,
          pageResponse.nextCursor,
        ),
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
      if (harness === "codex" && isTransientRolloutReadError(error)) {
        return {
          failure: {
            harness,
            message: FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE,
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
    if (harness !== "codex" || !subagent) {
      return null;
    }

    const cursor = options.cursor ?? null;
    const projectContext = effectiveThreadProjectContext(harness, threadId);
    const projectRootPaths = getThreadProjectRootPaths(projectContext);
    const expectedCwd = options.cwd?.trim() || subagent.cwd;
    const nextModel = getThreadModel(threadId);
    const nextReasoningEffort = getThreadReasoningEffort(threadId);
    const nextServiceTier = harness === "codex" ? getThreadServiceTier(threadId) : null;
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
        && !isProjectCodexThreadAtExpectedCwd(pageResponse.thread, projectRootPaths, expectedCwd)
      ) {
        return null;
      }

      const result: ThreadReadResult = {
        pageResponse,
        payload: toThreadPayload(
          pageResponse.thread,
          harness,
          nextModel,
          nextReasoningEffort,
          nextServiceTier,
          selectedAgentPath,
          pageResponse.tokenUsage ?? null,
          pageResponse.nextCursor,
        ),
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
    const isKnownCodexSubagent = harness === "codex" && state.subagents.some((candidate) => (
      candidate.threadId === threadId && candidate.harness === harness
    ));
    return readOptions?.readScope === "subagentBackground" && harness && isKnownCodexSubagent
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

  async function refreshRateLimitsIfStale(harness: WorkbenchHarness) {
    const existingRefresh = refreshRateLimitsPromisesByHarness.get(harness);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const lastStartedAt = rateLimitRefreshStartedAtByHarness.get(harness);
    const elapsedMs = lastStartedAt === undefined ? null : Date.now() - lastStartedAt;
    if (elapsedMs !== null && elapsedMs >= 0 && elapsedMs < RATE_LIMIT_AUTO_REFRESH_INTERVAL_MS) {
      return;
    }

    await refreshRateLimits(harness);
  }

  async function refreshRateLimits(harness = state.currentThread?.harness ?? "codex") {
    const existingRefresh = refreshRateLimitsPromisesByHarness.get(harness);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    rateLimitRefreshStartedAtByHarness.set(harness, Date.now());
    const projectGeneration = projectContextGeneration;
    const readGeneration = ++rateLimitGeneration;
    let refreshPromise: Promise<void>;
    refreshPromise = (async () => {
      try {
        const response = await sendBridgeRequest<GetAccountRateLimitsResponse>(harness, {
          method: "account/rateLimits/read",
          params: undefined,
          workbenchRequestSource: AUTO_REFRESH_REQUEST_SOURCE,
        });
        if (disposed || projectGeneration !== projectContextGeneration) {
          return;
        }
        const previousSnapshot = rateLimitSnapshotEntriesByHarness.get(harness)?.snapshot ?? null;
        setHarnessRateLimits(harness, selectRateLimitSnapshot(response, harness, previousSnapshot), {
          generation: readGeneration,
          source: "read",
        });
      } catch {
        if (readGeneration === rateLimitGeneration && !state.rateLimitsByHarness.has(harness) && state.currentThread?.harness === harness) {
          setRateLimits(null);
        }
      }
    })();

    refreshRateLimitsPromisesByHarness.set(harness, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (refreshRateLimitsPromisesByHarness.get(harness) === refreshPromise) {
        refreshRateLimitsPromisesByHarness.delete(harness);
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
          ? streamingReconciler.pruneDuplicateItems(turn.id, nextItems, mergeLiveStreamingItem)
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
          if (!streamingReconciler.hasClientCreatedItemKey(itemKey) || !streamingReconciler.isStructurallyMatchingItem(compactedIncomingItem, item)) {
            return true;
          }

          matchedClientItem = item;
          streamingReconciler.forgetStreamingItemKey(getThreadItemKey(turnId, item.id));
          return false;
        });
        return [...nextItems, matchedClientItem ? mergeLiveStreamingItem(compactedIncomingItem, matchedClientItem) : compactedIncomingItem];
      }

      streamingReconciler.forgetStreamingItemKey(getThreadItemKey(turnId, compactedIncomingItem.id));
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

  function createStreamingPlanItem(itemId: string): Extract<ThreadItem, { type: "plan" }> {
    return {
      type: "plan",
      id: itemId,
      text: "",
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
    const itemKey = getThreadItemKey(turnId, itemId);
    ensureTurnForStreamingDelta(threadKey, turnId);
    return updateTurnItems(threadKey, turnId, (items) => {
      const itemIndex = items.findIndex((item) => item.id === itemId);
      if (itemIndex === -1) {
        const nextItem = updater(createItem(), false);
        if (!nextItem) {
          return null;
        }

        streamingReconciler.addClientCreatedItemKey(itemKey);
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
    return updateTurnItems(threadKey, turnId, (items) => {
      const abandonedItemIds = items
        .filter((item) => (
          item.id !== incomingItemId
          && item.type === "fileChange"
          && item.status === "inProgress"
          && streamingReconciler.hasClientCreatedItemKey(getThreadItemKey(turnId, item.id))
        ))
        .map((item) => item.id);
      if (!abandonedItemIds.length) {
        return null;
      }

      const abandonedItemIdSet = new Set(abandonedItemIds);
      for (const itemId of abandonedItemIds) {
        streamingReconciler.forgetStreamingItemKey(getThreadItemKey(turnId, itemId));
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
    if (field === "planText") return item.type === "plan" ? item.text : null;
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
    const keys = (["json", "sqlite"] as const).map((kind) => (
      presentationKey(threadKey, threadId, turnId, itemId, field, index, kind)
    ));
    const useLeafPresentation = selected
      && hasVisibleLeaf
      && keys.some((key) => textPresentation.hasSubscribers(key));
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
    } else if (item.type === "plan") {
      fields.push({ field: "planText", index: null, text: item.text });
    } else if (item.type === "commandExecution") {
      fields.push({ field: "commandExecutionOutput", index: null, text: item.aggregatedOutput ?? "" });
    } else if (item.type === "reasoning") {
      item.summary.forEach((text, index) => fields.push({ field: "reasoningSummary", index, text }));
      item.content.forEach((text, index) => fields.push({ field: "reasoningContent", index, text }));
    }
    for (const entry of fields) {
      for (const kind of ["json", "sqlite"] as const) {
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

  function getNotificationTargetThreadId(notification: CodexAppServerNotification) {
    return "threadId" in notification.params
      ? notification.params.threadId
      : "thread" in notification.params
        ? notification.params.thread.id
        : null;
  }

  function doesNotificationTargetSelectedThread(
    notification: CodexAppServerNotification,
    harness: WorkbenchHarness,
  ) {
    const threadId = getNotificationTargetThreadId(notification);
    return threadId !== null
      && state.currentThread?.harness === harness
      && state.currentThreadId === threadId;
  }

  function doesNotificationTargetKnownThread(
    notification: CodexAppServerNotification,
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

  function applyCodexUserMessageNotificationToKnownThreadSource(
    notification: Extract<CodexAppServerNotification, { method: "item/started" | "item/completed" }>,
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

  function applyCodexNotificationToKnownThreadSource(
    notification: CodexAppServerNotification,
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
        const summary = toThreadSummary({ ...notification.params.thread, id: WorkbenchThreadIdSchema.parse(notification.params.thread.id) }, harness);
        return updateThreadSource(threadKey, source => ({
          ...source,
          ...summary,
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
      case "item/plan/delta":
        return acceptPresentationDelta({
          apply: (publishSelected) => updateOrCreateThreadItem(
            threadKey,
            notification.params.turnId,
            notification.params.itemId,
            () => createStreamingPlanItem(notification.params.itemId),
            (item) => item.type === "plan"
              ? { ...item, text: `${item.text}${notification.params.delta}` }
              : null,
            { publishSelected },
          ),
          delta: notification.params.delta,
          field: "planText",
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
      case "thread/archived":
      case "thread/reverted":
      case "thread/queue/changed":
      case "project/changed":
      case "thread/project/updated":
      case "autoApprovalReview/strictReviewRequired":
      case "mcpServer/event/stream/notification":
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted":
      case "thread/realtime/item/started":
      case "thread/realtime/item/transcript/delta":
      case "thread/realtime/item/completed":
      case "thread/deleted":
      case "thread/unarchived":
      case "thread/closed":
      case "thread/environment/connected":
      case "thread/environment/disconnected":
      case "thread/settings/updated":
      case "thread/goal/updated":
      case "thread/goal/cleared":
      case "thread/compacted":
      case "hook/started":
      case "hook/completed":
      case "turn/diff/updated":
      case "turn/plan/updated":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "rawResponseItem/completed":
      case "rawResponse/completed":
      case "command/exec/outputDelta":
      case "item/commandExecution/terminalInteraction":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
      case "serverRequest/resolved":
      case "process/outputDelta":
      case "process/exited":
      case "questionnaire/requested":
      case "questionnaire/resolved":
      case "browse/result/recorded":
      case "model/rerouted":
      case "model/verification":
      case "turn/moderationMetadata":
      case "model/safetyBuffering/updated":
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
      case "externalAgentConfig/import/progress":
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

  async function openThread(
    threadId: string,
    {
      harness,
      project,
      source = "open",
    }: { harness?: WorkbenchHarness; project?: WorkbenchProjectOption; source?: "open" | "reload" } = {},
  ) {
    if (source === "open") messageAdmissionIntentRevision += 1;
    const intentRevision = messageAdmissionIntentRevision;
    if (options.resolveThreadIdentity) {
      try {
        const identity = await options.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), harness, projectId: project?.id ?? ProjectIdSchema.parse(state.projectId) });
        if (intentRevision !== messageAdmissionIntentRevision) return { kind: "superseded" } satisfies ThreadPayloadFetchOutcome;
        if (!identity) throw new Error("Thread identity has not been observed in this project.");
        threadId = identity.threadId;
        harness = identity.harness;
      } catch (error) {
        return { kind: "failure", failure: {
          harness: harness ?? "codex", transientRollout: false,
          message: error instanceof Error ? error.message : "Thread identity lookup failed.",
        } } satisfies ThreadPayloadFetchOutcome;
      }
    }
    const resolvedHarness = harness ?? getKnownThreadHarness(threadId) ?? "codex";
    const nextProjectId = project?.id ?? state.projectId;
    const selectedProjectId = selectedThreadProjectContext?.projectId ?? state.projectId;
    const reuseCurrent = (
      source === "open"
      && state.currentThread?.id === threadId
      && state.currentThread.harness === resolvedHarness
      && nextProjectId === selectedProjectId
    );
    installSelectedThreadProjectContext(resolvedHarness, threadId, project);

    try {
      const owner = getThreadController(nextProjectId, { kind: "provider", harness: resolvedHarness, threadId: ThreadReferenceSchema.parse(threadId) });
      if (reuseCurrent) {
        await owner.waitForAdmission();
        if (intentRevision !== messageAdmissionIntentRevision || state.currentThread?.id !== threadId) return { kind: "superseded" } as const;
        return { kind: "success", payload: state.currentThread } as const;
      }
      const payload = await owner.read({}, { selectionBound: source === "open" });
      return payload ? { kind: "success", payload } as const : { kind: "superseded" } as const;
    } catch (error) {
      return { kind: "failure", failure: error instanceof ThreadPayloadReadError ? error.failure : {
        harness: resolvedHarness, transientRollout: false,
        message: error instanceof Error ? error.message : "Unable to open thread.",
      } } as const;
    }
  }

  function selectThreadPayload(thread: ThreadPayload) {
    installSelectedThreadProjectContext(thread.harness, thread.id, undefined);
    messageAdmissionIntentRevision += 1;
    setCurrentThread(thread);
  }

  function prepareCodexMessageAdmission(
    thread: ThreadPayload,
    sendOptions: WorkbenchSendThreadMessageOptions,
  ) {
    if (
      thread.harness !== "codex"
      || thread.isDraft
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
      selectedModel,
      selectedServiceTier,
      sendOptions,
      shouldBypassCodexDraftBootstrap,
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
      let refreshedThread: ThreadPayload;
      if (harness === "codex") {
        const response = await sendBridgeRequest<ThreadReadResponse>(harness, {
          method: "thread/read",
          params: { includeTurns: false, threadId: resolvedThreadId },
          workbenchThreadHydration: { mode: "latest" },
        });
        refreshedThread = toThreadPayload(
          response.thread,
          harness,
          selectedModel ?? resumedThread.model,
          resumedThread.reasoningEffort,
          selectedServiceTier,
          resumedThread.agentPath,
        );
      } else {
        const response = await sendBridgeRequest<ThreadReadResponse>(harness, {
          method: "thread/read",
          params: {
            includeTurns: true,
            ...(projectContext.projectRootPath ? { cwd: projectContext.projectRootPath } : {}),
            threadId: resolvedThreadId,
          },
          workbenchThreadHydration: { mode: "latest" },
        });
        refreshedThread = toThreadPayload(
          response.thread,
          harness,
          resumedThread.model,
          resumedThread.reasoningEffort,
          resumedThread.serviceTier,
          resumedThread.agentPath,
        );
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
      if (harness === "codex") {
        await readCompletedThreadWorkbenchHistory(resolvedThreadId);
      }
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
      if (!(shouldBypassCodexDraftBootstrap && harness === "codex" && isTransientRolloutReadError(error))) {
        emitStatusMessage(`The message was admitted, but immediate thread reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        emitStatusMessage(FRESH_CODEX_THREAD_ROLLOUT_STATUS_MESSAGE);
      }
      return null;
    }
  }

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    sendOptions: WorkbenchSendThreadMessageOptions = {},
  ) {
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
    const selectedServiceTier = harness === "codex" ? thread.serviceTier : null;
    const selectedAgentPath = normalizeWorkbenchAgentPath(thread.agentPath);
    const normalizedInput = normalizeThreadMessageInput(input);
    const firstMessagePreview = normalizedInput.find((entry) => entry.type === "text")?.text ?? "";
    const recoveryClientUserMessageId = isWorkbenchThreadRecoveryInput(normalizedInput)
      ? createWorkbenchThreadRecoveryId()
      : null;
    const workbenchOrigin = readLocalWorkbenchOrigin();
    const isDraftThread = thread.isDraft;
    const materializingDraftId = isDraftThread ? thread.id : undefined;
    const initialClientUserMessageId = harness === "codex" && isDraftThread && !recoveryClientUserMessageId
      ? optimisticInputs.createClientUserMessageId()
      : null;
    const shouldBypassCodexDraftBootstrap = harness === "codex" && isDraftThread;
    const canUseProvidedThread = sendOptions.selectThread === false
      && !isDraftThread
      && sendOptions.startNewTurn !== true
      && Boolean(getCurrentInProgressTurn(thread));
    let bootstrapThread: ThreadPayload | null = null;
    let connectingTurnId: string | null = null;
    let pendingInitialOptimisticHandle: string | null = null;
    const additionalWritableRoots = sendOptions.additionalWritableRoots ?? [];
    const codexWorkspaceSandboxPolicy = harness === "codex"
      ? createWorkspaceWriteSandboxPolicy([
        ...getThreadProjectRootPaths(operationProjectContext),
        ...additionalWritableRoots,
      ], {
        force: additionalWritableRoots.length > 0,
      })
      : null;

    if (!normalizedInput.length) {
      throw new Error("Message input cannot be empty.");
    }

    const codexAdmissionThreadKey = prepareCodexMessageAdmission(thread, sendOptions);
    if (codexAdmissionThreadKey) {
      const threadKey = codexAdmissionThreadKey;
      const admission = await messageAdmissionController.admit(thread.id, normalizedInput, {
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
            return;
          }
          const currentSource = threadSources.get(startedThreadKey);
          if (!currentSource) {
            return;
          }
          const sourceAdvanced = threadSources.getRevision(startedThreadKey) !== sourceRevision;
          const liveTurn = currentSource.turns.find((candidate) => candidate.id === turn.id);
          const mergedTurn = sourceAdvanced && liveTurn
            ? mergeLiveStreamingTurn(liveTurn, turn)
            : mergeLiveStreamingTurn(turn, liveTurn);
          const nextSource = {
            ...currentSource,
            status: sourceAdvanced ? currentSource.status : "active",
            turns: currentSource.turns.some((candidate) => candidate.id === turn.id)
              ? currentSource.turns.map((candidate) => candidate.id === turn.id ? mergedTurn : candidate)
              : [...currentSource.turns, mergedTurn],
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
          const entry = optimisticInputs.enqueueInitial(committedSource, turn.id, startedInput, {
            clientUserMessageId,
            status: "sent",
          });
          bumpOverlayRevisionForKey(entry.threadKey, "optimisticRevision");
          if (threadDocuments.getSelectedThreadKey() === startedThreadKey) {
            flushSelectedThreadRendering();
            options.onThreadStarted?.(projectThreadSource(startedThreadKey) ?? committedSource);
          }
        },
        resumeRequest: {
          method: "thread/resume",
          params: {
            excludeTurns: true,
            initialTurnsPage: CODEX_RESUME_LIFECYCLE_PAGE,
            ...(selectedModel ? { model: selectedModel } : {}),
            serviceTier: selectedServiceTier,
            threadId: thread.id,
          },
          ...(shouldSendWorkbenchPromptContext("codex", sendOptions)
            ? { [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext("codex", thread.id, selectedAgentPath, workbenchOrigin, sendOptions.instructionInjections, sendOptions.workflowIds) }
            : {}),
        },
        startRequest: {
          method: "turn/start",
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
            "codex",
            thread.id,
            selectedAgentPath,
            workbenchOrigin,
            sendOptions.instructionInjections,
            sendOptions.workflowIds,
            "full",
            sendOptions.activatedSkillPaths,
          ),
          params: {
            ...(selectedReasoningEffort ? { effort: selectedReasoningEffort } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            serviceTier: selectedServiceTier,
            ...(codexWorkspaceSandboxPolicy ? { sandboxPolicy: codexWorkspaceSandboxPolicy } : {}),
            summary: DEFAULT_TURN_REASONING_SUMMARY,
          },
        },
        steerRequest: {
          method: "turn/steer",
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
            "codex",
            thread.id,
            selectedAgentPath,
            workbenchOrigin,
            sendOptions.instructionInjections,
            sendOptions.workflowIds,
            "full",
            sendOptions.activatedSkillPaths,
          ),
          params: {},
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
        return null;
      }
      const source = threadSources.get(threadKey);
      if (!source) {
        return null;
      }
      return reconcileAdmittedThreadMessage({
        harness: "codex",
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
        shouldBypassCodexDraftBootstrap,
        workbenchOrigin,
      });
    }

    if (isDraftThread || !resolvedThreadId.trim()) {
      const threadStartRequest = createThreadStartRequest(0, {
        ...((harness === "codex" || harness === "opencode") && operationProjectContext.projectRootPath ? { cwd: operationProjectContext.projectRootPath } : {}),
        ...(codexWorkspaceSandboxPolicy
          ? {
            config: {
              sandbox_workspace_write: {
                writable_roots: codexWorkspaceSandboxPolicy.writableRoots,
                network_access: codexWorkspaceSandboxPolicy.networkAccess,
                exclude_tmpdir_env_var: codexWorkspaceSandboxPolicy.excludeTmpdirEnvVar,
                exclude_slash_tmp: codexWorkspaceSandboxPolicy.excludeSlashTmp,
              },
            },
            sandbox: "workspace-write" as const,
          }
          : {}),
        ...(harness === "codex" ? { ephemeral: false } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(harness === "codex" ? { serviceTier: selectedServiceTier } : {}),
      });
      const startedThreadResponse = await sendBridgeRequest<CodexThreadSessionResponse>(harness, {
        method: threadStartRequest.method,
        ...(shouldSendWorkbenchPromptContext(harness, sendOptions)
          ? { [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(harness, resolvedThreadId, selectedAgentPath, workbenchOrigin, sendOptions.instructionInjections, sendOptions.workflowIds) }
          : {}),
        params: harness === "copilot"
          ? {
            ...threadStartRequest.params,
            ...(selectedAgentPath ? { agentPath: selectedAgentPath } : {}),
            ...(operationProjectContext.projectId ? { projectId: operationProjectContext.projectId } : {}),
            ...(operationProjectContext.projectRootPath ? { cwd: operationProjectContext.projectRootPath } : {}),
            ...(workbenchOrigin ? { workbenchOrigin } : {}),
          } as typeof threadStartRequest.params & { agentPath?: string; cwd?: string; projectId?: string; workbenchOrigin?: string }
          : threadStartRequest.params,
      });
      if (!isSendProjectCurrent() || !isInitialSendSelectionCurrent()) {
        throw new ThreadMessageNotSentError();
      }

      const startedPayload = toThreadPayload(
        startedThreadResponse.thread,
        harness,
        startedThreadResponse.model ?? selectedModel ?? null,
        selectedReasoningEffort ?? startedThreadResponse.reasoningEffort ?? null,
        harness === "codex" ? selectedServiceTier : startedThreadResponse.serviceTier ?? null,
        selectedAgentPath,
      );
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
      if (!shouldBypassCodexDraftBootstrap) {
        if (
          !isSendProjectCurrent()
        ) {
          throw new ThreadMessageNotSentError();
        }
      }
    }

    let resumedThread: ThreadPayload | null = bootstrapThread ?? (canUseProvidedThread ? thread : null);
    if (!resumedThread || (!shouldBypassCodexDraftBootstrap && !canUseProvidedThread)) {
      const usesCodexThreadWindows = harness === "codex";
      const preparationFence = captureThreadOperationFence(harness, resolvedThreadId, {
        selectionBound: sendOptions.selectThread !== false,
      });
      const readableThreadResponse = await sendBridgeRequest<ThreadReadResponse>(harness, {
        method: "thread/read",
        params: {
          includeTurns: !usesCodexThreadWindows,
          ...(operationProjectContext.projectRootPath ? { cwd: operationProjectContext.projectRootPath } : {}),
          threadId: resolvedThreadId,
        },
        workbenchThreadHydration: { mode: "latest" },
      });
      if (!isSendProjectCurrent() || !isThreadOperationFenceCurrent(preparationFence)) {
        throw new ThreadMessageNotSentError();
      }
      const readableThread = toThreadPayload(readableThreadResponse.thread, harness);
      if (harness === "codex") {
        resumedThread = toThreadPayload(
          readableThreadResponse.thread,
          harness,
          selectedModel ?? readableThread.model,
          selectedReasoningEffort ?? readableThread.reasoningEffort,
          selectedServiceTier,
          selectedAgentPath,
        );
      } else {
        const resumedThreadResponse = await sendBridgeRequest<CodexThreadSessionResponse>(harness, {
          method: "thread/resume",
          params: {
            ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
            ...(operationProjectContext.projectId && harness === "copilot" ? { projectId: operationProjectContext.projectId } : {}),
            ...(operationProjectContext.projectRootPath ? { cwd: operationProjectContext.projectRootPath } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            threadId: resolvedThreadId,
          } as ThreadResumeParams & { agentPath?: string; cwd?: string; model?: string; threadId: string },
          ...(harness !== "opencode" && shouldSendWorkbenchPromptContext(harness, sendOptions)
            ? {
              [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
                harness,
                resolvedThreadId,
                selectedAgentPath,
                workbenchOrigin,
                sendOptions.instructionInjections,
                sendOptions.workflowIds,
                "threadUtilities",
              ),
            }
            : {}),
        });
        if (!isSendProjectCurrent() || !isThreadOperationFenceCurrent(preparationFence)) {
          throw new ThreadMessageNotSentError();
        }
        resumedThread = toThreadResumePayload(
          { ...resumedThreadResponse, model: resumedThreadResponse.model ?? undefined },
          harness,
          resumedThreadResponse.model ?? selectedModel ?? readableThread.model,
          selectedReasoningEffort ?? resumedThreadResponse.reasoningEffort ?? readableThread.reasoningEffort,
          resumedThreadResponse.serviceTier ?? readableThread.serviceTier,
          selectedAgentPath,
        );
      }

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
        steerResponse = await sendBridgeRequest<ProviderSteerAcknowledgement>(harness, {
          method: "turn/steer",
          ...(harness === "opencode" || harness === "codex"
            ? {
              [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
                harness,
                resolvedThreadId,
                selectedAgentPath,
                workbenchOrigin,
                sendOptions.instructionInjections,
                sendOptions.workflowIds,
                harness === "codex" ? "full" : "threadUtilities",
                sendOptions.activatedSkillPaths,
              ),
            }
            : {}),
          params: {
            ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
            ...(operationProjectContext.projectId && harness === "copilot" ? { projectId: operationProjectContext.projectId } : {}),
            ...(operationProjectContext.projectRootPath && harness !== "codex" ? { cwd: operationProjectContext.projectRootPath } : {}),
            ...(harness === "codex" && pendingSteerItem.clientId
              ? { clientUserMessageId: pendingSteerItem.clientId }
              : {}),
            expectedTurnId: currentInProgressTurn.id,
            input: normalizedInput,
            threadId: resolvedThreadId,
          } as { agentPath?: string; cwd?: string; expectedTurnId: string; input: UserInput[]; threadId: string },
        });
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

      if (harness === "copilot" && !("ok" in steerResponse && steerResponse.ok)) {
        updateOptimisticUserMessageStatus(harness, resolvedThreadId, optimisticTurnId, pendingSteerItem.id, "failed");
        if (sendOptions.selectThread !== false) {
          refreshCurrentThreadOptimisticUserMessages();
        }
        throw new Error("Copilot did not acknowledge the steer.");
      }
      const acknowledgedTurnId = harness === "codex" && "turnId" in steerResponse
        ? steerResponse.turnId.trim()
        : currentInProgressTurn.id;
      if (harness === "codex" && !acknowledgedTurnId) {
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
      const codexCollaborationMode = harness === "codex"
        ? (() => {
          const collaborationModel = selectedModel ?? resumedThread.model;
          return collaborationModel
            ? createQuestionnaireCollaborationMode(
              collaborationModel,
              selectedReasoningEffort ?? null,
            )
            : null;
        })()
        : null;
      let turnStartResponse: TurnStartResponse;
      try {
        turnStartResponse = await sendBridgeRequest<TurnStartResponse>(harness, {
          method: "turn/start",
          ...(harness === "codex"
            ? {
              [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
                "codex",
                resolvedThreadId,
                resumedThread.agentPath,
                workbenchOrigin,
                sendOptions.instructionInjections,
                sendOptions.workflowIds,
                "full",
                sendOptions.activatedSkillPaths,
              ),
            }
            : harness === "opencode"
            ? { [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(harness, resolvedThreadId, selectedAgentPath, workbenchOrigin, sendOptions.instructionInjections, sendOptions.workflowIds) }
            : {}),
          params: {
            ...(selectedAgentPath && harness === "copilot" ? { agentPath: selectedAgentPath } : {}),
            ...(operationProjectContext.projectRootPath && harness !== "codex" ? { cwd: operationProjectContext.projectRootPath } : {}),
            ...(codexCollaborationMode ? { collaborationMode: codexCollaborationMode } : {}),
            input: normalizedInput,
            ...(selectedReasoningEffort ? { effort: selectedReasoningEffort } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(harness === "codex" ? { serviceTier: selectedServiceTier } : {}),
            ...(codexWorkspaceSandboxPolicy ? { sandboxPolicy: codexWorkspaceSandboxPolicy } : {}),
            ...(recoveryClientUserMessageId || initialClientUserMessageId
              ? { clientUserMessageId: recoveryClientUserMessageId ?? initialClientUserMessageId }
              : {}),
            summary: DEFAULT_TURN_REASONING_SUMMARY,
            threadId: resolvedThreadId,
          } as TurnStartParams & {
            agentPath?: string;
            collaborationMode?: ReturnType<typeof createQuestionnaireCollaborationMode>;
            cwd?: string;
          },
        });
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
            void publishAcceptedIntent({
              ...(materializingDraftId ? { draftId: materializingDraftId } : {}),
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
      void publishAcceptedIntent({
        ...(materializingDraftId ? { draftId: materializingDraftId } : {}),
        harness,
        projectId: operationProjectContext.projectId,
        threadId: admittedThreadId,
        title: firstMessagePreview || "New thread",
        turnId: turnStartResponse.turn.id,
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
      );
      optimisticTurnId = admittedTurn.id;
      if (pendingInitialOptimisticHandle) {
        optimisticInputs.movePending(pendingInitialOptimisticHandle, optimisticTurnId);
        optimisticInputs.transition(pendingInitialOptimisticHandle, "sent");
        bumpOverlayRevisionForKey(getThreadStateKey(harness, resolvedThreadId), "optimisticRevision");
      }
      if (!pendingInitialOptimisticHandle && harness !== "opencode" && !recoveryClientUserMessageId) {
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
        if (harness !== "opencode") {
          setCurrentThread(resumedThread);
          options.onThreadStarted?.(resumedThread);
        }
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
      shouldBypassCodexDraftBootstrap,
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
    const threadProjectContext = effectiveThreadProjectContext(thread.harness, thread.id);

    if (activeTurn) {
      await stopWorkbenchThread({
        harness: thread.harness,
        sendRequest: async (harness, request) => {
          await sendBridgeRequest(harness, request);
        },
        threadId: thread.id,
        turnId: activeTurn.id,
      });
    }
    if (!isProjectOperationIdentityCurrent(projectIdentity)) {
      return thread;
    }

    if (pendingRequest) {
      const dismissal = await requestWorkbench<{ accepted: boolean }>("workbench/thread-state/questionnaire/dismiss", {
        identity: { harness: pendingRequest.harness, threadId: pendingRequest.threadId },
        projectId: threadProjectContext.projectId,
        requestKey: pendingRequest.requestKey,
      });
      if (!dismissal.accepted) {
        throw new Error("The pending questionnaire could not be dismissed.");
      }
      if (!isProjectOperationIdentityCurrent(projectIdentity)) {
        return thread;
      }
      resolvedDurableQuestionnaireKeysByThreadId.set(thread.id, pendingRequest.requestKey);
      const clearedPendingRequest = clearPendingUserInputRequest(thread.id, pendingRequest.requestKey);
      const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(thread.id);
      if (clearedPendingRequest || clearedWaitingFlag) {
        emit();
      }
    }

    return thread;
  }

  function getPendingUserInputRequestThread(pendingRequest: WorkbenchPendingUserInputRequest) {
    if (state.currentThread?.id === pendingRequest.threadId && state.currentThread.harness === pendingRequest.harness) {
      return state.currentThread;
    }

    const document = threadDocuments.getDocumentByThreadId(pendingRequest.threadId);
    return document?.harness === pendingRequest.harness ? document : null;
  }

  function getPendingUserInputRequestTurnId(pendingRequest: WorkbenchPendingUserInputRequest) {
    const pendingTurnId = pendingRequest.turnId?.trim();
    if (pendingTurnId) {
      return pendingTurnId;
    }

    const thread = getPendingUserInputRequestThread(pendingRequest);
    return thread ? getCurrentInProgressTurn(thread)?.id ?? null : null;
  }

  function getPendingUserInputRequestAgentPath(pendingRequest: WorkbenchPendingUserInputRequest) {
    return normalizeWorkbenchAgentPath(
      getPendingUserInputRequestThread(pendingRequest)?.agentPath
        ?? null,
    );
  }

  async function sendQuestionnaireSupplementalSteer(
    pendingRequest: WorkbenchPendingUserInputRequest,
    input: UserInput[] | string,
    activatedSkillPaths: readonly string[] | undefined,
  ) {
    const normalizedInput = normalizeThreadMessageInput(input);
    const hasActivatedSkills = pendingRequest.harness === "codex" && Boolean(activatedSkillPaths?.length);
    if (!normalizedInput.length && !hasActivatedSkills) {
      return;
    }

    const turnId = getPendingUserInputRequestTurnId(pendingRequest);
    if (!turnId) {
      throw new Error("Unable to send questionnaire supplemental input because the pending turn could not be found.");
    }

    const workbenchOrigin = readLocalWorkbenchOrigin();
    const agentPath = getPendingUserInputRequestAgentPath(pendingRequest);
    const projectContext = effectiveThreadProjectContext(pendingRequest.harness, pendingRequest.threadId);
    await sendBridgeRequest<TurnSteerResponse | { ok?: boolean }>(pendingRequest.harness, {
      method: "turn/steer",
      ...(pendingRequest.harness === "opencode" || pendingRequest.harness === "codex"
        ? {
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: buildWorkbenchPromptContext(
            pendingRequest.harness,
            pendingRequest.threadId,
            agentPath,
            workbenchOrigin,
            undefined,
            undefined,
            pendingRequest.harness === "codex" ? "full" : "threadUtilities",
            activatedSkillPaths,
          ),
        }
        : {}),
      params: {
        ...(agentPath && pendingRequest.harness === "copilot" ? { agentPath } : {}),
        ...(projectContext.projectId && pendingRequest.harness === "copilot" ? { projectId: projectContext.projectId } : {}),
        ...(projectContext.projectRootPath && pendingRequest.harness !== "codex" ? { cwd: projectContext.projectRootPath } : {}),
        ...(workbenchOrigin && pendingRequest.harness !== "codex" ? { workbenchOrigin } : {}),
        expectedTurnId: turnId,
        input: normalizedInput,
        threadId: pendingRequest.threadId,
      } as { agentPath?: string; cwd?: string; expectedTurnId: string; input: UserInput[]; projectId?: string; threadId: string; workbenchOrigin?: string },
    });

    if (pendingRequest.harness === "codex") {
      await readCompletedSteerHistory(pendingRequest.threadId);
    }
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
    if (isWorkbenchMcpQuestionnaireRequestKey(pendingRequest.requestKey)) {
      const reconciled = await refreshPendingUserInputRequests(pendingRequest.harness);
      const current = state.pendingUserInputRequestsByThreadId.get(threadId);
      if (
        disposed
        || submissionProjectGeneration !== projectContextGeneration
        || !current
        || current.harness !== pendingRequest.harness
        || current.requestKey !== pendingRequest.requestKey
      ) {
        throw new Error("The pending question changed before its response could be submitted.");
      }
      if (!reconciled) {
        throw new Error("Could not reconcile the questionnaire before submitting its response. Please try again.");
      }
      pendingRequest = current;
    }
    const legacyAnchorId = isWorkbenchMcpQuestionnaireRequestKey(pendingRequest.requestKey) ? null : pendingRequest.itemId;
    const submissionPendingGeneration = getPendingUserInputRequestGeneration(pendingRequest.harness);
    const isPendingSubmissionCurrent = () => (
      !disposed
      && submissionProjectGeneration === projectContextGeneration
      && submissionPendingGeneration === getPendingUserInputRequestGeneration(pendingRequest.harness)
      && state.pendingUserInputRequestsByThreadId.get(threadId)?.requestKey === pendingRequest.requestKey
    );

    if (isWorkbenchApprovalRequest(pendingRequest.request) && !hasWorkbenchApprovalDecisionSelection(pendingRequest.request, response)) {
      throw new Error("Choose one of the approval options before submitting.");
    }

    if (pendingRequest.responseMode === "newTurn") {
      if (isApprovalUserInputRequest(pendingRequest.request)) {
        throw new Error("Approval requests cannot be submitted after their owning turn ends.");
      }
      let thread = getPendingUserInputRequestThread(pendingRequest);
      const originalTurnId = options.turnId ?? pendingRequest.turnId ?? (thread ? getCurrentTurn(thread)?.id ?? null : null);
      if (!originalTurnId) {
        throw new Error("The saved questionnaire has no owning turn ID.");
      }
      if (!thread) {
        const metadata = await sendBridgeRequest<ThreadReadResponse>(pendingRequest.harness, {
          method: "thread/read",
          params: { threadId: pendingRequest.threadId, includeTurns: false },
        });
        if (!isPendingSubmissionCurrent()) {
          throw new Error("The pending question changed before its response could be submitted.");
        }
        const projectContext = effectiveThreadProjectContext(pendingRequest.harness, pendingRequest.threadId);
        const projectRoots = getThreadProjectRootPaths(projectContext);
        if (metadata.thread.id !== pendingRequest.threadId
          || (projectRoots.length && !isProjectCodexThreadAtExpectedCwd(metadata.thread, projectRoots, undefined))) {
          throw new Error("Questionnaire metadata does not belong to its thread and project.");
        }
        thread = getPendingUserInputRequestThread(pendingRequest) ?? projectStableThreadMetadata(toThreadPayload(
          metadata.thread, pendingRequest.harness, metadata.thread.model, metadata.thread.reasoningEffort,
        ));
      }
      const historyEntry: WorkbenchQuestionnaireHistoryEntryState = {
        insertAfterItemId: options.insertAfterItemId ?? legacyAnchorId,
        insertAfterItemIndex: options.insertAfterItemIndex ?? null,
        itemId: pendingRequest.itemId,
        request: pendingRequest.request,
        requestKey: pendingRequest.requestKey,
        resolvedAt: Date.now(),
        response: {
          answers: Object.fromEntries(
            Object.entries(response.answers).filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined),
          ),
        },
        threadId: pendingRequest.threadId,
        turnId: WorkbenchTurnIdSchema.parse(originalTurnId),
      };
      let admittedTurnId: string | null = null;
      await sendThreadMessage(
        thread,
        createWorkbenchQuestionnaireResponseInput(response),
        {
          onTurnAdmitted: (turnId) => {
            admittedTurnId = turnId;
          },
          activatedSkillPaths: options.activatedSkillPaths,
          selectThread: false,
          startNewTurn: true,
        },
      );
      if (!admittedTurnId) {
        throw new Error("The questionnaire response turn was not admitted.");
      }
      let transcriptWarning: string | null = null;
      if (pendingRequest.harness === "codex") {
        try {
          const transcriptResult = await sendBridgeRequest<{ ok: boolean; warning?: string }>("codex", {
            method: "questionnaire/history/record",
            params: historyEntry,
          });
          transcriptWarning = transcriptResult.warning ?? null;
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          transcriptWarning = `The questionnaire response turn started, but transcript history recording failed: ${message}`;
        }
      }
      const resolution = await requestWorkbench<{ accepted: boolean }>("workbench/thread-state/questionnaire/resolve", {
        entry: historyEntry,
        identity: { harness: pendingRequest.harness, threadId: pendingRequest.threadId },
        projectId: effectiveThreadProjectContext(pendingRequest.harness, pendingRequest.threadId).projectId,
      });
      if (!resolution.accepted) {
        throw new Error("The questionnaire response was admitted, but its durable history could not be resolved.");
      }
      if (disposed || submissionProjectGeneration !== projectContextGeneration) return;
      resolvedDurableQuestionnaireKeysByThreadId.set(threadId, pendingRequest.requestKey);
      recordLocalQuestionnaireHistoryEntry(pendingRequest, response, {
        insertAfterItemId: historyEntry.insertAfterItemId,
        insertAfterItemIndex: historyEntry.insertAfterItemIndex,
        turnId: historyEntry.turnId,
      });
      const clearedPendingRequest = clearPendingUserInputRequest(threadId, pendingRequest.requestKey);
      const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(threadId);
      refreshFinalVisibleQuestionnaireHistory(threadId);
      if (clearedPendingRequest || clearedWaitingFlag) emit();
      if (transcriptWarning) emitStatusMessage(transcriptWarning);
      return;
    }

    const supplementalApprovalSteerText = getWorkbenchApprovalSupplementalSteerText(pendingRequest.request, response);
    const supplementalInput = [
      ...(supplementalApprovalSteerText ? [createTextInput(supplementalApprovalSteerText)] : []),
      ...(options.supplementalInput ?? []),
    ];
    const hasActivatedSkills = pendingRequest.harness === "codex" && Boolean(options.activatedSkillPaths?.length);
    if (supplementalInput.length || hasActivatedSkills) {
      await sendQuestionnaireSupplementalSteer(pendingRequest, supplementalInput, options.activatedSkillPaths);
      if (!isPendingSubmissionCurrent()) {
        throw new Error("The pending question changed before its response could be submitted.");
      }
    }

    const submitResult = await sendBridgeRequest<{ ok: boolean; warning?: string }>(pendingRequest.harness, {
      method: "questionnaire/respond",
      params: {
        insertAfterItemId: options.insertAfterItemId ?? legacyAnchorId,
        insertAfterItemIndex: options.insertAfterItemIndex ?? null,
        response,
        requestKey: pendingRequest.requestKey,
        threadId,
        turnId: options.turnId ?? pendingRequest.turnId,
      },
    });
    if (disposed || submissionProjectGeneration !== projectContextGeneration) {
      return;
    }
    if (submitResult.warning) {
      emitStatusMessage(submitResult.warning);
    }
    resolvedDurableQuestionnaireKeysByThreadId.set(threadId, pendingRequest.requestKey);
    const clearedPendingRequest = clearPendingUserInputRequest(threadId, pendingRequest.requestKey);
    const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(threadId);
    if (clearedPendingRequest || clearedWaitingFlag) {
      emit();
    }
    if (pendingRequest.harness === "opencode") {
      if (recordLocalQuestionnaireHistoryEntry(pendingRequest, response, {
        insertAfterItemId: options.insertAfterItemId ?? legacyAnchorId,
        insertAfterItemIndex: options.insertAfterItemIndex ?? null,
        turnId: options.turnId ?? pendingRequest.turnId,
      })) {
        refreshFinalVisibleQuestionnaireHistory(threadId);
      }
    } else {
      if ((supplementalInput.length || hasActivatedSkills) && pendingRequest.harness === "codex") {
        await readCompletedThreadWorkbenchHistory(threadId);
      } else {
        await readCompletedQuestionnaireHistoryForHarness(threadId, pendingRequest.harness);
      }
    }
  }

  function handleCodexNotification(
    notification: CodexAppServerNotification,
    harness: WorkbenchHarness,
  ) {
    if (harness === "codex" && (notification.method === "thread/goal/updated" || notification.method === "thread/goal/cleared")) {
      threadGoals.observeNotification(notification);
    }

    if (notification.method === "questionnaire/requested") {
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
          responseMode: "native",
          turnId: notification.params.turnId,
        },
      )) {
        markThreadWaitingOnUserInput(notification.params.threadId);
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
      if (doesNotificationTargetKnownThread(notification, harness)) {
        void readCompletedQuestionnaireHistoryForHarness(notification.params.threadId, harness);
      }
      return;
    }

    if (notification.method === "turn/completed" && notification.params.turn.status === "interrupted") {
      const pendingRequest = state.pendingUserInputRequestsByThreadId.get(notification.params.threadId);
      if (pendingRequest && (!pendingRequest.turnId || pendingRequest.turnId === notification.params.turn.id)) {
        if (isApprovalUserInputRequest(pendingRequest.request)) {
          const clearedPendingRequest = clearPendingUserInputRequest(notification.params.threadId, pendingRequest.requestKey);
          const clearedWaitingFlag = clearThreadWaitingOnUserInputFlag(notification.params.threadId);
          if (clearedPendingRequest || clearedWaitingFlag) emit();
        } else if (pendingRequest.responseMode !== "newTurn") {
          state.pendingUserInputRequestsByThreadId.set(notification.params.threadId, { ...pendingRequest, responseMode: "newTurn" });
          bumpPendingUserInputRequestGeneration(pendingRequest.harness);
          emit();
        }
      }
    }

    if (notification.method === "account/rateLimits/updated") {
      void refreshRateLimits(harness);
      return;
    }

    if (notification.method === "browse/result/recorded") {
      if (doesNotificationTargetKnownThread(notification, harness)) {
        void readBrowseResultEntries(notification.params.threadId);
      }
      return;
    }

    const appliedKnownUserMessage = harness === "codex" && (
      notification.method === "item/started" || notification.method === "item/completed"
    ) && applyCodexUserMessageNotificationToKnownThreadSource(notification, harness);
    if (!appliedKnownUserMessage) {
      applyCodexNotificationToKnownThreadSource(notification, harness);
    }
    if (
      harness === "codex"
      && (
      notification.method === "turn/completed"
        || (notification.method === "item/completed" && notification.params.item.type === "userMessage")
      )
      && doesNotificationTargetKnownThread(notification, harness)
    ) {
      void readCompletedSteerHistory(notification.params.threadId);
    }
    if (
      harness === "codex"
      && notification.method === "turn/completed"
      && doesNotificationTargetKnownThread(notification, harness)
    ) {
      void readCompletedQuestionnaireHistoryForHarness(notification.params.threadId, harness);
    }
  }

  const unsubscribeCodexNotifications = codexClient.onNotification((notification, harness) => {
    handleCodexNotification(notification, harness);
  });
  lifecycle.addUnsubscribe(unsubscribeCodexNotifications);
  lifecycle.addUnsubscribe(() => {
    codexClient.dispose();
  });

  function clearThreadSelection() {
    selectedObservation?.release();
    selectedObservation = null;
    if (!state.currentThread && !state.currentThreadId && !state.rateLimits && !selectedThreadProjectContext) {
      return;
    }

    threadDocuments.selectDocumentKey("");
    threadProjectContextGeneration += 1;
    selectedThreadProjectContext = null;
    messageAdmissionIntentRevision += 1;
    state.currentThreadId = "";
    state.currentThread = null;
    setRateLimits(null);
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
    if (thread.isDraft || thread.harness !== "codex") {
      return thread;
    }

    messageAdmissionIntentRevision += 1;
    await sendBridgeRequest<ThreadCompactStartResponse>(thread.harness, {
      method: "thread/compact/start",
      params: {
        threadId: thread.id,
      },
    });
    return thread;
  }

  function setCurrentThreadServiceTier(threadId: string, serviceTier: string | null) {
    const thread = threadDocuments.getDocumentByThreadId(threadId);
    if (!thread || thread.harness !== "codex") return;

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
      installSelectedThreadProjectContext(harness, rootThreadId, options.project);
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
    textPresentation.dispose();
    lifecycle.dispose();
  }

  return {
    threadObservations,
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
