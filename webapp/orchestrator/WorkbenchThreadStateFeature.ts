/*
 * Exports:
 * - WorkbenchThreadStateFeatureContext: stable ports required by the reloadable sidebar, lifecycle, and shared project-observation owner. Keywords: dependency injection, thread state, project.
 * - normalizeProviderSidebarEntry/normalizeSubagentProviderLifecycle/mapProviderLifecycleNotification/mapProviderActivityNotification: normalize provider rows, subagent defaults, lifecycle, and activity notifications. Keywords: timestamp, lifecycle, harness.
 * - default WorkbenchThreadStateFeature: own reconciliation, project observation, managed status commands, notification observation, and the current controller. Keywords: sidebar, project, lifecycle, reloadable feature.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import { getCurrentTurn } from "../lib/codex/thread-state";
import { normalizeThreadTitle } from "../lib/thread-bootstrap";
import type { WorkbenchHarness, WorkbenchProjectsPayload } from "../lib/types";
import type { GitArcActiveClaim } from "../lib/workbench/git/WorkbenchGitCheckpointController";
import type { WorkbenchProjectStateRequest, WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import { normalizeWorkbenchActivityTimestampMs, resolveWorkbenchThreadTitle, type WorkbenchThreadLifecycle, type WorkbenchThreadSidebarEntry, type WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import type { HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchThreadStateController, { type WorkbenchObservedLifecycleEvent, type WorkbenchThreadReconciliationFailure } from "./WorkbenchThreadStateController";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

interface ProjectRecord { id: string; rootPath: string }
interface ProjectResolution { cwd: string; project: ProjectRecord }
interface SubagentRelationshipList { subagents: Array<{ createdAt: number; cwd: string; directSubagentIndex: number; harness: WorkbenchHarness; name: string; parentThreadId: string; profileId: string; profileName: string; projectId: string; threadId: string; title: string; updatedAt: number }> }

function projectFileClaim(claim: GitArcActiveClaim | undefined) {
  if (!claim) return null;
  const { harness: _harness, threadId: _threadId, ...fileClaim } = claim;
  return fileClaim;
}

export interface WorkbenchThreadStateFeatureContext {
  gitArcs: {
    findActiveClaim(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcActiveClaim | null>;
    listActiveClaims(cwd: string): Promise<GitArcActiveClaim[]>;
  };
  getProjectCatalog(): WorkbenchProjectsPayload;
  listSubagents(projectId: string): Promise<SubagentRelationshipList>;
  log?: (message: string) => void;
  projectState: {
    getCurrentUpdate(projectId: string): WorkbenchProjectStateUpdate | null;
    handleRequest(projectId: string, request: WorkbenchProjectStateRequest): Promise<unknown>;
    observe(projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void): () => void;
  };
  publish(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  requestHarness(harness: HarnessKind, request: JsonRpcRequest): Promise<JsonRpcResponse>;
  resolveProjectById(projectId: string): Promise<ProjectRecord>;
  resolveProjectFromCwd(cwd: string, options?: { endpointName?: string }): Promise<ProjectResolution>;
  storageRoot: string;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  const updatedAt = normalizeWorkbenchActivityTimestampMs(typeof record.updatedAt === "number" ? record.updatedAt : Date.now());
  return {
    activityAt: updatedAt, entryKind: "thread", identity: { harness, threadId },
    lifecycle: active
      ? { agent: { agentStatus: "working", ...(turnId ? { turnId } : {}) }, kind: "working", reason: "acceptedIntent", settled: false }
      : { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
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
    return requestKey ? { event: { kind: "pendingInput", requestKey, turnId }, threadId } : null;
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

export function mapProviderActivityNotification(notification: JsonRpcNotification) {
  if (notification.method !== "turn/started" && notification.method !== "item/started" && notification.method !== "item/completed") return null;
  const params = asRecord(notification.params);
  return typeof params?.threadId === "string" && params.threadId.trim() ? params.threadId : null;
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
      reconcileProject: (projectId, signal, acceptProviderSnapshot) => this.reconcileProject(projectId, signal, acceptProviderSnapshot),
      resolveFileClaim: async (projectId, harness, threadId) => {
        const project = await context.resolveProjectById(projectId);
        return projectFileClaim(await context.gitArcs.findActiveClaim(project.rootPath, harness, threadId));
      },
      resolveProjectRoot: async (projectId) => (await context.resolveProjectById(projectId)).rootPath,
      runFileClaimTransition: async (projectId, operation) => {
        const project = await context.resolveProjectById(projectId);
        return await context.transitions.run(`git-arc\0${project.rootPath.toLowerCase()}`, operation);
      },
      storageRoot: context.storageRoot,
    });
  }

  async observeProviderNotification(harness: HarnessKind, notification: JsonRpcNotification) {
    const mapped = mapProviderLifecycleNotification(notification);
    if (mapped) {
      await this.controller.observeLifecycle(harness, mapped.threadId, mapped.event);
      return;
    }
    if (notification.method === "thread/name/updated") {
      const params = asRecord(notification.params);
      const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
      const title = normalizeThreadTitle(typeof params?.name === "string" ? params.name : null);
      if (threadId && title) await this.controller.observeTitle(harness, threadId, title);
      return;
    }
    const activityThreadId = mapProviderActivityNotification(notification);
    if (activityThreadId) await this.controller.observeActivity(harness, activityThreadId);
  }

  async handleManagedThreadRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = asRecord(request.params) ?? {};
      const resolved = await this.resolveManagedThread(params);
      if (request.method === "workbench/thread/title") {
        const title = normalizeThreadTitle(typeof params.title === "string" ? params.title : null);
        if (!title) throw new Error("--title requires non-empty text.");
        const response = await this.context.requestHarness(resolved.harness, { id, method: "thread/name/set", params: { cwd: resolved.cwd, name: title, threadId: resolved.thread.id } });
        if (response.error) throw new Error(response.error.message);
        await this.controller.setTitle(resolved.projectId, resolved.harness, resolved.thread.id, title);
        return { id, result: { harness: resolved.harness, threadId: resolved.thread.id, title } };
      }
      if (request.method === "workbench/thread/status") {
        const status = params.status === "completed" || params.status === "blocked" ? params.status : null;
        if (!status) throw new Error("--status must be completed or blocked.");
        const turn = getCurrentTurn(resolved.thread);
        if (!turn?.id) throw new Error("The managed thread has no current turn to label.");
        const providerEntry = normalizeProviderSidebarEntry(resolved.harness, resolved.thread);
        const entry = await this.controller.applyLifecycle(resolved.projectId, resolved.harness, resolved.thread.id, { kind: "agentStatus", status, turnId: turn.id }, providerEntry ?? undefined);
        if (!entry || entry.entryKind !== "thread") throw new Error("The current managed lifecycle could not be updated.");
        const snapshot = await this.controller.getSnapshot(resolved.projectId);
        return { id, result: { agentStatus: status, revision: snapshot.revision, threadId: resolved.thread.id, turnId: turn.id, userStatus: entry.lifecycle.kind } };
      }
      throw new Error("Unsupported managed thread command.");
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Managed thread command failed." } };
    }
  }

  async dispose() { await this.controller.dispose(); }

  private async reconcileProject(
    projectId: string,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarness, entries: WorkbenchThreadSidebarEntry[], options: { complete: boolean }) => void,
  ) {
    const project = await this.context.resolveProjectById(projectId);
    const [relationships, fileClaims] = await Promise.all([
      this.context.listSubagents(projectId),
      this.context.gitArcs.listActiveClaims(project.rootPath),
    ]);
    const results = await Promise.all((["codex", "copilot", "opencode"] as const).map(async (harness): Promise<WorkbenchThreadReconciliationFailure | null> => {
      try {
        const providerEntries = await this.listProviderEntries(harness, project.rootPath, signal, (entries) => {
          acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, entries, relationships, fileClaims), { complete: false });
        });
        acceptProviderSnapshot(harness, this.projectProviderEntries(projectId, harness, providerEntries, relationships, fileClaims), { complete: true });
        return null;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new Error("Thread-state reconciliation cancelled.");
        return { harness, message: error instanceof Error ? error.message : String(error) };
      }
    }));
    return results.filter((failure): failure is WorkbenchThreadReconciliationFailure => Boolean(failure));
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
        ? await this.context.requestHarness(harness, request)
        : await this.enqueuePagination(() => this.context.requestHarness(harness, request));
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
    fileClaims: GitArcActiveClaim[],
  ) {
    const harnessRelationships = relationships.subagents.filter((relationship) => relationship.harness === harness);
    const relationshipKeys = new Set(harnessRelationships.map((relationship) => relationship.threadId));
    const topLevelEntries = providerEntries
      .filter((entry) => entry.entryKind !== "thread" || !relationshipKeys.has(entry.identity.threadId))
      .map((entry) => {
        if (entry.entryKind === "draft") return entry;
        const fileClaim = projectFileClaim(fileClaims.find((claim) => claim.harness === harness && claim.threadId === entry.identity.threadId));
        return {
          ...entry,
          fileClaim,
          lifecycle: fileClaim && entry.lifecycle.settled ? { ...entry.lifecycle, settled: false as const } : entry.lifecycle,
        };
      });
    const providerById = new Map(providerEntries.filter((entry): entry is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => entry.entryKind === "thread").map((entry) => [entry.identity.threadId, entry]));
    return [...topLevelEntries, ...harnessRelationships.map((relationship): WorkbenchThreadSidebarEntry => {
      const provider = providerById.get(relationship.threadId);
      const fileClaim = projectFileClaim(fileClaims.find((claim) => claim.harness === harness && claim.threadId === relationship.threadId));
      const lifecycle = normalizeSubagentProviderLifecycle(provider?.lifecycle);
      return {
        activityAt: provider?.activityAt ?? relationship.updatedAt, createdAt: relationship.createdAt, cwd: relationship.cwd,
        directSubagentIndex: relationship.directSubagentIndex, entryKind: "subagent", identity: { harness, threadId: relationship.threadId },
        fileClaim, lifecycle: fileClaim && lifecycle.settled ? { ...lifecycle, settled: false as const } : lifecycle, name: relationship.name,
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
    for (const harness of ["codex", "opencode", "copilot"] as const) {
      try {
        const response = await this.context.requestHarness(harness, { id: 0, method: "thread/read", params: { cwd, includeTurns: true, threadId: callerThreadId } });
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
