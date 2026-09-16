/*
 * Exports:
 * - WorkbenchTurnRecoveryPort/WorkbenchTurnRecoveryResult: provider recovery boundary and terminal outcomes.
 * - WorkbenchTurnRecoveryControllerState: code-reload state for observed turns.
 * - WorkbenchObservedTurnCandidate: live provider request and turn context.
 * - WorkbenchUnfinishedTurnPort: admitted hidden continuation boundary.
 * - default WorkbenchTurnRecoveryController: own explicit refresh, unfinished continuation and generation drain.
 */

import type { WorkbenchHarness } from "workbench-shared/types";
import { createWorkbenchThreadRecoveryId, createWorkbenchUnfinishedTurnInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { JsonRpcNotification, JsonRpcRequest } from "./bridge-types";

export interface WorkbenchObservedTurnCandidate {
  goalOwned?: boolean;
  harness: WorkbenchHarness;
  key: string;
  request: JsonRpcRequest;
  recoveryId: string;
  resumeRequest?: JsonRpcRequest | null;
  threadId: string;
  turnId: string | null;
}

export type WorkbenchTurnRecoveryResult = "busy" | "completed" | "recovered";
export type WorkbenchTurnRecoveryPort = (candidate: WorkbenchObservedTurnCandidate, signal?: AbortSignal) => Promise<WorkbenchTurnRecoveryResult>;
export type WorkbenchUnfinishedTurnPort = (candidate: WorkbenchObservedTurnCandidate, request: JsonRpcRequest) => Promise<void>;

export interface WorkbenchTurnRecoveryControllerState {
  candidates: WorkbenchObservedTurnCandidate[];
  goalOwnedThreads: string[];
  resumeRequests: Array<[string, JsonRpcRequest]>;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function threadIdFrom(value: unknown) {
  const params = record(value);
  const turn = record(params?.turn);
  return typeof params?.threadId === "string" ? params.threadId : typeof turn?.threadId === "string" ? turn.threadId : null;
}

function createCodexTurnRecoveryResumeRequest(request: JsonRpcRequest, threadId: string): JsonRpcRequest {
  const params = record(request.params) ?? {};
  const { id: _id, method: _method, params: _params, ...extensions } = request;
  return {
    ...extensions,
    method: "thread/resume",
    params: {
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      ...(typeof params.model === "string" ? { model: params.model } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "serviceTier") ? { serviceTier: params.serviceTier } : {}),
      threadId,
    },
  };
}

export default class WorkbenchTurnRecoveryController {
  private readonly candidates = new Map<string, WorkbenchObservedTurnCandidate>();
  private readonly goalOwnedThreads = new Set<string>();
  private readonly recoveryTasks = new Map<Promise<void>, { label: string; signal: AbortSignal; startedAt: number }>();
  private readonly resumeRequests = new Map<string, JsonRpcRequest>();
  private acceptingRecovery = true;
  private recoveryGeneration = new AbortController();
  private readonly failureReports = new Set<Promise<void>>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly reportFailure: (candidate: WorkbenchObservedTurnCandidate, error: unknown) => Promise<void> = async () => undefined,
    state?: WorkbenchTurnRecoveryControllerState,
    private readonly recoveryPorts: Partial<Record<WorkbenchHarness, WorkbenchTurnRecoveryPort>> = {},
    private readonly runRecoveryTask: (label: string, task: () => Promise<void>) => Promise<void> = async (_label, task) => await task(),
  ) {
    for (const candidate of state?.candidates ?? []) this.candidates.set(candidate.key, structuredClone(candidate));
    for (const threadId of state?.goalOwnedThreads ?? []) this.goalOwnedThreads.add(threadId);
    for (const [threadId, request] of state?.resumeRequests ?? []) this.resumeRequests.set(threadId, structuredClone(request));
  }

  observeRequest(harness: WorkbenchHarness, request: JsonRpcRequest, now = Date.now()) {
    if (harness === "codex" && request.method === "workbench/codex/message/admit") {
      const params = record(request.params);
      const resumeRequest = record(params?.resumeRequest);
      const startRequest = record(params?.startRequest);
      if (resumeRequest?.method === "thread/resume") this.observeRequest(harness, resumeRequest as JsonRpcRequest, now);
      if (startRequest?.method === "turn/start") this.observeRequest(harness, startRequest as JsonRpcRequest, now);
      return;
    }
    const params = record(request.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (harness === "codex" && request.method === "thread/resume" && threadId) {
      this.resumeRequests.set(threadId, structuredClone(request));
      return;
    }
    if (harness === "codex" && request.method === "thread/goal/set" && threadId) {
      this.goalOwnedThreads.add(threadId);
      const candidate = this.candidates.get(`${harness}:${threadId}`);
      if (candidate) candidate.goalOwned = true;
    }
    if (harness === "codex" && request.method === "thread/goal/clear" && threadId) this.goalOwnedThreads.delete(threadId);
    if (request.method !== "turn/start" || !threadId) return;
    const key = `${harness}:${threadId}`;
    this.candidates.set(key, {
      goalOwned: this.goalOwnedThreads.has(threadId),
      harness,
      key,
      recoveryId: createWorkbenchThreadRecoveryId(`${harness}:${threadId}:${String(request.id ?? now)}`),
      request: structuredClone(request),
      resumeRequest: harness === "codex"
        ? structuredClone(this.resumeRequests.get(threadId) ?? createCodexTurnRecoveryResumeRequest(request, threadId))
        : null,
      threadId,
      turnId: null,
    });
    this.resumeRequests.delete(threadId);
  }

  observeNotification(harness: WorkbenchHarness, notification: JsonRpcNotification) {
    const params = record(notification.params);
    const threadId = threadIdFrom(notification.params);
    if (!threadId) return;
    const key = `${harness}:${threadId}`;
    const candidate = this.candidates.get(key);
    const turn = record(params?.turn);
    if (candidate) {
      if (notification.method === "turn/started" && typeof turn?.id === "string") candidate.turnId = turn.id;
    }
    if (
      notification.method === "turn/completed"
      && candidate
      && (!candidate.turnId || !turn?.id || candidate.turnId === turn.id)
      && turn?.status !== "completed"
    ) {
      this.candidates.delete(key);
    }
    if (harness === "codex" && notification.method === "thread/goal/cleared") this.goalOwnedThreads.delete(threadId);
    if (harness === "codex" && notification.method === "thread/goal/updated") {
      const goal = record(params?.goal);
      const status = goal?.status;
      if (status === "active" || status === "paused" || status === "blocked" || status === "usageLimited" || status === "budgetLimited") {
        this.goalOwnedThreads.add(threadId);
        if (candidate) candidate.goalOwned = true;
      } else {
        this.goalOwnedThreads.delete(threadId);
      }
    }
  }

  async completeObservedTurn(
    harness: WorkbenchHarness,
    notification: JsonRpcNotification,
    lifecycle: WorkbenchThreadLifecycle | null,
    port: WorkbenchUnfinishedTurnPort,
  ) {
    const signal = this.recoveryGeneration.signal;
    if (signal.aborted) return false;
    if (notification.method !== "turn/completed") return false;
    const params = record(notification.params);
    const threadId = threadIdFrom(notification.params);
    const turn = record(params?.turn);
    if (!threadId) return false;
    const key = `${harness}:${threadId}`;
    const candidate = this.candidates.get(key);
    if (!candidate || (candidate.turnId && typeof turn?.id === "string" && candidate.turnId !== turn.id)) return false;
    this.candidates.delete(key);
    if (
      turn?.status !== "completed"
      || candidate.goalOwned
      || lifecycle?.kind !== "needsAttention"
      || lifecycle.reason !== "noActiveTurn"
    ) return false;

    const continuationId = createWorkbenchThreadRecoveryId(`unfinished:${candidate.recoveryId}`);
    const paramsRecord = record(candidate.request.params) ?? {};
    const request: JsonRpcRequest = {
      ...structuredClone(candidate.request),
      id: continuationId,
      method: "turn/start",
      params: {
        ...structuredClone(paramsRecord),
        clientUserMessageId: continuationId,
        input: createWorkbenchUnfinishedTurnInput(),
        threadId,
      },
    };
    try {
      await port(structuredClone(candidate), request);
      return !signal.aborted;
    } catch (error) {
      if (signal.aborted) {
        this.log(`Retired unfinished-turn continuation failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      const replacement = this.candidates.get(key);
      if (replacement?.request.id === continuationId) this.candidates.delete(key);
      await this.publishFailure(candidate, error, this.reportFailure);
      this.log(`Unfinished-turn continuation failed for ${harness}:${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  beginRuntimeDrain() {
    this.acceptingRecovery = false;
  }

  expireRuntimeDrain() {
    this.beginRuntimeDrain();
    this.recoveryGeneration.abort(new Error("Turn recovery generation was retired."));
  }

  resumeAfterFailedReload() {
    if (this.recoveryGeneration.signal.aborted) this.recoveryGeneration = new AbortController();
    this.acceptingRecovery = true;
  }

  async waitForIdle() {
    await Promise.allSettled([...this.recoveryTasks].filter(([, task]) => !task.signal.aborted).map(([task]) => task));
    await Promise.all(this.failureReports);
  }

  async detachForReload(): Promise<WorkbenchTurnRecoveryControllerState> {
    this.beginRuntimeDrain();
    await this.waitForIdle();
    return {
      candidates: structuredClone([...this.candidates.values()]),
      goalOwnedThreads: [...this.goalOwnedThreads],
      resumeRequests: [...this.resumeRequests].map(([threadId, request]) => [threadId, structuredClone(request)]),
    };
  }

  listRuntimeDrainPending(now = Date.now()) {
    return [...this.recoveryTasks.values()].filter(({ signal }) => !signal.aborted)
      .map(({ label, startedAt }) => ({ ageMs: Math.max(0, now - startedAt), label }));
  }

  async requestResume(
    harness: WorkbenchHarness,
    threadId: string,
    port: WorkbenchTurnRecoveryPort = this.requireRecoveryPort(harness),
    reportFailure: (candidate: WorkbenchObservedTurnCandidate, error: unknown) => Promise<void> = this.reportFailure,
  ) {
    if (!this.acceptingRecovery) throw new Error("Turn recovery is draining; manual resume is temporarily unavailable.");
    const signal = this.recoveryGeneration.signal;
    const observed = this.candidates.get(`${harness}:${threadId}`);
    if (!observed) throw new Error("The current managed turn has no captured start request to resume.");
    if (!observed.turnId) throw new Error("The current managed turn has not started yet.");
    const candidate = structuredClone(observed);
    const label = `manual resume ${harness}:${threadId}`;
    let task!: Promise<void>;
    task = this.runRecoveryTask(label, async () => {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      if (signal.aborted) return;
      await this.refreshCurrent(candidate, port, signal, reportFailure);
    }).catch((error) => {
      this.log(`Manual resume failed outside the recovery boundary: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.recoveryTasks.delete(task); });
    this.recoveryTasks.set(task, { label, signal, startedAt: Date.now() });
  }

  private async refreshCurrent(
    candidate: WorkbenchObservedTurnCandidate,
    port: WorkbenchTurnRecoveryPort,
    signal: AbortSignal,
    reportFailure: (candidate: WorkbenchObservedTurnCandidate, error: unknown) => Promise<void>,
  ) {
    if (signal.aborted) return;
    let result: WorkbenchTurnRecoveryResult;
    try {
      result = await port(candidate, signal);
    } catch (error) {
      if (signal.aborted) {
        if (error !== signal.reason) this.log(`Retired turn recovery failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
        return;
      }
      await this.publishFailure(candidate, error, reportFailure);
      if (signal.aborted) return;
      const currentCandidate = this.candidates.get(candidate.key);
      if (currentCandidate?.recoveryId === candidate.recoveryId) this.candidates.delete(candidate.key);
      this.log(`Recovery failed for ${candidate.harness}:${candidate.threadId}; moved the thread to Needs attention.`);
      return;
    }
    if (signal.aborted) return;
    const currentCandidate = this.candidates.get(candidate.key);
    if (result !== "busy" && currentCandidate?.recoveryId === candidate.recoveryId) {
      this.candidates.delete(candidate.key);
    }
  }

  private publishFailure(
    candidate: WorkbenchObservedTurnCandidate,
    error: unknown,
    report: (candidate: WorkbenchObservedTurnCandidate, error: unknown) => Promise<void>,
  ) {
    const pending = report(candidate, error).finally(() => { this.failureReports.delete(pending); });
    this.failureReports.add(pending);
    return pending;
  }

  private requireRecoveryPort(harness: WorkbenchHarness) {
    const port = this.recoveryPorts[harness];
    if (!port) throw new Error(`Turn recovery has no active ${harness} provider port.`);
    return port;
  }
}
