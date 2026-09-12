/*
 * Exports:
 * - WorkbenchThreadStateFeatureContext: stable database, sidebar, lifecycle, Git retention, and shared project-observation ports.
 * - WorkbenchProviderLifecycleObservation: provider event plus its persisted lifecycle result.
 * - normalizeProviderSidebarEntry: normalize provider sidebar rows.
 * - normalizeSubagentProviderLifecycle: resolve subagent lifecycle defaults.
 * - mapProviderLifecycleNotification: translate provider lifecycle notifications.
 * - mapProviderActivityNotification: translate provider activity notifications.
 * - default WorkbenchThreadStateFeature: own reconciliation, project observation, SQLite state, provider titles, thread-owned status commands, and provider notifications.
 */
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { getCurrentTurn } from "workbench-shared/codex/thread-state";
import { normalizeThreadTitle } from "../lib/thread-bootstrap";
import type { WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection, WorkbenchHarness, WorkbenchProjectsPayload, WorkbenchSubagentRelationship, WorkbenchThreadCreationProfile } from "workbench-shared/types";
import type { GitArcActiveClaim, GitArcLifecycleState as RepoGitArcLifecycleState, GitArcPlanState as RepoGitArcPlanState } from "../lib/workbench/git/WorkbenchGitCheckpointController";
import type { WorkbenchProjectStateRequest, WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import { getWorkbenchLifecycleTurnId, WorkbenchDurableQuestionnaireSchema, normalizeWorkbenchTimestampMs, resolveWorkbenchThreadTitle, type WorkbenchDurableQuestionnaire, type WorkbenchThreadLifecycle, type WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { stopWorkbenchThread } from "workbench-shared/workbench/thread/thread-stop";
import { isWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-user-input-requests";
import { getCodexQuestionnaireTimeout } from "./codex-questionnaire-timeout";
import type { HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import WorkbenchThreadStateController, { type WorkbenchObservedLifecycleEvent, type WorkbenchObservedThreadEntry, type WorkbenchThreadGitArcSnapshot, type WorkbenchThreadReconciliationFailure } from "./WorkbenchThreadStateController";
import WorkbenchThreadStateStore, {
  type WorkbenchThreadStateStoreDatabase,
} from "./WorkbenchThreadStateStore";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchGitArcActiveClaim } from "./WorkbenchGitArcFeature";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapNativeProviderResponse, mapWorkbenchProviderRequest } from "./thread-identity-workbench-mapping";
import { admitProviderThreads, admitProviderNotifications, mapProviderThread, mapProviderNotification } from "./thread-identity-provider-mapping";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { NativeThreadIdSchema, ThreadReferenceSchema, TurnReferenceSchema, type NativeThreadId, type ProjectId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";

interface ProjectRecord { id: ProjectId; rootPath: string }
interface ProjectResolution { cwd: string; project: ProjectRecord }
interface SubagentRelationshipList { subagents: WorkbenchSubagentRelationship[] }

type GitArcLifecycleState = Omit<RepoGitArcLifecycleState, "threadId"> & { threadId: WorkbenchThreadId };
type GitArcPlanState = Omit<RepoGitArcPlanState, "threadId"> & { threadId: WorkbenchThreadId };

function projectGitArc(state: GitArcLifecycleState | RepoGitArcLifecycleState | undefined) {
  if (!state) return null;
  const { harness: _harness, reloadScopes: _reloadScopes, threadId: _threadId, ...gitArc } = state as typeof state & { reloadScopes?: unknown };
  return gitArc;
}

function legacyGitArc(claim: WorkbenchGitArcActiveClaim) {
  return {
    checkpointCommit: claim.checkpointCommit,
    claimedPaths: claim.claimedPaths,
    harness: claim.harness,
    intentDescription: claim.intentDescription,
    intentName: claim.intentName,
    phase: "active" as const,
    proposals: claim.proposalId && (claim.proposalStatus === "proposed" || claim.proposalStatus === "committed")
      ? [{ proposalId: claim.proposalId, status: claim.proposalStatus }]
      : [],
    threadId: claim.threadId,
    updatedAt: claim.updatedAt,
  };
}

export interface WorkbenchThreadStateFeatureContext {
  identities: NativeTranscriptIdentityOwners;
  readComposerProfiles?: () => Promise<WorkbenchComposerProfileStorePayload>;
  recordComposerProfileUsage?: (profileId: string, at: number) => Promise<void>;
  database: WorkbenchThreadStateStoreDatabase;
  gitArcs: {
    findActiveClaim(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchGitArcActiveClaim | null>;
    hasLiveClaims?(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<boolean>;
    findLifecycleState?(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<GitArcLifecycleState | null>;
    findPlanState?(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<GitArcPlanState | null>;
    listActiveClaims(cwd: string): Promise<WorkbenchGitArcActiveClaim[]>;
    listLifecycleStates?(cwd: string): Promise<Array<GitArcLifecycleState>>;
    listPlanStates?(cwd: string): Promise<Array<GitArcPlanState>>;
    pruneThreadHistories?(cwd: string, identities: ReadonlyArray<{ harness: WorkbenchHarness; threadId: WorkbenchThreadId }>): Promise<unknown>;
  };
  getProjectCatalog(): WorkbenchProjectsPayload;
  harnesses: Pick<WorkbenchHarnessController, "listHarnesses" | "request" | "resumeThread">;
  listSubagents(projectId: ProjectId): Promise<SubagentRelationshipList>;
  log?: (message: string) => void;
  interruptRetainingQuestionnaire?: (threadId: NativeThreadId, requestKey: string, interrupt: () => Promise<boolean>) => Promise<boolean>;
  projectState: {
    getCurrentUpdate(projectId: string): WorkbenchProjectStateUpdate | null;
    handleRequest(projectId: string, request: WorkbenchProjectStateRequest): Promise<unknown>;
    observe(projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void): () => void;
  };
  reloadDirt?: Pick<WorkbenchReloadDirtController, "getSnapshot" | "subscribe">;
  publish(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  resolveProjectById(projectId: string): Promise<ProjectRecord>;
  resolveProjectFromCwd(cwd: string, options?: { endpointName?: string }): Promise<ProjectResolution>;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">
    & Partial<Pick<WorkbenchThreadTransitionCoordinator, "read">>;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function projectGitArcPlan(state: GitArcPlanState | RepoGitArcPlanState | undefined) {
  if (!state) return null;
  const { harness: _harness, reloadScopes: _reloadScopes, threadId: _threadId, ...gitArcPlan } = state as typeof state & { reloadScopes?: unknown };
  return gitArcPlan;
}

function normalizeOptionalTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? normalizeWorkbenchTimestampMs(value)
    : null;
}

type AdmittedThreadIdentities = {
  knownThread(reference: (typeof ThreadReferenceSchema)["_output"]): Pick<ReturnType<WorkbenchThreadIdentityController["knownThread"]>, "threadId">;
  knownTurn(reference: (typeof TurnReferenceSchema)["_output"]): Pick<ReturnType<WorkbenchThreadIdentityController["knownTurn"]>, "turnId">;
};

export function normalizeProviderSidebarEntry(harness: HarnessKind, value: unknown, identities: AdmittedThreadIdentities): WorkbenchObservedThreadEntry | null {
  const record = asRecord(value);
  if (typeof record?.id !== "string" || !record.id) return null;
  const threadId = identities.knownThread(ThreadReferenceSchema.parse(record.id)).threadId;
  const active = asRecord(record.status)?.type === "active" || record.status === "active";
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const activeTurn = [...turns].reverse().map(asRecord).find((turn) => turn?.status === "inProgress");
  const pendingTurn = activeTurn?.workbenchAdmission === "connecting" || activeTurn?.workbenchAdmission === "providerPending";
  const turnId = typeof record.currentTurnId === "string" && record.currentTurnId.trim()
    ? identities.knownTurn(TurnReferenceSchema.parse(record.currentTurnId)).turnId
    : !pendingTurn && typeof activeTurn?.id === "string" && activeTurn.id.trim()
      ? identities.knownTurn(TurnReferenceSchema.parse(activeTurn.id)).turnId : undefined;
  const updatedAt = normalizeOptionalTimestamp(record.updatedAt) ?? Date.now();
  let latestTurnStartedAt: number | null = null;
  for (const turn of turns) {
    const startedAt = normalizeOptionalTimestamp(asRecord(turn)?.startedAt);
    if (startedAt !== null && (latestTurnStartedAt === null || startedAt > latestTurnStartedAt)) latestTurnStartedAt = startedAt;
  }
  const orderAt = latestTurnStartedAt ?? normalizeOptionalTimestamp(record.recencyAt) ?? updatedAt;
  const namedTitle = resolveWorkbenchThreadTitle({
    fallback: "", id: threadId, name: typeof record.name === "string" ? record.name : null, preview: null,
  });
  return {
    ...(namedTitle ? { namedTitle } : {}),
    activityAt: updatedAt, entryKind: "thread", identity: { harness, threadId },
    lifecycle: active
      ? { agent: { agentStatus: "working", ...(turnId ? { turnId } : {}) }, kind: "working", reason: "acceptedIntent", settled: false }
      : { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    orderAt,
    title: resolveWorkbenchThreadTitle({
      id: threadId,
      name: typeof record.name === "string" ? record.name : null,
      preview: typeof record.preview === "string" ? record.preview : null,
    }),
  };
}

export function normalizeSubagentProviderLifecycle(lifecycle: WorkbenchThreadLifecycle | null | undefined): WorkbenchThreadLifecycle {
  return !lifecycle || (lifecycle.kind === "completed" && lifecycle.reason === "providerInactive")
    ? { kind: "completed", reason: "providerInactive", settled: false }
    : lifecycle;
}

export function mapProviderLifecycleNotification(notification: JsonRpcNotification, identities: AdmittedThreadIdentities): { event: WorkbenchObservedLifecycleEvent; threadId: WorkbenchThreadId } | null {
  const params = asRecord(notification.params);
  const threadId = typeof params?.threadId === "string" && params.threadId.trim()
    ? identities.knownThread(ThreadReferenceSchema.parse(params.threadId)).threadId : null;
  if (!threadId) return null;
  if (notification.method === "item/started" || notification.method === "item/completed") {
    const item = asRecord(params.item);
    const turnId = typeof params.turnId === "string" ? identities.knownTurn(TurnReferenceSchema.parse(params.turnId)).turnId : null;
    return item?.type === "userMessage" && turnId
      ? { event: { kind: "userInputDelivered", turnId }, threadId }
      : null;
  }
  if (notification.method === "turn/started") {
    const turn = asRecord(params.turn);
    if (turn?.workbenchAdmission === "connecting" || turn?.workbenchAdmission === "providerPending") return null;
    const turnId = typeof turn?.id === "string" ? identities.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId : null;
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return turnId && items.some((item) => asRecord(item)?.type === "userMessage")
      ? { event: { kind: "userInputDelivered", turnId }, threadId }
      : null;
  }
  if (notification.method === "turn/completed") {
    const turn = asRecord(params.turn);
    const turnId = typeof turn?.id === "string" ? identities.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId : null;
    const status = turn?.status;
    return turnId && (status === "completed" || status === "interrupted" || status === "failed")
      ? { event: { kind: "turnCompleted", status, turnId }, threadId }
      : null;
  }
  if (notification.method === "questionnaire/requested") {
    const requestKey = typeof params.requestKey === "string" ? params.requestKey : null;
    const turnId = typeof params.turnId === "string" ? identities.knownTurn(TurnReferenceSchema.parse(params.turnId)).turnId : null;
    if (!requestKey) return null;
    const questionnaire = WorkbenchDurableQuestionnaireSchema.safeParse({
      itemId: typeof params.itemId === "string" ? params.itemId : null,
      request: params.request,
      requestKey,
      turnId,
    });
    return {
      event: { kind: "pendingInput", questionnaire: questionnaire.success ? questionnaire.data : null, requestKey, turnId },
      threadId,
    };
  }
  if (notification.method === "questionnaire/resolved") {
    const requestKey = typeof params.requestKey === "string" ? params.requestKey : null;
    return requestKey ? { event: { kind: "inputResolved", requestKey }, threadId } : null;
  }
  if (notification.method === "thread/status/changed" && asRecord(params.status)?.type === "systemError") {
    return { event: { kind: "providerSystemError" }, threadId };
  }
  return null;
}

export interface WorkbenchProviderLifecycleObservation {
  event: WorkbenchObservedLifecycleEvent;
  lifecycle: WorkbenchThreadLifecycle | null;
  threadId: WorkbenchThreadId;
}

export function mapProviderActivityNotification(notification: JsonRpcNotification, identities: AdmittedThreadIdentities):
  | { kind: "activity"; threadId: WorkbenchThreadId }
  | { kind: "turnStarted"; startedAt: number | null; threadId: WorkbenchThreadId }
  | null {
  if (notification.method !== "turn/started" && notification.method !== "item/started" && notification.method !== "item/completed") return null;
  const params = asRecord(notification.params);
  const threadId = typeof params?.threadId === "string" && params.threadId.trim()
    ? identities.knownThread(ThreadReferenceSchema.parse(params.threadId)).threadId : null;
  if (!threadId) return null;
  return notification.method === "turn/started"
    ? { kind: "turnStarted", startedAt: normalizeOptionalTimestamp(asRecord(params.turn)?.startedAt), threadId }
    : { kind: "activity", threadId };
}

export default class WorkbenchThreadStateFeature {
  readonly controller: WorkbenchThreadStateController;
  private paginationQueue: Promise<unknown> = Promise.resolve();

  private async admitThread(harness: WorkbenchHarness, thread: ThreadReadResponse["thread"]) {
    const owners = this.context.identities;
    const { project } = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Thread-state provider admission" });
    const native = { harness, nativeLocation: thread.cwd, nativeThreadId: NativeThreadIdSchema.parse(thread.id) };
    await admitProviderThreads(owners, [{
      thread, metadata: {
        native, projectId: project.id, projectRoot: project.rootPath,
        title: thread.name ?? "", createdAt: Math.round(thread.createdAt * 1_000),
        updatedAt: Math.round(thread.updatedAt * 1_000), activityAt: Math.round(thread.updatedAt * 1_000),
      },
    }]);
    return mapProviderThread(owners, native, thread);
  }

  private async requestProvider(harness: WorkbenchHarness, request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const owners = this.context.identities;
    const mapped = owners ? await mapWorkbenchProviderRequest(owners.threads, harness, request) : { harness, request };
    const response = await this.context.harnesses.request(mapped.harness, mapped.request);
    if (!owners || response.error) return response;
    const result = asRecord(response.result);
    if (result?.thread) await this.admitThread(mapped.harness, result.thread as ThreadReadResponse["thread"]);
    if (mapped.request.method === "thread/list" && Array.isArray(result?.data)) {
      await Promise.all(result.data.map(thread => this.admitThread(mapped.harness, thread as ThreadReadResponse["thread"])));
    }
    const params = asRecord(mapped.request.params);
    if (typeof params?.threadId === "string") {
      const turns = result?.turn ? [result.turn as Turn]
        : mapped.request.method === "thread/turns/list" && Array.isArray(result?.data) ? result.data as Turn[] : [];
      if (turns.length) await admitProviderNotifications(owners, owners.threads.knownNativeBinding(mapped.harness, NativeThreadIdSchema.parse(params.threadId)),
        turns.map(turn => ({ method: "turn/started", params: { threadId: params.threadId as string, turn } })));
    }
    return mapNativeProviderResponse(owners, mapped.harness, mapped.request, response);
  }

  constructor(private readonly context: WorkbenchThreadStateFeatureContext) {
    this.controller = new WorkbenchThreadStateController({
      readComposerProfiles: context.readComposerProfiles,
      recordComposerProfileUsage: context.recordComposerProfileUsage,
      ...(context.reloadDirt ? {
        getReloadDirt: () => context.reloadDirt!.getSnapshot(),
        subscribeReloadDirt: (listener: () => void) => context.reloadDirt!.subscribe(listener),
      } : {}),
      log: context.log,
      interruptQuestionnaire: (projectId, harness, threadId, questionnaire) => this.interruptQuestionnaire(projectId, harness, threadId, questionnaire),
      getProjectCatalog: context.getProjectCatalog,
      projectState: context.projectState,
      publish: context.publish,
      ...(context.gitArcs.pruneThreadHistories ? {
        pruneExpiredGitState: async (projectId, identities) => {
          const project = await context.resolveProjectById(projectId);
          await context.gitArcs.pruneThreadHistories!(project.rootPath, identities);
        },
      } : {}),
      reconcileProject: (projectId, signal, acceptProviderSnapshot, acceptGitArcSnapshot) => this.reconcileProject(projectId, signal, acceptProviderSnapshot, acceptGitArcSnapshot),
      renameThread: async (projectId, harness, threadId, candidateTitle) => {
        const title = normalizeThreadTitle(candidateTitle);
        if (!title) throw new Error("A non-empty thread title is required.");
        const project = await context.resolveProjectById(projectId);
        await this.setProviderThreadTitle(harness, threadId, title, project.rootPath);
        return title;
      },
      resolveGitArc: async (projectId, harness, threadId) => {
        const project = await context.resolveProjectById(projectId);
        const state = context.gitArcs.findLifecycleState
          ? await context.gitArcs.findLifecycleState(project.rootPath, harness, threadId)
          : await context.gitArcs.findActiveClaim(project.rootPath, harness, threadId).then((claim) => claim ? legacyGitArc(claim) : null);
        return projectGitArc(state ?? undefined);
      },
      resolveGitArcPlan: async (projectId, harness, threadId) => {
        if (!context.gitArcs.findPlanState) return null;
        const project = await context.resolveProjectById(projectId);
        const state = await context.gitArcs.findPlanState(project.rootPath, harness, threadId);
        return projectGitArcPlan(state ?? undefined);
      },
      hasLiveGitArcClaims: async (projectId, harness, threadId) => {
        const project = await context.resolveProjectById(projectId);
        if (context.gitArcs.hasLiveClaims) {
          return await context.gitArcs.hasLiveClaims(project.rootPath, harness, threadId);
        }
        const state = context.gitArcs.findLifecycleState
          ? await context.gitArcs.findLifecycleState(project.rootPath, harness, threadId)
          : await context.gitArcs.findActiveClaim(project.rootPath, harness, threadId);
        return Boolean(state && state.claimedPaths.length);
      },
      runGitArcReadTransition: async (projectId, operation) => {
        const project = await context.resolveProjectById(projectId);
        const read = context.transitions.read ?? context.transitions.run;
        return await read.call(context.transitions, project.rootPath, operation);
      },
      threadStateStore: new WorkbenchThreadStateStore(context.database),
    });
  }

  async observeProviderNotification(harness: HarnessKind, notification: JsonRpcNotification) {
    const owners = this.context.identities;
    const params = asRecord(notification.params);
    let projectId: ProjectId | undefined;
    if (owners && typeof params?.threadId === "string") {
      const native = owners.threads.knownNativeBinding(harness, NativeThreadIdSchema.parse(params.threadId));
      projectId = (await owners.threads.resolveNative(native))?.projectId;
      await admitProviderNotifications(owners, native, [notification as ServerNotification]);
      notification = mapProviderNotification(owners, native, notification as ServerNotification);
    }
    const timeout = harness === "codex" ? getCodexQuestionnaireTimeout(notification) : null;
    if (timeout) {
      const pending = await this.findPendingQuestionnaire(harness, timeout.threadId);
      if (pending && pending.questionnaire.turnId === timeout.turnId) {
        await this.interruptQuestionnaire(pending.projectId, harness, timeout.threadId, pending.questionnaire);
      }
      return null;
    }
    const mapped = mapProviderLifecycleNotification(notification, owners.threads);
    let observation: WorkbenchProviderLifecycleObservation | null = null;
    if (mapped) {
      const lifecycle = projectId
        ? await this.controller.observeLifecycleInProject(projectId, harness, mapped.threadId, mapped.event)
        : await this.controller.observeLifecycle(harness, mapped.threadId, mapped.event);
      observation = { ...mapped, lifecycle };
      if (mapped.event.kind !== "userInputDelivered") return observation;
    }
    if (notification.method === "thread/name/updated") {
      const params = asRecord(notification.params);
      const threadId = typeof params?.threadId === "string" && params.threadId.trim()
        ? owners.threads.knownThread(ThreadReferenceSchema.parse(params.threadId)).threadId : null;
      const title = normalizeThreadTitle(typeof params?.name === "string" ? params.name : null);
      if (threadId && title) {
        if (projectId) await this.controller.setTitle(projectId, harness, threadId, title);
        else await this.controller.observeTitle(harness, threadId, title);
      }
      return observation;
    }
    const activity = mapProviderActivityNotification(notification, owners.threads);
    if (activity) await this.controller.observeActivity(harness, activity.threadId, activity.kind === "turnStarted" ? activity.startedAt : undefined, projectId);
    return observation;
  }

  private async setProviderThreadTitle(harness: WorkbenchHarness, threadId: string, title: string, cwd: string) {
    const response = await this.requestProvider(harness, {
      id: `thread-state:title:${threadId}`,
      method: "thread/name/set",
      params: { cwd, name: title, threadId },
    });
    if (response.error) throw new Error(response.error.message);
  }

  private async findPendingQuestionnaire(harness: WorkbenchHarness, threadId: string) {
    const identity = await this.context.identities.threads.resolve({ harness, threadId: ThreadReferenceSchema.parse(threadId) });
    if (!identity) return null;
    const entry = await this.controller.getThreadEntry(identity.projectId, harness, identity.threadId);
    return entry?.entryKind === "thread" && entry.pendingQuestionnaire
      ? { projectId: identity.projectId, entry, questionnaire: entry.pendingQuestionnaire } : null;
  }

  private async interruptQuestionnaire(projectId: ProjectId, harness: WorkbenchHarness, threadId: string, questionnaire: WorkbenchDurableQuestionnaire) {
    const isCurrent = async (observedTurnId?: ReturnType<typeof getWorkbenchLifecycleTurnId>) => {
      const current = await this.findPendingQuestionnaire(harness, threadId);
      if (!current || current.projectId !== projectId) return false;
      // Fence work accepted during this interruption, not the question's history.
      if (observedTurnId !== undefined && current.entry.lifecycle.kind === "working"
        && getWorkbenchLifecycleTurnId(current.entry.lifecycle) !== observedTurnId) return false;
      return current.questionnaire.requestKey === questionnaire.requestKey
        && current.questionnaire.itemId === questionnaire.itemId
        && !isWorkbenchApprovalRequest(current.questionnaire.request);
    };
    if (!await isCurrent()) return false;
    try {
      const project = await this.context.resolveProjectById(projectId);
      const response = await this.requestProvider(harness, {
        id: `questionnaire:read:${threadId}`,
        method: harness === "codex" ? "thread/turns/list" : "thread/read",
        params: harness === "codex"
          ? { cwd: project.rootPath, threadId, itemsView: "notLoaded", limit: 1, sortDirection: "desc" }
          : { cwd: project.rootPath, threadId, includeTurns: true },
      });
      if (response.error) throw new Error(response.error.message);
      const result = asRecord(response.result);
      const turns = harness === "codex" ? result?.data : asRecord(result?.thread)?.turns;
      if (!Array.isArray(turns)) throw new Error("Provider returned no turn metadata for questionnaire interruption.");
      const turn = harness === "codex" ? asRecord(turns[0]) : asRecord(turns.at(-1));
      if (turns.length && (!turn || typeof turn.id !== "string" || !turn.id
        || typeof turn.status !== "string" || !["inProgress", "completed", "interrupted", "failed"].includes(turn.status))) {
        throw new Error("Provider returned invalid turn metadata for questionnaire interruption.");
      }
      const active = turn?.status === "inProgress";
      if (!await isCurrent()) return false;
      const observed = await this.findPendingQuestionnaire(harness, threadId);
      const observedTurnId = getWorkbenchLifecycleTurnId(observed?.entry.lifecycle ?? null);
      const interrupt = async () => {
        if (!await isCurrent(observedTurnId)) return false;
        if (!active) return true;
        if (typeof turn?.id !== "string") throw new Error("The active provider turn has no identity.");
        await stopWorkbenchThread({
          harness, threadId, turnId: turn.id,
          sendRequest: async (targetHarness, request) => {
            if (!await isCurrent(observedTurnId)) throw new Error("The questionnaire or active work changed before interruption completed.");
            const response = await this.requestProvider(targetHarness, {
              ...request, id: `questionnaire:stop:${threadId}`,
              params: { ...request.params, cwd: project.rootPath },
            });
            if (response.error) throw new Error(response.error.message);
          },
        });
        return isCurrent(observedTurnId);
      };
      if (harness !== "codex") return await interrupt();
      if (!this.context.interruptRetainingQuestionnaire) throw new Error("Questionnaire interruption is unavailable.");
      const identity = await this.context.identities.threads.resolve({ harness, threadId: ThreadReferenceSchema.parse(threadId) });
      const binding = identity?.bindings.find(candidate => candidate.harness === harness);
      if (!binding) throw new Error("The questionnaire thread has no native execution.");
      return await this.context.interruptRetainingQuestionnaire(binding.nativeThreadId, questionnaire.requestKey, interrupt);
    } catch (error) {
      this.context.log?.("Questionnaire interruption failed; the saved question was retained.");
      throw error;
    }
  }

  async handleManagedThreadRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return this.handleNativeManagedThreadRequest(request);
  }

  private async handleNativeManagedThreadRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = asRecord(request.params) ?? {};
      if (request.method === "workbench/thread/status") {
        const status = params.status;
        if (status !== "completed" && status !== "blocked") throw new Error("Thread status must be completed or blocked.");
        const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
        const callerThreadId = typeof params.callerThreadId === "string" ? params.callerThreadId.trim() : "";
        if (!cwd || !callerThreadId) throw new Error("A managed Workbench thread identity and cwd are required.");
        const resolved = await this.context.resolveProjectFromCwd(cwd, { endpointName: "Workbench thread status" });
        const identity = await this.context.identities.threads.resolve({
          threadId: ThreadReferenceSchema.parse(callerThreadId), projectId: resolved.project.id,
        });
        if (!identity) throw new Error("The managed thread does not belong to this cwd project.");
        const entry = await this.controller.setAgentStatus(identity.projectId, identity.threadId, status);
        return { id, result: {
          agentStatus: entry.lifecycle.kind === "completed" ? "completed" : "blocked",
          revision: await this.controller.getRevision(identity.projectId),
          threadId: identity.threadId, turnId: getWorkbenchLifecycleTurnId(entry.lifecycle), userStatus: entry.lifecycle.kind,
        } };
      }
      const resolved = await this.resolveManagedThread(params);
      const needsTurn = request.method === "workbench/thread/resume";
      const turnId = needsTurn ? await this.resolveManagedTurn(resolved) : null;
      const providerEntry = normalizeProviderSidebarEntry(resolved.harness, resolved.thread, this.context.identities.threads);
      if (!providerEntry || providerEntry.entryKind === "draft") throw new Error("The managed provider thread could not be normalized.");
      await this.controller.ensureProviderEntry(resolved.projectId, providerEntry);
      if (request.method === "workbench/thread/title") {
        const providerTitle = resolveWorkbenchThreadTitle({
          fallback: "",
          id: resolved.thread.id,
          name: resolved.thread.name,
          preview: null,
        });
        if (params.action === "get") {
          return {
            id,
            result: {
              harness: resolved.harness,
              threadId: resolved.thread.id,
              title: providerTitle,
            },
          };
        }
        if (params.action !== "set") throw new Error("A thread title action is required.");
        const title = normalizeThreadTitle(typeof params.title === "string" ? params.title : null);
        if (!title) throw new Error("--title requires non-empty text.");
        if (params.currentTitle !== undefined && typeof params.currentTitle !== "string") {
          throw new Error("currentTitle must be exact non-empty text when supplied.");
        }
        const expectedCurrentTitle = typeof params.currentTitle === "string" ? params.currentTitle : null;
        if (expectedCurrentTitle !== (providerTitle || null)) {
          throw new Error(providerTitle
            ? `Thread title mismatch. Current title: ${JSON.stringify(providerTitle)}. Retry with currentTitle set to this exact text.`
            : "Thread title mismatch. No current title is set. Retry without currentTitle.");
        }
        await this.setProviderThreadTitle(resolved.harness, resolved.thread.id, title, resolved.cwd);
        await this.controller.setTitle(resolved.projectId, resolved.harness, resolved.thread.id, title);
        return { id, result: { harness: resolved.harness, threadId: resolved.thread.id, title } };
      }
      if (request.method === "workbench/thread/resume") {
        if (!turnId) throw new Error("The managed thread has no current turn to resume.");
        const native = this.context.identities
          ? await mapWorkbenchProviderRequest(this.context.identities.threads, resolved.harness, {
            method: "thread/resume", params: { threadId: resolved.thread.id },
          })
          : { harness: resolved.harness, request: { params: { threadId: resolved.thread.id } } };
        const nativeThreadId = asRecord(native.request.params)?.threadId;
        if (typeof nativeThreadId !== "string") throw new Error("The managed thread has no provider binding.");
        await this.context.harnesses.resumeThread(native.harness, NativeThreadIdSchema.parse(nativeThreadId));
        return { id, result: { accepted: true, threadId: resolved.thread.id, turnId } };
      }
      throw new Error("Unsupported managed thread command.");
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Managed thread command failed." } };
    }
  }

  async dispose() { await this.controller.dispose(); }

  private async providerProfileTarget(harness: WorkbenchHarness, thread: ThreadReadResponse["thread"]) {
    if (!thread.id || !thread.cwd) throw new Error("Profile preparation requires a provider thread and cwd.");
    const resolved = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Thread profile preparation" });
    const canonical = await this.admitThread(harness, thread);
    const entry = normalizeProviderSidebarEntry(harness, canonical, this.context.identities.threads);
    if (!entry || entry.entryKind === "draft") throw new Error("The managed thread could not be normalized.");
    await this.controller.ensureProviderEntry(resolved.project.id, entry);
    return {
      cwd: resolved.cwd, projectId: resolved.project.id,
      slot: { kind: "thread" as const, harness, projectId: resolved.project.id, threadId: canonical.id },
    };
  }

  async prepareCodexProfile(thread: ThreadReadResponse["thread"]) {
    const target = await this.providerProfileTarget("codex", thread);
    const profile = await this.controller.prepareComposerProfileTarget(target.slot);
    return { ...profile, cwd: target.cwd, projectId: target.projectId };
  }

  async readProviderProfile(harness: WorkbenchHarness, thread: ThreadReadResponse["thread"]) {
    const target = await this.providerProfileTarget(harness, thread);
    const selection = await this.controller.readComposerProfileSnapshot(target.slot);
    if (!selection) throw new Error("The thread has no available daemon composer profile.");
    const entry = await this.controller.getThreadEntry(target.projectId, harness, target.slot.threadId);
    return { selection, subagentName: entry?.entryKind === "subagent" ? entry.name : null, cwd: target.cwd, projectId: target.projectId };
  }

  async captureCreationProfile(harness: WorkbenchHarness, cwd: string, source: WorkbenchThreadCreationProfile) {
    const resolved = await this.context.resolveProjectFromCwd(cwd, { endpointName: "Thread profile creation" });
    if (source.kind === "target" && source.slot.projectId !== resolved.project.id) {
      throw new Error("The creation profile target belongs to another project.");
    }
    const selection = source.kind === "snapshot" ? source.selection
      : (await this.controller.prepareComposerProfileTarget(source.slot)).selection;
    if (selection.settings.harness !== harness) throw new Error("The creation profile harness does not match the thread.");
    return { selection, cwd: resolved.cwd, projectId: resolved.project.id };
  }

  async installCreatedProfile(harness: WorkbenchHarness, thread: ThreadReadResponse["thread"], selection: WorkbenchComposerProfileTargetSelection) {
    const target = await this.providerProfileTarget(harness, thread);
    if (!await this.controller.setComposerProfileTarget(target.slot, selection)) {
      throw new Error("The created thread's exact profile could not be installed.");
    }
  }

  async withProviderProfileAdmission<Result>(
    harness: WorkbenchHarness,
    thread: ThreadReadResponse["thread"],
    admit: (profile: { selection: WorkbenchComposerProfileTargetSelection; subagentName: string | null; cwd: string; projectId: ProjectId }) => Promise<{ accepted: boolean; result: Result }>,
    signal: AbortSignal,
    refresh = true,
  ) {
    const target = await this.providerProfileTarget(harness, thread);
    signal.throwIfAborted();
    return this.controller.withComposerProfileAdmission(target.slot, (profile) => admit({
      ...profile, cwd: target.cwd, projectId: target.projectId,
    }), signal, refresh);
  }

  async getCodexMcpState(
    threadId: NativeThreadId,
    requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse> = (request) => (
      this.context.harnesses.request("codex", request)
    ),
  ) {
    const response = await requestProvider({ id: 0, method: "thread/read", params: { includeTurns: false, threadId } });
    if (response.error) throw new Error(response.error.message);
    const thread = (response.result as ThreadReadResponse | undefined)?.thread;
    if (!thread || thread.id !== threadId) throw new Error("The managed Codex thread could not be read before turn admission.");
    const project = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex MCP freshness" });
    const canonical = await this.admitThread("codex", thread);
    const providerEntry = normalizeProviderSidebarEntry("codex", canonical, this.context.identities.threads);
    if (!providerEntry || providerEntry.entryKind === "draft") throw new Error("The managed Codex thread could not be normalized.");
    await this.controller.ensureProviderEntry(project.project.id, providerEntry);
    return {
      generation: await this.controller.getMcpGeneration(project.project.id, "codex", canonical.id),
      projectId: project.project.id,
    };
  }

  async setManagedCodexMcpGeneration(projectId: ProjectId, threadId: NativeThreadId, generation: string) {
    const identity = await this.context.identities.threads.resolve({ threadId, harness: "codex", projectId });
    if (!identity) throw new Error("Managed Codex identity is unavailable.");
    await this.controller.setMcpGeneration(projectId, "codex", identity.threadId, generation);
  }

  async installSubagentRelationship(relationship: WorkbenchSubagentRelationship) {
    const project = await this.context.resolveProjectById(relationship.projectId);
    const response = await this.requestProvider(relationship.harness, {
      id: `thread-state:subagent:${relationship.threadId}`,
      method: "thread/read",
      params: { cwd: relationship.cwd, includeTurns: false, threadId: relationship.threadId },
      ...(relationship.harness === "codex" ? { workbenchRequestSource: "autoRefresh" } : {}),
    });
    if (response.error) throw new Error(response.error.message);
    const thread = (response.result as ThreadReadResponse | undefined)?.thread;
    if (!thread || thread.id !== relationship.threadId) throw new Error("The committed subagent thread could not be read for lifecycle projection.");
    const providerEntry = normalizeProviderSidebarEntry(relationship.harness, thread, this.context.identities.threads);
    if (!providerEntry || providerEntry.entryKind === "draft") throw new Error("The committed subagent thread could not be normalized for lifecycle projection.");
    const projected = this.projectProviderEntries(
      relationship.projectId,
      relationship.harness,
      [providerEntry],
      { subagents: [relationship] },
    ).find((entry) => entry.entryKind === "subagent" && entry.identity.threadId === relationship.threadId);
    if (!projected || projected.entryKind !== "subagent") throw new Error("The committed subagent relationship could not be projected into thread state.");
    await this.context.transitions.run(project.rootPath, async () => {
      await this.controller.ensureProviderEntry(relationship.projectId, projected);
    });
  }

  private async reconcileProject(
    projectId: ProjectId,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarness, entries: WorkbenchObservedThreadEntry[], options: { complete: boolean }) => Promise<void>,
    acceptGitArcSnapshot: (snapshot: WorkbenchThreadGitArcSnapshot) => Promise<void>,
  ) {
    const project = await this.context.resolveProjectById(projectId);
    const readGitArcSnapshot = async (): Promise<WorkbenchThreadGitArcSnapshot> => {
      const [gitArcs, gitArcPlans] = await Promise.all([
        this.context.gitArcs.listLifecycleStates
          ? this.context.gitArcs.listLifecycleStates(project.rootPath)
          : this.context.gitArcs.listActiveClaims(project.rootPath).then((claims) => claims.map(legacyGitArc)),
        this.context.gitArcs.listPlanStates?.(project.rootPath) ?? Promise.resolve([]),
      ]);
      return {
        arcs: gitArcs.map((state) => ({
          harness: state.harness as WorkbenchHarness,
          state: projectGitArc(state)!,
          threadId: state.threadId,
        })),
        plans: gitArcPlans.map((state) => ({
          harness: state.harness as WorkbenchHarness,
          state: projectGitArcPlan(state)!,
          threadId: state.threadId,
        })),
      };
    };
    await this.context.transitions.run(project.rootPath, async () => {
      await acceptGitArcSnapshot(await readGitArcSnapshot());
    });
    const results = await Promise.all(this.context.harnesses.listHarnesses().map(async (harness): Promise<
      | { entries: WorkbenchObservedThreadEntry[]; harness: WorkbenchHarness }
      | { failure: WorkbenchThreadReconciliationFailure }
    > => {
      try {
        const providerEntries = await this.listProviderEntries(harness, project.rootPath, signal, async (entries) => {
          const relationships = await this.context.listSubagents(projectId);
          await acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, entries, relationships), { complete: false });
        });
        return { entries: providerEntries, harness };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new Error("Thread-state reconciliation cancelled.");
        return { failure: { harness, message: error instanceof Error ? error.message : String(error) } };
      }
    }));
    const completed = results.filter((result): result is Extract<typeof result, { entries: WorkbenchObservedThreadEntry[] }> => "entries" in result);
    await this.context.transitions.run(project.rootPath, async () => {
      const relationships = await this.context.listSubagents(projectId);
      for (const { entries, harness } of completed) {
        await acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, entries, relationships), { complete: true });
      }
      await acceptGitArcSnapshot(await readGitArcSnapshot());
    });
    return results.flatMap((result) => "failure" in result ? [result.failure] : []);
  }

  private async listProviderEntries(
    harness: WorkbenchHarness,
    rootPath: string,
    signal: AbortSignal,
    acceptFirstPage: (entries: WorkbenchObservedThreadEntry[]) => Promise<void>,
  ) {
    const entries: WorkbenchObservedThreadEntry[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      if (signal.aborted) throw signal.reason ?? new Error("Thread-state reconciliation cancelled.");
      const request = {
        id: `thread-state:${harness}`,
        method: "thread/list",
        params: {
          archived: false,
          cwd: rootPath,
          cursor,
          limit: 50,
          ...(harness === "codex" ? { sortDirection: "desc", sortKey: "updated_at", useStateDbOnly: true } : {}),
        },
        ...(harness === "codex" ? { workbenchRequestSource: "autoRefresh" } : {}),
      } satisfies JsonRpcRequest;
      const response = page === 0
        ? await this.requestProvider(harness, request)
        : await this.enqueuePagination(() => this.requestProvider(harness, request));
      if (response.error) throw new Error(response.error.message);
      const result = asRecord(response.result);
      for (const candidate of Array.isArray(result?.data) ? result.data : []) {
        const entry = normalizeProviderSidebarEntry(harness, candidate, this.context.identities.threads);
        if (entry) entries.push(entry);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (page === 0 && cursor) await acceptFirstPage(entries);
      page += 1;
    } while (cursor);
    return entries;
  }

  private async enqueuePagination<TValue>(operation: () => Promise<TValue>) {
    const next = this.paginationQueue.catch(() => undefined).then(operation);
    this.paginationQueue = next.catch(() => undefined);
    return await next;
  }

  private projectProviderEntries(
    projectId: ProjectId,
    harness: WorkbenchHarness,
    providerEntries: WorkbenchObservedThreadEntry[],
    relationships: SubagentRelationshipList,
  ) {
    const harnessRelationships = relationships.subagents.filter((relationship) => relationship.harness === harness);
    const relationshipKeys = new Set(harnessRelationships.map((relationship) => relationship.threadId));
    // Provider lists may ignore cwd filters. Admission, not the requested filter,
    // establishes which project may receive each row.
    const scopedEntries = providerEntries.filter(entry => entry.entryKind === "draft"
      ? entry.draft.projectId === projectId
      : this.context.identities.threads.knownThread(entry.identity.threadId).projectId === projectId);
    const topLevelEntries = scopedEntries
      .filter((entry) => entry.entryKind !== "thread" || !relationshipKeys.has(entry.identity.threadId));
    const providerById = new Map(scopedEntries.filter((entry): entry is Extract<WorkbenchObservedThreadEntry, { entryKind: "thread" }> => entry.entryKind === "thread").map((entry) => [entry.identity.threadId, entry]));
    return [...topLevelEntries, ...harnessRelationships.map((relationship): WorkbenchObservedThreadEntry => {
      const provider = providerById.get(relationship.threadId);
      const lifecycle = normalizeSubagentProviderLifecycle(provider?.lifecycle);
      return {
        activityAt: provider?.activityAt ?? relationship.updatedAt, createdAt: relationship.createdAt, cwd: relationship.cwd,
        directSubagentIndex: relationship.directSubagentIndex, entryKind: "subagent", identity: { harness, threadId: relationship.threadId },
        lifecycle, name: relationship.name,
        parentThreadId: relationship.parentThreadId, pinned: false, profileId: relationship.profileId, profileName: relationship.profileName,
        projectId, title: relationship.title, namedTitle: relationship.title, updatedAt: relationship.updatedAt,
      };
    })];
  }

  private async resolveManagedTurn(resolved: { cwd: string; harness: WorkbenchHarness; projectId: ProjectId; thread: ThreadReadResponse["thread"] & { id: WorkbenchThreadId } }) {
    if (resolved.harness === "codex") {
      const response = await this.requestProvider("codex", {
        id: 0, method: "thread/turns/list",
        params: { cwd: resolved.cwd, threadId: resolved.thread.id, itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
      });
      if (response.error) throw new Error(response.error.message);
      const data = asRecord(response.result)?.data;
      const turn = Array.isArray(data) ? asRecord(data[0]) : null;
      return typeof turn?.id === "string"
        ? this.context.identities.threads.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId : null;
    }
    const turn = getCurrentTurn(resolved.thread);
    if (turn) return this.context.identities.threads.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId;
    const context = await this.controller.getThreadClaimContext(resolved.projectId, resolved.harness, resolved.thread.id);
    return getWorkbenchLifecycleTurnId(context?.lifecycle ?? null);
  }

  private async resolveManagedThread(params: Record<string, unknown>) {
    const callerThreadId = typeof params.callerThreadId === "string" ? params.callerThreadId.trim() : "";
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (!callerThreadId || !cwd) throw new Error("A managed Workbench thread identity and cwd are required.");
    const requestedProject = await this.context.resolveProjectFromCwd(cwd, { endpointName: "Workbench managed thread" });
    const identity = await this.context.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse(callerThreadId), projectId: requestedProject.project.id });
    if (!identity?.bindings.length) throw new Error("The managed thread has no admitted native execution.");
    const harness = WorkbenchHarnessSchema.parse(identity.bindings[0].harness);
    const threadId = identity.threadId;
    const response = await this.requestProvider(harness, { id: 0, method: "thread/read", params: { cwd, includeTurns: false, threadId } });
    if (response.error) throw new Error(response.error.message);
    const thread = (response.result as ThreadReadResponse | undefined)?.thread;
    if (!thread || thread.id !== threadId) throw new Error("The managed thread metadata returned a different identity.");
    const actualProject = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Workbench managed thread" });
    if (actualProject.project.id === requestedProject.project.id) return { cwd, harness, projectId: requestedProject.project.id, thread: { ...thread, id: threadId } };
    throw new Error("The managed thread does not belong to this cwd project.");
  }
}
