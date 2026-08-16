/*
 * Exports:
 * - WorkbenchThreadStateFeatureContext: stable ports required by the reloadable sidebar/lifecycle owner. Keywords: dependency injection, thread state.
 * - normalizeProviderSidebarEntry/normalizeSubagentProviderLifecycle/mapProviderLifecycleNotification: normalize provider rows, subagent defaults, and pushed lifecycle notifications. Keywords: timestamp, lifecycle, harness.
 * - default WorkbenchThreadStateFeature: own reconciliation, managed status commands, notification observation, and the current controller. Keywords: sidebar, lifecycle, reloadable feature.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import { getCurrentTurn } from "../lib/codex/thread-state";
import { normalizeThreadTitle } from "../lib/thread-bootstrap";
import type { WorkbenchHarness } from "../lib/types";
import { normalizeWorkbenchActivityTimestampMs, type WorkbenchThreadLifecycle, type WorkbenchThreadSidebarEntry, type WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import type { HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchThreadStateController, { type WorkbenchObservedLifecycleEvent } from "./WorkbenchThreadStateController";

interface ProjectRecord { id: string; rootPath: string }
interface ProjectResolution { cwd: string; project: ProjectRecord }
interface SubagentRelationshipList { subagents: Array<{ createdAt: number; cwd: string; directSubagentIndex: number; harness: WorkbenchHarness; name: string; parentThreadId: string; profileId: string; profileName: string; projectId: string; threadId: string; title: string; updatedAt: number }> }

export interface WorkbenchThreadStateFeatureContext {
  listSubagents(projectId: string): Promise<SubagentRelationshipList>;
  publish(connectionId: string, snapshot: WorkbenchThreadStateSnapshot): void;
  requestHarness(harness: HarnessKind, request: JsonRpcRequest): Promise<JsonRpcResponse>;
  resolveProjectById(projectId: string): Promise<ProjectRecord>;
  resolveProjectFromCwd(cwd: string, options?: { endpointName?: string }): Promise<ProjectResolution>;
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
    title: typeof record.name === "string" && record.name.trim() ? record.name : typeof record.preview === "string" && record.preview.trim() ? record.preview : threadId,
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

export default class WorkbenchThreadStateFeature {
  readonly controller: WorkbenchThreadStateController;

  constructor(private readonly context: WorkbenchThreadStateFeatureContext) {
    this.controller = new WorkbenchThreadStateController({
      publish: context.publish,
      reconcileProject: (projectId, signal) => this.reconcileProject(projectId, signal),
      resolveProjectRoot: async (projectId) => (await context.resolveProjectById(projectId)).rootPath,
    });
  }

  async observeProviderNotification(harness: HarnessKind, notification: JsonRpcNotification) {
    const mapped = mapProviderLifecycleNotification(notification);
    if (mapped) await this.controller.observeLifecycle(harness, mapped.threadId, mapped.event);
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

  private async reconcileProject(projectId: string, signal: AbortSignal) {
    const project = await this.context.resolveProjectById(projectId);
    const providerEntries: WorkbenchThreadSidebarEntry[] = [];
    for (const harness of ["codex", "copilot", "opencode"] as const) {
      let cursor: string | null = null;
      do {
        if (signal.aborted) throw signal.reason ?? new Error("Thread-state reconciliation cancelled.");
        const response = await this.context.requestHarness(harness, { id: `thread-state:${harness}`, method: "thread/list", params: { archived: false, cwd: project.rootPath, cursor, limit: 50 } });
        if (response.error) throw new Error(response.error.message);
        const result = asRecord(response.result);
        for (const candidate of Array.isArray(result?.data) ? result.data : []) {
          const entry = normalizeProviderSidebarEntry(harness, candidate);
          if (entry) providerEntries.push(entry);
        }
        cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      } while (cursor);
    }
    const relationships = await this.context.listSubagents(projectId);
    const relationshipKeys = new Set(relationships.subagents.map((relationship) => `${relationship.harness}:${relationship.threadId}`));
    const topLevelEntries = providerEntries.filter((entry) => entry.entryKind !== "thread" || !relationshipKeys.has(`${entry.identity.harness}:${entry.identity.threadId}`));
    const providerByKey = new Map(providerEntries.filter((entry): entry is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => entry.entryKind === "thread").map((entry) => [`${entry.identity.harness}:${entry.identity.threadId}`, entry]));
    return [...topLevelEntries, ...relationships.subagents.map((relationship): WorkbenchThreadSidebarEntry => {
      const provider = providerByKey.get(`${relationship.harness}:${relationship.threadId}`);
      return {
        activityAt: provider?.activityAt ?? relationship.updatedAt, createdAt: relationship.createdAt, cwd: relationship.cwd,
        directSubagentIndex: relationship.directSubagentIndex, entryKind: "subagent", identity: { harness: relationship.harness, threadId: relationship.threadId },
        lifecycle: normalizeSubagentProviderLifecycle(provider?.lifecycle), name: relationship.name,
        parentThreadId: relationship.parentThreadId, pinned: false, profileId: relationship.profileId, profileName: relationship.profileName,
        projectId: relationship.projectId, title: relationship.title, updatedAt: relationship.updatedAt,
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
