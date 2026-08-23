/*
 * Exports:
 * - WorkbenchThreadStateFeatureContext: stable ports required by the reloadable sidebar, lifecycle, and shared project-observation owner. Keywords: dependency injection, thread state, project.
 * - normalizeProviderSidebarEntry/normalizeSubagentProviderLifecycle/mapProviderLifecycleNotification/mapProviderActivityNotification: normalize provider rows, subagent defaults, lifecycle, and activity notifications. Keywords: timestamp, lifecycle, harness.
 * - default WorkbenchThreadStateFeature: own reconciliation, project observation, provider-backed title and status commands, notification observation, and the current controller. Keywords: sidebar, project, lifecycle, title, reloadable feature.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import { getCurrentTurn } from "../lib/codex/thread-state";
import { normalizeThreadTitle } from "../lib/thread-bootstrap";
import type { WorkbenchHarness, WorkbenchProjectsPayload } from "../lib/types";
import { normalizeOrchestratorReloadScopes } from "../lib/workbench/orchestrator-reload";
import type { GitArcActiveClaim, GitArcLifecycleState, GitArcPlanState } from "../lib/workbench/git/WorkbenchGitCheckpointController";
import type { WorkbenchProjectStateRequest, WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import { WorkbenchDurableQuestionnaireSchema, normalizeWorkbenchTimestampMs, resolveWorkbenchThreadTitle, type WorkbenchThreadLifecycle, type WorkbenchThreadSidebarEntry, type WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import type { HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import WorkbenchThreadStateController, { type WorkbenchObservedLifecycleEvent, type WorkbenchThreadGitArcSnapshot, type WorkbenchThreadReconciliationFailure } from "./WorkbenchThreadStateController";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

interface ProjectRecord { id: string; rootPath: string }
interface ProjectResolution { cwd: string; project: ProjectRecord }
interface SubagentRelationshipList { subagents: Array<{ createdAt: number; cwd: string; directSubagentIndex: number; harness: WorkbenchHarness; name: string; parentThreadId: string; profileId: string; profileName: string; projectId: string; threadId: string; title: string; updatedAt: number }> }

function projectGitArc(state: GitArcLifecycleState | undefined) {
  if (!state) return null;
  const { harness: _harness, threadId: _threadId, ...gitArc } = state;
  return { ...gitArc, reloadScopes: normalizeOrchestratorReloadScopes(state.reloadScopes) };
}

function legacyGitArc(claim: GitArcActiveClaim): GitArcLifecycleState {
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
    reloadScopes: normalizeOrchestratorReloadScopes(claim.reloadScopes),
    threadId: claim.threadId,
    updatedAt: claim.updatedAt,
  };
}

export interface WorkbenchThreadStateFeatureContext {
  gitArcs: {
    findActiveClaim(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcActiveClaim | null>;
    findLifecycleState?(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcLifecycleState | null>;
    findPlanState?(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcPlanState | null>;
    listActiveClaims(cwd: string): Promise<GitArcActiveClaim[]>;
    listLifecycleStates?(cwd: string): Promise<GitArcLifecycleState[]>;
    listPlanStates?(cwd: string): Promise<GitArcPlanState[]>;
  };
  getProjectCatalog(): WorkbenchProjectsPayload;
  harnesses: Pick<WorkbenchHarnessController, "listHarnesses" | "request" | "resumeThread">;
  listSubagents(projectId: string): Promise<SubagentRelationshipList>;
  log?: (message: string) => void;
  projectState: {
    getCurrentUpdate(projectId: string): WorkbenchProjectStateUpdate | null;
    handleRequest(projectId: string, request: WorkbenchProjectStateRequest): Promise<unknown>;
    observe(projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void): () => void;
  };
  publish(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  resolveProjectById(projectId: string): Promise<ProjectRecord>;
  resolveProjectFromCwd(cwd: string, options?: { endpointName?: string }): Promise<ProjectResolution>;
  storageRoot: string;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function projectGitArcPlan(state: GitArcPlanState | undefined) {
  if (!state) return null;
  const { harness: _harness, threadId: _threadId, ...gitArcPlan } = state;
  return { ...gitArcPlan, reloadScopes: normalizeOrchestratorReloadScopes(state.reloadScopes) };
}

function normalizeOptionalTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? normalizeWorkbenchTimestampMs(value)
    : null;
}

export function normalizeProviderSidebarEntry(harness: HarnessKind, value: unknown): WorkbenchThreadSidebarEntry | null {
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
      log: context.log,
      getProjectCatalog: context.getProjectCatalog,
      projectState: context.projectState,
      publish: context.publish,
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
      resolveProjectRoot: async (projectId) => (await context.resolveProjectById(projectId)).rootPath,
      runGitArcTransition: async (projectId, operation) => {
        const project = await context.resolveProjectById(projectId);
        return await context.transitions.run(project.rootPath, operation);
      },
      storageRoot: context.storageRoot,
    });
  }

  async observeProviderNotification(harness: HarnessKind, notification: JsonRpcNotification) {
    const mapped = mapProviderLifecycleNotification(notification);
    if (mapped) {
      await this.controller.observeLifecycle(harness, mapped.threadId, mapped.event);
      if (mapped.event.kind !== "userInputDelivered") return;
    }
    if (notification.method === "thread/name/updated") {
      const params = asRecord(notification.params);
      const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
      const title = normalizeThreadTitle(typeof params?.name === "string" ? params.name : null);
      if (threadId && title) await this.controller.observeTitle(harness, threadId, title);
      return;
    }
    const activity = mapProviderActivityNotification(notification);
    if (activity) await this.controller.observeActivity(harness, activity.threadId, activity.kind === "turnStarted" ? activity.startedAt : undefined);
  }

  private async setProviderThreadTitle(harness: WorkbenchHarness, threadId: string, title: string, cwd: string) {
    const response = await this.context.harnesses.request(harness, {
      id: `thread-state:title:${threadId}`,
      method: "thread/name/set",
      params: { cwd, name: title, threadId },
    });
    if (response.error) throw new Error(response.error.message);
  }

  async handleManagedThreadRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = asRecord(request.params) ?? {};
      const resolved = await this.resolveManagedThread(params);
      const providerEntry = normalizeProviderSidebarEntry(resolved.harness, resolved.thread);
      if (!providerEntry || providerEntry.entryKind === "draft") throw new Error("The managed provider thread could not be normalized.");
      await this.controller.ensureProviderEntry(resolved.projectId, providerEntry);
      if (request.method === "workbench/thread/title") {
        if (params.action === "get") {
          return {
            id,
            result: {
              harness: resolved.harness,
              threadId: resolved.thread.id,
              title: resolveWorkbenchThreadTitle({
                id: resolved.thread.id,
                name: resolved.thread.name,
                preview: resolved.thread.preview,
              }),
            },
          };
        }
        if (params.action !== "set") throw new Error("A thread title action is required.");
        const title = normalizeThreadTitle(typeof params.title === "string" ? params.title : null);
        if (!title) throw new Error("--title requires non-empty text.");
        await this.setProviderThreadTitle(resolved.harness, resolved.thread.id, title, resolved.cwd);
        await this.controller.setTitle(resolved.projectId, resolved.harness, resolved.thread.id, title);
        return { id, result: { harness: resolved.harness, threadId: resolved.thread.id, title } };
      }
      if (request.method === "workbench/thread/status") {
        const status = params.status === "completed" || params.status === "blocked" ? params.status : null;
        if (!status) throw new Error("--status must be completed or blocked.");
        const turn = getCurrentTurn(resolved.thread);
        if (!turn?.id) throw new Error("The managed thread has no current turn to label.");
        const entry = await this.controller.applyLifecycle(resolved.projectId, resolved.harness, resolved.thread.id, { kind: "agentStatus", status, turnId: turn.id }, providerEntry ?? undefined);
        if (!entry || entry.entryKind !== "thread") throw new Error("The current managed lifecycle could not be updated.");
        const snapshot = await this.controller.getSnapshot(resolved.projectId);
        return { id, result: { agentStatus: status, revision: snapshot.revision, threadId: resolved.thread.id, turnId: turn.id, userStatus: entry.lifecycle.kind } };
      }
      if (request.method === "workbench/thread/resume") {
        const turn = getCurrentTurn(resolved.thread);
        if (!turn?.id) throw new Error("The managed thread has no current turn to resume.");
        await this.context.harnesses.resumeThread(resolved.harness, resolved.thread.id);
        return { id, result: { accepted: true, threadId: resolved.thread.id, turnId: turn.id } };
      }
      throw new Error("Unsupported managed thread command.");
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Managed thread command failed." } };
    }
  }

  async dispose() { await this.controller.dispose(); }

  async getCodexMcpState(threadId: string) {
    const response = await this.context.harnesses.request("codex", { id: 0, method: "thread/read", params: { includeTurns: true, threadId } });
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

  private async reconcileProject(
    projectId: string,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarness, entries: WorkbenchThreadSidebarEntry[], options: { complete: boolean }) => void,
    acceptGitArcSnapshot: (snapshot: WorkbenchThreadGitArcSnapshot) => Promise<void>,
  ) {
    const project = await this.context.resolveProjectById(projectId);
    const relationships = await this.context.listSubagents(projectId);
    const readGitArcSnapshot = async (): Promise<WorkbenchThreadGitArcSnapshot> => {
      const [gitArcs, gitArcPlans] = await Promise.all([
        this.context.gitArcs.listLifecycleStates
          ? this.context.gitArcs.listLifecycleStates(project.rootPath)
          : this.context.gitArcs.listActiveClaims(project.rootPath).then((claims) => claims.map(legacyGitArc)),
        this.context.gitArcs.listPlanStates?.(project.rootPath) ?? Promise.resolve([]),
      ]);
      return {
        arcs: gitArcs.map(({ harness, threadId, ...state }) => ({ harness: harness as WorkbenchHarness, state, threadId })),
        plans: gitArcPlans.map(({ harness, threadId, ...state }) => ({ harness: harness as WorkbenchHarness, state, threadId })),
      };
    };
    await this.context.transitions.run(project.rootPath, async () => {
      await acceptGitArcSnapshot(await readGitArcSnapshot());
    });
    const results = await Promise.all(this.context.harnesses.listHarnesses().map(async (harness): Promise<
      | { entries: WorkbenchThreadSidebarEntry[]; harness: WorkbenchHarness }
      | { failure: WorkbenchThreadReconciliationFailure }
    > => {
      try {
        const providerEntries = await this.listProviderEntries(harness, project.rootPath, signal, (entries) => {
          acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, entries, relationships), { complete: false });
        });
        return { entries: providerEntries, harness };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new Error("Thread-state reconciliation cancelled.");
        return { failure: { harness, message: error instanceof Error ? error.message : String(error) } };
      }
    }));
    const completed = results.filter((result): result is Extract<typeof result, { entries: WorkbenchThreadSidebarEntry[] }> => "entries" in result);
    await this.context.transitions.run(project.rootPath, async () => {
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
    acceptFirstPage: (entries: WorkbenchThreadSidebarEntry[]) => void,
  ) {
    const entries: WorkbenchThreadSidebarEntry[] = [];
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
      if (page === 0 && cursor) acceptFirstPage(entries);
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
    providerEntries: WorkbenchThreadSidebarEntry[],
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
    const providerById = new Map(providerEntries.filter((entry): entry is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => entry.entryKind === "thread").map((entry) => [entry.identity.threadId, entry]));
    return [...topLevelEntries, ...harnessRelationships.map((relationship): WorkbenchThreadSidebarEntry => {
      const provider = providerById.get(relationship.threadId);
      const lifecycle = normalizeSubagentProviderLifecycle(provider?.lifecycle);
      return {
        activityAt: provider?.activityAt ?? relationship.updatedAt, createdAt: relationship.createdAt, cwd: relationship.cwd,
        directSubagentIndex: relationship.directSubagentIndex, entryKind: "subagent", identity: { harness, threadId: relationship.threadId },
        lifecycle, name: relationship.name,
        parentThreadId: relationship.parentThreadId, pinned: false, profileId: relationship.profileId, profileName: relationship.profileName,
        projectId, title: relationship.title, updatedAt: relationship.updatedAt,
      };
    })];
  }

  private async resolveManagedThread(params: Record<string, unknown>) {
    const callerThreadId = typeof params.callerThreadId === "string" ? params.callerThreadId.trim() : "";
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (!callerThreadId || !cwd) throw new Error("A managed Workbench thread identity and cwd are required.");
    const requestedProject = await this.context.resolveProjectFromCwd(cwd, { endpointName: "Workbench managed thread" });
    for (const harness of this.context.harnesses.listHarnesses()) {
      try {
        const response = await this.context.harnesses.request(harness, { id: 0, method: "thread/read", params: { cwd, includeTurns: true, threadId: callerThreadId } });
        if (response.error) continue;
        const thread = (response.result as ThreadReadResponse | undefined)?.thread;
        if (!thread || thread.id !== callerThreadId) continue;
        const actualProject = await this.context.resolveProjectFromCwd(thread.cwd, { endpointName: "Workbench managed thread" });
        if (actualProject.project.id === requestedProject.project.id) return { cwd, harness, projectId: requestedProject.project.id, thread };
      } catch { /* Try the next validated provider identity. */ }
    }
    throw new Error("The managed thread does not belong to this cwd project.");
  }
}
