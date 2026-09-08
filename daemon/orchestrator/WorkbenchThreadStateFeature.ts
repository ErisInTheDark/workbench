/*
 * Keywords: provider, sidebar, explicit title, fallback, lifecycle, reconciliation, questionnaire interruption.
 * Exports:
 * - WorkbenchThreadStateFeatureContext: stable database, sidebar, lifecycle, Git retention, and shared project-observation ports. Keywords: dependency injection, thread state, retention, project, sqlite.
 * - WorkbenchProviderLifecycleObservation: provider event plus its persisted lifecycle result. Keywords: lifecycle, observation, persistence.
 * - normalizeProviderSidebarEntry/normalizeSubagentProviderLifecycle/mapProviderLifecycleNotification/mapProviderActivityNotification: normalize provider rows, subagent defaults, lifecycle, and activity notifications. Keywords: timestamp, lifecycle, harness.
 * - default WorkbenchThreadStateFeature: own reconciliation, project observation, SQLite store injection, provider-backed title and status commands, notification observation, and the current controller. Keywords: sidebar, project, lifecycle, title, sqlite, reloadable feature.
 */
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import { getCurrentTurn } from "workbench-shared/codex/thread-state";
import { normalizeThreadTitle } from "../lib/thread-bootstrap";
import type { WorkbenchComposerProfileStorePayload, WorkbenchHarness, WorkbenchProjectsPayload, WorkbenchSubagentRelationship } from "workbench-shared/types";
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
  type WorkbenchThreadStateShadowNotifier,
  type WorkbenchThreadStateStoreDatabase,
} from "./WorkbenchThreadStateStore";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchGitArcLifecycleState as GitArcLifecycleState, WorkbenchGitArcPlanState as GitArcPlanState } from "./WorkbenchGitArcFeature";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapNativeProviderResponse } from "./thread-identity-workbench-mapping";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";

interface ProjectRecord { id: string; rootPath: string }
interface ProjectResolution { cwd: string; project: ProjectRecord }
interface SubagentRelationshipList { subagents: WorkbenchSubagentRelationship[] }

function projectGitArc(state: GitArcLifecycleState | RepoGitArcLifecycleState | undefined) {
  if (!state) return null;
  const { harness: _harness, reloadScopes: _reloadScopes, threadId: _threadId, ...gitArc } = state as typeof state & { reloadScopes?: unknown };
  return gitArc;
}

function legacyGitArc(claim: GitArcActiveClaim): RepoGitArcLifecycleState {
  return {
    checkpointCommit: claim.checkpointCommit,
    claimedPaths: claim.claimedPaths,
    harness: claim.harness,
    intentDescription: claim.intentDescription,
    intentName: claim.intentName,
    phase: "active",
    proposals: claim.proposalId && (claim.proposalStatus === "proposed" || claim.proposalStatus === "committed")
      ? [{ proposalId: claim.proposalId, status: claim.proposalStatus }]
      : [],
    threadId: claim.threadId,
    updatedAt: claim.updatedAt,
  };
}

