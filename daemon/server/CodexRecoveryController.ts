/*
 * Exports:
 * - CodexTurnRecoveryPort/CodexTurnRecoveryResult: native replay boundary and terminal outcomes.
 * - CodexRecoveryControllerState: exact native request capture handoff.
 * - CodexObservedTurnCandidate: native request and turn context.
 * - CodexUnfinishedTurnPort: admitted hidden continuation boundary.
 * - CodexRecoveryOptions: shared scheduling and native replay/identity dependencies.
 * - default CodexRecoveryController: own native capture, replay and generation cancellation.
 */

import type { WorkbenchHarness } from "workbench-shared/types";
import { createWorkbenchThreadRecoveryId, createWorkbenchUnfinishedTurnInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";

export interface CodexObservedTurnCandidate {
  goalOwned?: boolean;
  harness: WorkbenchHarness;
  key: string;
  request: JsonRpcRequest;
  recoveryId: string;
  resumeRequest?: JsonRpcRequest | null;
  threadId: string;
  turnId: string | null;
}

export type CodexTurnRecoveryResult = "busy" | "completed" | "recovered";
export type CodexTurnRecoveryPort = (candidate: CodexObservedTurnCandidate, signal?: AbortSignal) => Promise<CodexTurnRecoveryResult>;
export type CodexUnfinishedTurnPort = (candidate: CodexObservedTurnCandidate, request: JsonRpcRequest) => Promise<void>;

export interface CodexRecoveryControllerState {
  candidates: CodexObservedTurnCandidate[];
  goalOwnedThreads: string[];
  activeGoalThreads?: string[];
  resumeRequests: Array<[string, JsonRpcRequest]>;
}

export interface CodexRecoveryOptions {
  coordinator: WorkbenchTurnRecoveryController;
  log(message: string): void;
  reportFailure(candidate: CodexObservedTurnCandidate, error: unknown): Promise<void>;
  state?: CodexRecoveryControllerState;
  recover?: CodexTurnRecoveryPort;
  runTask(label: string, task: () => Promise<void>): Promise<void>;
  request?(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  resolveThread?(threadId: WorkbenchThreadId): Promise<string>;
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

export default class CodexRecoveryController {
  private readonly candidates = new Map<string, CodexObservedTurnCandidate>();
  private readonly goalOwnedThreads = new Map<string, boolean>();
  private readonly resumeRequests = new Map<string, JsonRpcRequest>();
  private acceptingRecovery = true;
  private recoveryGeneration = new AbortController();
  constructor(private readonly options: CodexRecoveryOptions) {
    const { state } = options;
    for (const candidate of state?.candidates ?? []) this.candidates.set(candidate.key, structuredClone(candidate));
    for (const threadId of state?.goalOwnedThreads ?? []) {
      this.goalOwnedThreads.set(threadId, state?.activeGoalThreads?.includes(threadId) ?? true);
    }
    for (const [threadId, request] of state?.resumeRequests ?? []) this.resumeRequests.set(threadId, structuredClone(request));
  }

  async refresh(threadId: WorkbenchThreadId) {
    if (!this.options.resolveThread) throw new Error("Codex recovery identity is unavailable.");
    await this.requestResume("codex", await this.options.resolveThread(threadId));
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
      this.goalOwnedThreads.set(threadId, true);
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
        this.goalOwnedThreads.set(threadId, status === "active");
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
    port: CodexUnfinishedTurnPort = async (candidate, request) => {
      if (!candidate.resumeRequest || !this.options.request) throw new Error("The unfinished Codex turn has no captured admission context.");
      this.observeRequest("codex", request);
      const response = await this.options.request({
        id: `unfinished-admit:${candidate.recoveryId}`,
        method: "workbench/codex/message/admit",
        params: { resumeRequest: candidate.resumeRequest, startRequest: request, threadId: candidate.threadId },
      }, this.recoveryGeneration.signal);
      if (response.error) throw new Error(response.error.message);
    },
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
      || !this.options.coordinator.shouldContinue(lifecycle, candidate.goalOwned === true)
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
        this.options.log(`Retired unfinished-turn continuation failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      const replacement = this.candidates.get(key);
      if (replacement?.request.id === continuationId) this.candidates.delete(key);
      await this.publishFailure(candidate, error, this.options.reportFailure);
      this.options.log(`Unfinished-turn continuation failed for ${harness}:${threadId}: ${error instanceof Error ? error.message : String(error)}`);
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
    await this.options.coordinator.waitForIdle(this.recoveryGeneration.signal);
  }

  async detachForReload(): Promise<CodexRecoveryControllerState> {
    this.beginRuntimeDrain();
    await this.waitForIdle();
    return this.captureReloadState();
  }

  captureReloadState(): CodexRecoveryControllerState {
    return {
      candidates: structuredClone([...this.candidates.values()]),
      goalOwnedThreads: [...this.goalOwnedThreads.keys()],
      activeGoalThreads: [...this.goalOwnedThreads].filter(([, active]) => active).map(([threadId]) => threadId),
      resumeRequests: [...this.resumeRequests].map(([threadId, request]) => [threadId, structuredClone(request)]),
    };
  }

  hasPendingWork() { return [...this.goalOwnedThreads.values()].some(active => active); }

  listRuntimeDrainPending(now = Date.now()) {
    return this.options.coordinator.listRuntimeDrainPending(now, this.recoveryGeneration.signal);
  }

  async requestResume(
    harness: WorkbenchHarness,
    threadId: string,
    port: CodexTurnRecoveryPort = this.requireRecoveryPort(harness),
    reportFailure: (candidate: CodexObservedTurnCandidate, error: unknown) => Promise<void> = this.options.reportFailure,
  ) {
    if (!this.acceptingRecovery) throw new Error("Turn recovery is draining; manual resume is temporarily unavailable.");
    const signal = this.recoveryGeneration.signal;
    const observed = this.candidates.get(`${harness}:${threadId}`);
    if (!observed) throw new Error("The current managed turn has no captured start request to resume.");
    if (!observed.turnId) throw new Error("The current managed turn has not started yet.");
    const candidate = structuredClone(observed);
    const label = `manual resume ${harness}:${threadId}`;
    this.options.coordinator.schedule(label, signal, () => this.expireRuntimeDrain(), () => this.options.runTask(label, async () => {
      await this.refreshCurrent(candidate, port, signal, reportFailure);
    }));
  }

  private async refreshCurrent(
    candidate: CodexObservedTurnCandidate,
    port: CodexTurnRecoveryPort,
    signal: AbortSignal,
    reportFailure: (candidate: CodexObservedTurnCandidate, error: unknown) => Promise<void>,
  ) {
    if (signal.aborted) return;
    let result: CodexTurnRecoveryResult;
    try {
      result = await port(candidate, signal);
    } catch (error) {
      if (signal.aborted) {
        if (error !== signal.reason) this.options.log(`Retired turn recovery failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
        return;
      }
      await this.publishFailure(candidate, error, reportFailure);
      if (signal.aborted) return;
      const currentCandidate = this.candidates.get(candidate.key);
      if (currentCandidate?.recoveryId === candidate.recoveryId) this.candidates.delete(candidate.key);
      this.options.log(`Recovery failed for ${candidate.harness}:${candidate.threadId}; moved the thread to Needs attention.`);
      return;
    }
    if (signal.aborted) return;
    const currentCandidate = this.candidates.get(candidate.key);
    if (result !== "busy" && currentCandidate?.recoveryId === candidate.recoveryId) {
      this.candidates.delete(candidate.key);
    }
  }

  private publishFailure(
    candidate: CodexObservedTurnCandidate,
    error: unknown,
    report: (candidate: CodexObservedTurnCandidate, error: unknown) => Promise<void>,
  ) {
    return this.options.coordinator.reportFailure(this.recoveryGeneration.signal, () => report(candidate, error));
  }

  private requireRecoveryPort(harness: WorkbenchHarness) {
    const port = this.options.recover;
    if (!port) throw new Error(`Turn recovery has no active ${harness} provider port.`);
    return port;
  }
}
