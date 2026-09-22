/*
 * Exports:
 * - WorkbenchThreadStateFeatureContext: stable database, sidebar, lifecycle, Git retention, and shared project-observation ports.
 * - WorkbenchProviderLifecycleObservation: provider event plus its persisted lifecycle result.
 * - normalizeProviderSidebarEntry: normalize provider sidebar rows.
 * - normalizeSubagentProviderLifecycle: resolve subagent lifecycle defaults.
 * - default WorkbenchThreadStateFeature: own reconciliation, project observation, SQLite state, workbench-owned titles, thread-owned status commands, and provider notifications.
 */
import { normalizeThreadTitle } from "./lib/thread-bootstrap";
import type { ThreadPayload, WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection, WorkbenchHarness, WorkbenchProjectsPayload, WorkbenchSubagentRelationship, WorkbenchThreadCreationProfile } from "workbench-shared/types";
import type { GitArcLifecycleState as RepoGitArcLifecycleState, GitArcPlanState as RepoGitArcPlanState } from "./lib/workbench/git/WorkbenchGitCheckpointController";
import type { WorkbenchProjectStateRequest, WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import { getWorkbenchLifecycleTurnId, normalizeWorkbenchTimestampMs, resolveWorkbenchThreadTitle, WorkbenchGitArcLifecycleStateSchema, type WorkbenchDurableQuestionnaire, type WorkbenchThreadLifecycle, type WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { isWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-user-input-requests";
import { currentThreadTitleName } from "workbench-shared/workbench/thread/thread-title-history";
import type { HarnessKind, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";
import WorkbenchThreadStateController, { type WorkbenchObservedLifecycleEvent, type WorkbenchObservedThreadEntry, type WorkbenchThreadGitArcSnapshot, type WorkbenchThreadReconciliationFailure } from "./WorkbenchThreadStateController";
import WorkbenchThreadStateStore, {
  type WorkbenchThreadStateStoreDatabase,
} from "./WorkbenchThreadStateStore";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchGitArcActiveClaim } from "./WorkbenchGitArcFeature";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { ThreadReferenceSchema, TurnReferenceSchema, type ProjectId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type WorkbenchAgentContextController from "./WorkbenchAgentContextController";

interface ProjectRecord { id: ProjectId; rootPath: string }
interface ProjectResolution { cwd: string; project: ProjectRecord }
interface SubagentRelationshipList { subagents: WorkbenchSubagentRelationship[] }

type GitArcLifecycleState = Omit<RepoGitArcLifecycleState, "threadId"> & { threadId: WorkbenchThreadId };
type GitArcPlanState = Omit<RepoGitArcPlanState, "threadId"> & { threadId: WorkbenchThreadId };

function projectGitArc(state: GitArcLifecycleState | RepoGitArcLifecycleState | undefined) {
  if (!state) return null;
  const { harness: _harness, reloadScopes: _reloadScopes, threadId: _threadId, ...gitArc } = state as typeof state & { reloadScopes?: unknown };
  return WorkbenchGitArcLifecycleStateSchema.parse(gitArc);
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
  agentContext?: Pick<WorkbenchAgentContextController, "publish">;
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
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  listSubagents(projectId: ProjectId): Promise<SubagentRelationshipList>;
  log?: (message: string) => void;
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
  const active = asRecord(record.status)?.type === "active" || record.status === "active"
    || typeof record.status === "string" && record.status.startsWith("active:");
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
  // Provider rows are display labels only; explicit titles are workbench-owned.
  return {
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

export interface WorkbenchProviderLifecycleObservation {
  event: WorkbenchObservedLifecycleEvent;
  lifecycle: WorkbenchThreadLifecycle | null;
  threadId: WorkbenchThreadId;
}

export default class WorkbenchThreadStateFeature {
  readonly controller: WorkbenchThreadStateController;
  private paginationQueue: Promise<unknown> = Promise.resolve();

  private provider(harness: WorkbenchHarness) {
    const key = installedProviderKeys.find(key => key === harness);
    if (!key) throw new Error(`Provider ${harness} is not installed.`);
    return this.context.providers.get(key);
  }

  constructor(private readonly context: WorkbenchThreadStateFeatureContext) {
    this.controller = new WorkbenchThreadStateController({
      resolveProjectId: projectId => this.canonicalProjectId(projectId),
      readComposerProfiles: context.readComposerProfiles,
      recordComposerProfileUsage: context.recordComposerProfileUsage,
      ...(context.reloadDirt ? {
        getReloadDirt: () => context.reloadDirt!.getSnapshot(),
        subscribeReloadDirt: (listener: () => void) => context.reloadDirt!.subscribe(listener),
      } : {}),
      log: context.log,
      publishAgentContext: async (harness, threadId, text) => {
        const key = installedProviderKeys.find(key => key === harness);
        if (key) await context.agentContext?.publish({ harness: key, threadId }, text);
      },
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

  async observeProviderNotification(harness: HarnessKind, facts: WorkbenchProviderObservation) {
    const { projectId, lifecycle: mapped, displayLabel, activity } = facts;
    let observation: WorkbenchProviderLifecycleObservation | null = null;
    if (mapped) {
      const lifecycle = projectId
        ? await this.controller.observeLifecycleInProject(projectId, harness, mapped.threadId, mapped.event)
        : await this.controller.observeLifecycle(harness, mapped.threadId, mapped.event);
      observation = { ...mapped, lifecycle };
      if (mapped.event.kind !== "userInputDelivered") return observation;
    }
    if (displayLabel) {
      await this.controller.observeDisplayLabel(harness, displayLabel.threadId, displayLabel.label, projectId);
      return observation;
    }
    if (activity) await this.controller.observeActivity(harness, activity.threadId, activity.kind === "turnStarted" ? activity.startedAt : undefined, projectId);
    return observation;
  }

  private async setProviderThreadTitle(harness: WorkbenchHarness, threadId: string, title: string, cwd: string) {
    await this.provider(harness).threads.rename(threadId, title);
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
      const provider = this.provider(harness);
      const turn = await provider.threads.latestTurn(threadId);
      if (!await isCurrent()) return false;
      const observed = await this.findPendingQuestionnaire(harness, threadId);
      const observedTurnId = getWorkbenchLifecycleTurnId(observed?.entry.lifecycle ?? null);
      if (!provider.interactions) throw new Error("Questionnaire interruption is unavailable.");
      return await provider.interactions.interruptRetaining(
        { threadId, turnId: turn?.status === "inProgress" ? turn.id : null, requestKey: questionnaire.requestKey },
        () => isCurrent(observedTurnId),
      );
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
        // The explicit title is workbench state; provider rows only supply a display label.
        const canonical = await this.controller.getCanonicalThreadEntry(resolved.projectId, resolved.thread.id);
        const currentTitle = canonical && canonical.entryKind !== "draft"
          ? currentThreadTitleName(canonical.titleHistory ?? []) ?? ""
          : "";
        if (params.action === "get") {
          return {
            id,
            result: {
              harness: resolved.harness,
              threadId: resolved.thread.id,
              title: currentTitle,
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
        if (expectedCurrentTitle !== (currentTitle || null)) {
          throw new Error(currentTitle
            ? `Thread title mismatch. Current title: ${JSON.stringify(currentTitle)}. Retry with currentTitle set to this exact text.`
            : "Thread title mismatch. No current title is set. Retry without currentTitle.");
        }
        await this.setProviderThreadTitle(resolved.harness, resolved.thread.id, title, resolved.cwd);
        await this.controller.setTitle(resolved.projectId, resolved.harness, resolved.thread.id, title);
        return { id, result: { harness: resolved.harness, threadId: resolved.thread.id, title } };
      }
      if (request.method === "workbench/thread/resume") {
        if (!turnId) throw new Error("The managed thread has no current turn to resume.");
        const recovery = this.provider(resolved.harness).recovery;
        if (!recovery) throw new Error(`Managed refresh is unavailable for ${resolved.harness} threads.`);
        await recovery.refresh(resolved.thread.id);
        return { id, result: { accepted: true, threadId: resolved.thread.id, turnId } };
      }
      throw new Error("Unsupported managed thread command.");
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Managed thread command failed." } };
    }
  }

  async dispose() { await this.controller.dispose(); }

  private async providerProfileTarget(harness: WorkbenchHarness, thread: ThreadPayload) {
    if (!thread.id || !thread.cwd) throw new Error("Profile preparation requires a provider thread and cwd.");
    const resolved = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Thread profile preparation" });
    const canonical = this.context.identities.threads.knownThread(ThreadReferenceSchema.parse(thread.id));
    const entry = normalizeProviderSidebarEntry(harness, thread, this.context.identities.threads);
    if (!entry || entry.entryKind === "draft") throw new Error("The managed thread could not be normalized.");
    await this.controller.ensureProviderEntry(resolved.project.id, entry);
    return {
      cwd: resolved.cwd, projectId: resolved.project.id,
      slot: { kind: "thread" as const, harness, projectId: resolved.project.id, threadId: canonical.threadId },
    };
  }

  async prepareProviderProfile(thread: ThreadPayload) {
    const target = await this.providerProfileTarget(thread.harness, thread);
    const profile = await this.controller.prepareComposerProfileTarget(target.slot);
    return { ...profile, cwd: target.cwd, projectId: target.projectId };
  }

  async readProviderProfile(harness: WorkbenchHarness, thread: ThreadPayload) {
    const target = await this.providerProfileTarget(harness, thread);
    const selection = await this.controller.readComposerProfileSnapshot(target.slot);
    if (!selection) throw new Error("The thread has no available daemon composer profile.");
    const entry = await this.controller.getThreadEntry(target.projectId, harness, target.slot.threadId);
    return { selection, subagentName: entry?.entryKind === "subagent" ? entry.name : null, cwd: target.cwd, projectId: target.projectId };
  }

  async captureCreationProfile(harness: WorkbenchHarness | undefined, cwd: string, source: WorkbenchThreadCreationProfile) {
    const resolved = await this.context.resolveProjectFromCwd(cwd, { endpointName: "Thread profile creation" });
    if (source.kind === "target") source = { ...source, slot: { ...source.slot, projectId: this.canonicalProjectId(source.slot.projectId) } };
    if (source.kind === "target" && source.slot.projectId !== resolved.project.id) {
      throw new Error("The creation profile target belongs to another project.");
    }
    const selection = source.kind === "snapshot" ? source.selection
      : (await this.controller.prepareComposerProfileTarget(source.slot)).selection;
    if (harness !== undefined && selection.settings.harness !== harness) throw new Error("The creation profile harness does not match the thread.");
    return { selection, cwd: resolved.cwd, projectId: resolved.project.id };
  }

  private canonicalProjectId(projectId: ProjectId) {
    const catalog = this.context.getProjectCatalog();
    const id = catalog.aliases?.find(alias => alias.alias === projectId)?.projectId ?? projectId;
    if (!catalog.data.some(project => project.id === id) && !catalog.aliases?.some(alias => alias.projectId === id)) {
      throw new Error("Project ownership has not been admitted.");
    }
    return id;
  }

  async installCreatedProfile(harness: WorkbenchHarness, thread: ThreadPayload, selection: WorkbenchComposerProfileTargetSelection) {
    const target = await this.providerProfileTarget(harness, thread);
    if (!await this.controller.setComposerProfileTarget(target.slot, selection)) {
      throw new Error("The created thread's exact profile could not be installed.");
    }
  }

  async withProviderProfileAdmission<Result>(
    harness: WorkbenchHarness,
    thread: ThreadPayload,
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

  async getProviderMcpState(thread: ThreadPayload) {
    const target = await this.providerProfileTarget(thread.harness, thread);
    return {
      generation: await this.controller.getMcpGeneration(target.projectId, thread.harness, target.slot.threadId),
      projectId: target.projectId,
    };
  }

  async setProviderMcpGeneration(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId, generation: string) {
    await this.controller.setMcpGeneration(projectId, harness, threadId, generation);
  }

  async installSubagentRelationship(relationship: WorkbenchSubagentRelationship) {
    const project = await this.context.resolveProjectById(relationship.projectId);
    const thread = await this.provider(relationship.harness).threads.read(relationship.threadId, { background: true });
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
    const results = await Promise.all(installedProviderKeys.map(async (harness): Promise<
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
      const read = () => this.provider(harness).threads.list({ cwd: rootPath, cursor, limit: 50, archived: false, background: true });
      const result = page === 0 ? await read() : await this.enqueuePagination(read);
      for (const candidate of result.data) {
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
        projectId, title: relationship.title, workbenchTitle: relationship.title, updatedAt: relationship.updatedAt,
      };
    })];
  }

  private async resolveManagedTurn(resolved: { cwd: string; harness: WorkbenchHarness; projectId: ProjectId; thread: ThreadPayload }) {
    const turn = await this.provider(resolved.harness).threads.latestTurn(resolved.thread.id);
    if (turn) return this.context.identities.threads.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId;
    return null;
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
    const thread = await this.provider(harness).threads.read(threadId);
    if (thread.isDraft !== false || thread.id !== threadId) throw new Error("The managed thread metadata returned a different identity.");
    const actualProject = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Workbench managed thread" });
    if (actualProject.project.id === requestedProject.project.id) return { cwd, harness, projectId: requestedProject.project.id, thread };
    throw new Error("The managed thread does not belong to this cwd project.");
  }
}