export interface WorkbenchThreadStateFeatureContext {
  identities?: NativeTranscriptIdentityOwners;
  readComposerProfiles?: () => Promise<WorkbenchComposerProfileStorePayload>;
  database: WorkbenchThreadStateStoreDatabase;
  gitArcs: {
    findActiveClaim(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcActiveClaim | null>;
    hasLiveClaims?(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<boolean>;
    findLifecycleState?(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcLifecycleState | RepoGitArcLifecycleState | null>;
    findPlanState?(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcPlanState | RepoGitArcPlanState | null>;
    listActiveClaims(cwd: string): Promise<GitArcActiveClaim[]>;
    listLifecycleStates?(cwd: string): Promise<Array<GitArcLifecycleState | RepoGitArcLifecycleState>>;
    listPlanStates?(cwd: string): Promise<Array<GitArcPlanState | RepoGitArcPlanState>>;
    pruneThreadHistories?(cwd: string, identities: ReadonlyArray<{ harness: WorkbenchHarness; threadId: string }>): Promise<unknown>;
  };
  getProjectCatalog(): WorkbenchProjectsPayload;
  harnesses: Pick<WorkbenchHarnessController, "listHarnesses" | "request" | "resumeThread">;
  listSubagents(projectId: string): Promise<SubagentRelationshipList>;
  log?: (message: string) => void;
  releaseQuestionnaire?: (threadId: string, requestKey: string) => Promise<void>;
  projectState: {
    getCurrentUpdate(projectId: string): WorkbenchProjectStateUpdate | null;
    handleRequest(projectId: string, request: WorkbenchProjectStateRequest): Promise<unknown>;
    observe(projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void): () => void;
  };
  reloadDirt?: Pick<WorkbenchReloadDirtController, "getSnapshot" | "subscribe">;
  publish(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  resolveProjectById(projectId: string): Promise<ProjectRecord>;
  resolveProjectFromCwd(cwd: string, options?: { endpointName?: string }): Promise<ProjectResolution>;
  shadow?: WorkbenchThreadStateShadowNotifier;
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

export function normalizeProviderSidebarEntry(harness: HarnessKind, value: unknown): WorkbenchObservedThreadEntry | null {
  const record = asRecord(value);
  const threadId = typeof record?.id === "string" ? record.id : null;
  if (!threadId) return null;
  const active = asRecord(record.status)?.type === "active" || record.status === "active";
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const activeTurn = [...turns].reverse().map(asRecord).find((turn) => turn?.status === "inProgress");
  const turnId = typeof record.currentTurnId === "string" && record.currentTurnId.trim()
    ? record.currentTurnId
    : typeof activeTurn?.id === "string" && activeTurn.id.trim() ? activeTurn.id : undefined;
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

export function mapProviderLifecycleNotification(notification: JsonRpcNotification): { event: WorkbenchObservedLifecycleEvent; threadId: string } | null {
  const params = asRecord(notification.params);
  const threadId = typeof params?.threadId === "string" && params.threadId.trim() ? params.threadId : null;
  if (!threadId) return null;
  if (notification.method === "item/started" || notification.method === "item/completed") {
    const item = asRecord(params.item);
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    return item?.type === "userMessage" && turnId
      ? { event: { kind: "userInputDelivered", turnId }, threadId }
      : null;
  }
  if (notification.method === "turn/started") {
    const turn = asRecord(params.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return turnId && items.some((item) => asRecord(item)?.type === "userMessage")
      ? { event: { kind: "userInputDelivered", turnId }, threadId }
      : null;
  }
  if (notification.method === "turn/completed") {
    const turn = asRecord(params.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    const status = turn?.status;
    return turnId && (status === "completed" || status === "interrupted" || status === "failed")
      ? { event: { kind: "turnCompleted", status, turnId }, threadId }
      : null;
  }
  if (notification.method === "questionnaire/requested") {
    const requestKey = typeof params.requestKey === "string" ? params.requestKey : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
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
  threadId: string;
}

export function mapProviderActivityNotification(notification: JsonRpcNotification):
  | { kind: "activity"; threadId: string }
  | { kind: "turnStarted"; startedAt: number | null; threadId: string }
  | null {
  if (notification.method !== "turn/started" && notification.method !== "item/started" && notification.method !== "item/completed") return null;
  const params = asRecord(notification.params);
  const threadId = typeof params?.threadId === "string" && params.threadId.trim() ? params.threadId : null;
  if (!threadId) return null;
  return notification.method === "turn/started"
    ? { kind: "turnStarted", startedAt: normalizeOptionalTimestamp(asRecord(params.turn)?.startedAt), threadId }
    : { kind: "activity", threadId };
}

export default class WorkbenchThreadStateFeature {
  readonly controller: WorkbenchThreadStateController;
  private paginationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: WorkbenchThreadStateFeatureContext) {
    this.controller = new WorkbenchThreadStateController({
      readComposerProfiles: context.readComposerProfiles,
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
      threadStateStore: new WorkbenchThreadStateStore(context.database, Date.now, context.shadow),
    });
  }

  async observeProviderNotification(harness: HarnessKind, notification: JsonRpcNotification) {
    const timeout = harness === "codex" ? getCodexQuestionnaireTimeout(notification) : null;
    if (timeout) {
      const pending = this.controller.findPendingSidebarQuestionnaire(harness, timeout.threadId);
      if (pending && pending.questionnaire.turnId === timeout.turnId) {
        await this.interruptQuestionnaire(pending.projectId, harness, timeout.threadId, pending.questionnaire);
      }
      return null;
    }
    const mapped = mapProviderLifecycleNotification(notification);
    let observation: WorkbenchProviderLifecycleObservation | null = null;
    if (mapped) {
      const lifecycle = await this.controller.observeLifecycle(harness, mapped.threadId, mapped.event);
      observation = { ...mapped, lifecycle };
      if (mapped.event.kind !== "userInputDelivered") return observation;
    }
    if (notification.method === "thread/name/updated") {
      const params = asRecord(notification.params);
      const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
      const title = normalizeThreadTitle(typeof params?.name === "string" ? params.name : null);
      if (threadId && title) await this.controller.observeTitle(harness, threadId, title);
      return observation;
    }
    const activity = mapProviderActivityNotification(notification);
    if (activity) await this.controller.observeActivity(harness, activity.threadId, activity.kind === "turnStarted" ? activity.startedAt : undefined);
    return observation;
  }

  private async setProviderThreadTitle(harness: WorkbenchHarness, threadId: string, title: string, cwd: string) {
    const response = await this.context.harnesses.request(harness, {
      id: `thread-state:title:${threadId}`,
      method: "thread/name/set",
      params: { cwd, name: title, threadId },
    });
    if (response.error) throw new Error(response.error.message);
  }

  private async interruptQuestionnaire(projectId: string, harness: WorkbenchHarness, threadId: string, questionnaire: WorkbenchDurableQuestionnaire) {
    const isCurrent = () => {
      const current = this.controller.findPendingSidebarQuestionnaire(harness, threadId);
      if (!current || current.projectId !== projectId || current.entry.lifecycle.kind === "working") return false;
      const turnId = getWorkbenchLifecycleTurnId(current.entry.lifecycle);
      return current.questionnaire.requestKey === questionnaire.requestKey
        && current.questionnaire.itemId === questionnaire.itemId
        && current.questionnaire.turnId === questionnaire.turnId
        && (turnId === null || turnId === questionnaire.turnId)
        && !isWorkbenchApprovalRequest(current.questionnaire.request);
    };
    if (!isCurrent()) return false;
    try {
      const project = await this.context.resolveProjectById(projectId);
      // Thread-state records and provider observations retain native IDs. Public
      // sidebar mutation IDs have already passed through the identity boundary.
      const response = await this.context.harnesses.request(harness, {
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
      if (!isCurrent() || (active && turn?.id !== questionnaire.turnId)) return false;
      if (harness === "codex") {
        if (!this.context.releaseQuestionnaire) throw new Error("Live questionnaire release is unavailable.");
        await this.context.releaseQuestionnaire(threadId, questionnaire.requestKey);
      }
      if (!isCurrent()) return false;
      if (!active) return true;
      if (!questionnaire.turnId) return false;
      await stopWorkbenchThread({
        harness, threadId, turnId: questionnaire.turnId,
        sendRequest: async (targetHarness, request) => {
          if (!isCurrent()) throw new Error("The questionnaire changed before interruption completed.");
          const response = await this.context.harnesses.request(targetHarness, {
            ...request, id: `questionnaire:stop:${threadId}`,
            params: { ...request.params, cwd: project.rootPath },
          });
          if (response.error) throw new Error(response.error.message);
        },
      });
      return isCurrent();
    } catch (error) {
      this.context.log?.("Questionnaire interruption failed; the saved question was retained.");
      throw error;
    }
  }

  async handleManagedThreadRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const response = await this.handleNativeManagedThreadRequest(request);
      if (response.error || !this.context.identities) return response;
      const result = asRecord(response.result);
      if (typeof result?.threadId !== "string") return response;
      const identity = await this.context.identities.threads.resolve({ threadId: result.threadId });
      const binding = identity?.bindings[0];
      if (!binding) return { id: request.id ?? null, error: { code: -32000, message: "Managed thread result has no admitted identity." } };
      return await mapNativeProviderResponse(this.context.identities, WorkbenchHarnessSchema.parse(binding.harness), {
        ...request, params: { threadId: binding.nativeThreadId },
      }, response);
    } catch (error) {
      return { id: request.id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : "Managed thread identity projection failed." } };
    }
  }

  private async handleNativeManagedThreadRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = asRecord(request.params) ?? {};
      const resolved = await this.resolveManagedThread(params);
      const needsTurn = request.method === "workbench/thread/status" || request.method === "workbench/thread/resume";
      const turnId = needsTurn ? await this.resolveManagedTurn(resolved) : null;
      const providerEntry = normalizeProviderSidebarEntry(resolved.harness, resolved.thread);
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
      if (request.method === "workbench/thread/status") {
        const status = params.status === "completed" || params.status === "blocked" ? params.status : null;
        if (!status) throw new Error("--status must be completed or blocked.");
        if (!turnId) throw new Error("The managed thread has no current turn to label.");
        const entry = await this.controller.applyLifecycle(resolved.projectId, resolved.harness, resolved.thread.id, { kind: "agentStatus", status, turnId }, providerEntry ?? undefined);
        if (!entry || entry.entryKind !== "thread") throw new Error("The current managed lifecycle could not be updated.");
        const snapshot = await this.controller.getSnapshot(resolved.projectId);
        return { id, result: { agentStatus: status, revision: snapshot.revision, threadId: resolved.thread.id, turnId, userStatus: entry.lifecycle.kind } };
      }
      if (request.method === "workbench/thread/resume") {
        if (!turnId) throw new Error("The managed thread has no current turn to resume.");
        await this.context.harnesses.resumeThread(resolved.harness, resolved.thread.id);
        return { id, result: { accepted: true, threadId: resolved.thread.id, turnId } };
      }
      throw new Error("Unsupported managed thread command.");
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Managed thread command failed." } };
    }
  }

  async dispose() { await this.controller.dispose(); }

  async prepareCodexProfile(thread: ThreadReadResponse["thread"]) {
    if (!thread.id || !thread.cwd) throw new Error("Codex profile preparation requires a provider thread and cwd.");
    const resolved = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex profile preparation" });
    const entry = normalizeProviderSidebarEntry("codex", thread);
    if (!entry || entry.entryKind === "draft") throw new Error("The managed Codex thread could not be normalized.");
    await this.controller.ensureProviderEntry(resolved.project.id, entry);
    const profile = await this.controller.prepareComposerProfileTarget({
      kind: "thread", harness: "codex", projectId: resolved.project.id, threadId: thread.id,
    });
    return { ...profile, cwd: resolved.cwd, projectId: resolved.project.id };
  }

  async getCodexMcpState(
    threadId: string,
    requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse> = (request) => (
      this.context.harnesses.request("codex", request)
    ),
  ) {
    const response = await requestProvider({ id: 0, method: "thread/read", params: { includeTurns: false, threadId } });
    if (response.error) throw new Error(response.error.message);
    const thread = (response.result as ThreadReadResponse | undefined)?.thread;
    if (!thread || thread.id !== threadId) throw new Error("The managed Codex thread could not be read before turn admission.");
    const project = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Codex MCP freshness" });
    const providerEntry = normalizeProviderSidebarEntry("codex", thread);
    if (!providerEntry || providerEntry.entryKind === "draft") throw new Error("The managed Codex thread could not be normalized.");
    await this.controller.ensureProviderEntry(project.project.id, providerEntry);
    return {
      generation: await this.controller.getMcpGeneration(project.project.id, "codex", threadId),
      projectId: project.project.id,
    };
  }

  async setManagedCodexMcpGeneration(projectId: string, threadId: string, generation: string) {
    await this.controller.setMcpGeneration(projectId, "codex", threadId, generation);
  }

  async installSubagentRelationship(relationship: WorkbenchSubagentRelationship) {
    const project = await this.context.resolveProjectById(relationship.projectId);
    const response = await this.context.harnesses.request(relationship.harness, {
      id: `thread-state:subagent:${relationship.threadId}`,
      method: "thread/read",
      params: { cwd: relationship.cwd, includeTurns: false, threadId: relationship.threadId },
      ...(relationship.harness === "codex" ? { workbenchRequestSource: "autoRefresh" } : {}),
    });
    if (response.error) throw new Error(response.error.message);
    const thread = (response.result as ThreadReadResponse | undefined)?.thread;
    if (!thread || thread.id !== relationship.threadId) throw new Error("The committed subagent thread could not be read for lifecycle projection.");
    const providerEntry = normalizeProviderSidebarEntry(relationship.harness, thread);
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
    projectId: string,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarness, entries: WorkbenchObservedThreadEntry[], options: { complete: boolean }) => void,
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
          acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, entries, relationships), { complete: false });
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
      completed.forEach(({ entries, harness }) => {
        acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, entries, relationships), { complete: true });
      });
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
        ? await this.context.harnesses.request(harness, request)
        : await this.enqueuePagination(() => this.context.harnesses.request(harness, request));
      if (response.error) throw new Error(response.error.message);
      const result = asRecord(response.result);
      for (const candidate of Array.isArray(result?.data) ? result.data : []) {
        const entry = normalizeProviderSidebarEntry(harness, candidate);
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
    projectId: string,
    harness: WorkbenchHarness,
    providerEntries: WorkbenchObservedThreadEntry[],
    relationships: SubagentRelationshipList,
  ) {
    const harnessRelationships = relationships.subagents.filter((relationship) => relationship.harness === harness);
    const relationshipKeys = new Set(harnessRelationships.map((relationship) => relationship.threadId));
    const topLevelEntries = providerEntries
      .filter((entry) => entry.entryKind !== "thread" || !relationshipKeys.has(entry.identity.threadId))
      .map((entry) => {
        if (entry.entryKind === "draft") return entry;
        return entry;
      });
    const providerById = new Map(providerEntries.filter((entry): entry is Extract<WorkbenchObservedThreadEntry, { entryKind: "thread" }> => entry.entryKind === "thread").map((entry) => [entry.identity.threadId, entry]));
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

  private async resolveManagedTurn(resolved: { cwd: string; harness: WorkbenchHarness; projectId: string; thread: ThreadReadResponse["thread"] }) {
    if (resolved.harness === "codex") {
      const response = await this.context.harnesses.request("codex", {
        id: 0, method: "thread/turns/list",
        params: { cwd: resolved.cwd, threadId: resolved.thread.id, itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
      });
      if (response.error) throw new Error(response.error.message);
      const data = asRecord(response.result)?.data;
      const turn = Array.isArray(data) ? asRecord(data[0]) : null;
      return typeof turn?.id === "string" ? turn.id : null;
    }
    const turn = getCurrentTurn(resolved.thread);
    if (turn) return turn.id;
    const context = await this.controller.getThreadClaimContext(resolved.projectId, resolved.harness, resolved.thread.id);
    return getWorkbenchLifecycleTurnId(context?.lifecycle ?? null);
  }

  private async resolveManagedThread(params: Record<string, unknown>) {
    const callerThreadId = typeof params.callerThreadId === "string" ? params.callerThreadId.trim() : "";
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (!callerThreadId || !cwd) throw new Error("A managed Workbench thread identity and cwd are required.");
    const requestedProject = await this.context.resolveProjectFromCwd(cwd, { endpointName: "Workbench managed thread" });
    const identity = await this.context.identities?.threads.resolve({ threadId: callerThreadId, projectId: requestedProject.project.id });
    const destinations = identity?.bindings.length
      ? [identity.bindings[0]!]
      : this.context.harnesses.listHarnesses().map((harness) => ({ harness, nativeThreadId: callerThreadId }));
    for (const destination of destinations) {
      const harness = WorkbenchHarnessSchema.parse(destination.harness);
      const threadId = destination.nativeThreadId;
      try {
        const response = await this.context.harnesses.request(harness, { id: 0, method: "thread/read", params: { cwd, includeTurns: false, threadId } });
        if (response.error) {
          if (identity) throw new Error(response.error.message);
          continue;
        }
        const thread = (response.result as ThreadReadResponse | undefined)?.thread;
        if (!thread || thread.id !== threadId) continue;
        const actualProject = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Workbench managed thread" });
        if (actualProject.project.id === requestedProject.project.id) return { cwd, harness, projectId: requestedProject.project.id, thread };
      } catch (error) {
        if (identity) throw error;
        this.context.log?.(`Managed thread metadata lookup failed for ${harness}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error("The managed thread does not belong to this cwd project.");
  }
}
