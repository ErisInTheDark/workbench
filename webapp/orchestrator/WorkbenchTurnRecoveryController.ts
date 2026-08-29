/*
 * Exports:
 * - WorkbenchTurnRecoveryPort/WorkbenchTurnRecoveryResult: provider recovery boundary and terminal outcomes. Keywords: recovery, provider, turn.
 * - WorkbenchTurnRecoveryControllerState: reload-handoff state for observed turns and pending recovery. Keywords: recovery, handoff, lifecycle.
 * - WorkbenchUnfinishedTurnPort: admitted hidden continuation boundary. Keywords: unfinished, continuation, provider.
 * - MAX_AUTOMATIC_RECOVERY_THREADS: cross-harness automatic recovery catastrophe fuse. Keywords: recovery, cap, safety.
 * - default WorkbenchTurnRecoveryController: own live multi-harness candidates, explicit resume handoffs, goal exclusion, recency caps, and recovery progress. Keywords: recovery, registry, codex, opencode.
 */

import type { WorkbenchHarness } from "../lib/types";
import { createWorkbenchThreadRecoveryId, createWorkbenchUnfinishedTurnInput } from "../lib/workbench/thread/thread-recovery-message";
import type { WorkbenchThreadLifecycle } from "../lib/workbench/thread/thread-state";
import type { JsonRpcNotification, JsonRpcRequest } from "./bridge-types";
import WorkbenchTurnRecoveryHandoffStore, { createCodexTurnRecoveryResumeRequest } from "./WorkbenchTurnRecoveryHandoffStore";
import type {
  WorkbenchObservedTurnCandidate,
  WorkbenchRecoveryHarness,
  WorkbenchTurnRecoveryHandoff,
  WorkbenchTurnRecoveryHandoffCandidate,
} from "./WorkbenchTurnRecoveryHandoffStore";

export type WorkbenchTurnRecoveryResult = "busy" | "completed" | "recovered";
export type WorkbenchTurnRecoveryPort = (candidate: WorkbenchTurnRecoveryHandoffCandidate) => Promise<WorkbenchTurnRecoveryResult>;
export type WorkbenchUnfinishedTurnPort = (candidate: WorkbenchObservedTurnCandidate, request: JsonRpcRequest) => Promise<void>;

export const MAX_AUTOMATIC_RECOVERY_THREADS = 10;

export interface WorkbenchTurnRecoveryControllerState {
  candidates: WorkbenchObservedTurnCandidate[];
  generationId: string;
  goalOwnedThreads: string[];
  pendingHandoff: WorkbenchTurnRecoveryHandoff | null;
  reloadCandidates: WorkbenchTurnRecoveryHandoffCandidate[];
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

function isRecoveryCandidate(candidate: WorkbenchObservedTurnCandidate): candidate is WorkbenchTurnRecoveryHandoffCandidate {
  return candidate.harness === "codex" || candidate.harness === "opencode";
}

export default class WorkbenchTurnRecoveryController {
  private readonly candidates = new Map<string, WorkbenchObservedTurnCandidate>();
  private readonly generationId: string;
  private readonly goalOwnedThreads = new Set<string>();
  private readonly recoveryTasks = new Map<Promise<void>, { label: string; startedAt: number }>();
  private readonly resumeRequests = new Map<string, JsonRpcRequest>();
  private acceptingRecovery = true;
  private pendingHandoff: WorkbenchTurnRecoveryHandoff | null = null;
  private reloadCandidates: WorkbenchTurnRecoveryHandoffCandidate[] = [];

  constructor(
    private readonly store: WorkbenchTurnRecoveryHandoffStore,
    private readonly log: (message: string) => void,
    private readonly reportFailure: (candidate: WorkbenchObservedTurnCandidate, error: unknown) => Promise<void> = async () => undefined,
    state?: WorkbenchTurnRecoveryControllerState,
    private readonly recoveryPorts: Partial<Record<WorkbenchRecoveryHarness, WorkbenchTurnRecoveryPort>> = {},
    private readonly runRecoveryTask: (label: string, task: () => Promise<void>) => Promise<void> = async (_label, task) => await task(),
  ) {
    this.generationId = state?.generationId ?? createWorkbenchThreadRecoveryId(`orchestrator:${process.pid}:${Date.now()}`);
    for (const candidate of state?.candidates ?? []) this.candidates.set(candidate.key, structuredClone(candidate));
    for (const threadId of state?.goalOwnedThreads ?? []) this.goalOwnedThreads.add(threadId);
    for (const [threadId, request] of state?.resumeRequests ?? []) this.resumeRequests.set(threadId, structuredClone(request));
    this.pendingHandoff = state?.pendingHandoff ? structuredClone(state.pendingHandoff) : null;
    this.reloadCandidates = structuredClone(state?.reloadCandidates ?? []);
  }

  observeRequest(harness: WorkbenchHarness, request: JsonRpcRequest, now = Date.now()) {
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
      lastEventAt: now,
      recoveryId: createWorkbenchThreadRecoveryId(`${harness}:${threadId}:${String(request.id ?? now)}`),
      request: structuredClone(request),
      startedAt: now,
      resumeRequest: harness === "codex"
        ? structuredClone(this.resumeRequests.get(threadId) ?? createCodexTurnRecoveryResumeRequest(request, threadId))
        : null,
      threadId,
      turnId: null,
    });
    this.resumeRequests.delete(threadId);
  }

  observeNotification(harness: WorkbenchHarness, notification: JsonRpcNotification, now = Date.now()) {
    const params = record(notification.params);
    const threadId = threadIdFrom(notification.params);
    if (!threadId) return;
    const key = `${harness}:${threadId}`;
    const candidate = this.candidates.get(key);
    const turn = record(params?.turn);
    if (candidate) {
      candidate.lastEventAt = now;
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
      return true;
    } catch (error) {
      const replacement = this.candidates.get(key);
      if (replacement?.request.id === continuationId) this.candidates.delete(key);
      await this.reportFailure(candidate, error);
      this.log(`Unfinished-turn continuation failed for ${harness}:${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  capture(harnesses: readonly WorkbenchRecoveryHarness[]) {
    const allowed = new Set(harnesses);
    const eligible = [...this.candidates.values()]
      .filter(isRecoveryCandidate)
      .filter((candidate) => allowed.has(candidate.harness))
      .filter((candidate) => candidate.harness !== "codex" || !this.goalOwnedThreads.has(candidate.threadId))
      .sort((left, right) => right.lastEventAt - left.lastEventAt);
    if (eligible.length > MAX_AUTOMATIC_RECOVERY_THREADS) {
      this.log(`Skipped ${eligible.length - MAX_AUTOMATIC_RECOVERY_THREADS} older active turns beyond the automatic recovery safety limit.`);
    }
    return eligible.slice(0, MAX_AUTOMATIC_RECOVERY_THREADS).map((candidate) => structuredClone(candidate));
  }

  captureForReload(harnesses: readonly WorkbenchRecoveryHarness[]) {
    this.reloadCandidates = this.capture(harnesses);
    return structuredClone(this.reloadCandidates);
  }

  beginRuntimeDrain() {
    this.acceptingRecovery = false;
  }

  async detachForReload(): Promise<WorkbenchTurnRecoveryControllerState> {
    this.beginRuntimeDrain();
    await Promise.allSettled(this.recoveryTasks.keys());
    return {
      candidates: structuredClone([...this.candidates.values()]),
      generationId: this.generationId,
      goalOwnedThreads: [...this.goalOwnedThreads],
      pendingHandoff: this.pendingHandoff ? structuredClone(this.pendingHandoff) : null,
      reloadCandidates: structuredClone(this.reloadCandidates),
      resumeRequests: [...this.resumeRequests].map(([threadId, request]) => [threadId, structuredClone(request)]),
    };
  }

  listRuntimeDrainPending(now = Date.now()) {
    return [...this.recoveryTasks.values()].map(({ label, startedAt }) => ({ ageMs: Math.max(0, now - startedAt), label }));
  }

  async loadPersistedHandoff() {
    const handoff = await this.store.load();
    if (!handoff) return;
    this.pendingHandoff = handoff;
    this.loadCandidates(handoff.candidates);
  }

  async recoverAvailable(
    harness: WorkbenchRecoveryHarness,
    port: WorkbenchTurnRecoveryPort = this.requireRecoveryPort(harness),
    reportFailure: (candidate: WorkbenchTurnRecoveryHandoffCandidate, error: unknown) => Promise<void> = this.reportFailure,
  ) {
    const captured = this.reloadCandidates.filter((candidate) => candidate.harness === harness);
    this.reloadCandidates = this.reloadCandidates.filter((candidate) => candidate.harness !== harness);
    await this.recover(captured, port, undefined, reportFailure);
    const handoff = this.pendingHandoff;
    if (!handoff) return;
    const candidates = handoff.candidates.filter((candidate) => candidate.harness === harness);
    if (!candidates.length) return;
    await this.recover(candidates, port, handoff, reportFailure);
    this.pendingHandoff = await this.store.load();
  }

  async requestResume(
    harness: WorkbenchRecoveryHarness,
    threadId: string,
    port: WorkbenchTurnRecoveryPort = this.requireRecoveryPort(harness),
    reportFailure: (candidate: WorkbenchTurnRecoveryHandoffCandidate, error: unknown) => Promise<void> = this.reportFailure,
  ) {
    if (!this.acceptingRecovery) throw new Error("Turn recovery is draining; manual resume is temporarily unavailable.");
    const { candidate, handoff } = await this.persistManualResume(harness, threadId);
    const label = `manual resume ${harness}:${threadId}`;
    let task!: Promise<void>;
    task = this.runRecoveryTask(label, async () => {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      await this.recover([candidate], port, handoff, reportFailure);
    }).catch((error) => {
      this.log(`Manual resume failed outside the recovery boundary: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.recoveryTasks.delete(task); });
    this.recoveryTasks.set(task, { label, startedAt: Date.now() });
  }

  async persistManualResume(harness: WorkbenchRecoveryHarness, threadId: string) {
    const candidate = this.candidates.get(`${harness}:${threadId}`);
    if (!candidate) throw new Error("The current managed turn has no captured start request to resume.");
    if (!isRecoveryCandidate(candidate)) throw new Error(`Manual thread resume is unavailable for ${candidate.harness} threads.`);
    if (!candidate.turnId) throw new Error("The current managed turn has not started yet.");
    const captured = structuredClone(candidate);
    const handoff: WorkbenchTurnRecoveryHandoff = {
      candidates: [captured],
      createdAt: Date.now(),
      generation: this.generationId,
      id: createWorkbenchThreadRecoveryId(`manual:${harness}:${threadId}:${Date.now()}`),
      kind: "manual-resume",
      schemaVersion: 2,
    };
    await this.store.write(handoff);
    return { candidate: captured, handoff };
  }

  async recover(
    candidates: WorkbenchTurnRecoveryHandoffCandidate[],
    port: WorkbenchTurnRecoveryPort,
    handoff?: WorkbenchTurnRecoveryHandoff,
    reportFailure: (candidate: WorkbenchTurnRecoveryHandoffCandidate, error: unknown) => Promise<void> = this.reportFailure,
  ) {
    let remaining = [...candidates];
    for (const candidate of candidates) {
      let result: WorkbenchTurnRecoveryResult;
      try {
        result = await port(candidate);
      } catch (error) {
        await reportFailure(candidate, error);
        const currentCandidate = this.candidates.get(candidate.key);
        if (currentCandidate?.recoveryId === candidate.recoveryId) this.candidates.delete(candidate.key);
        remaining = remaining.filter((entry) => entry.key !== candidate.key);
        if (handoff) await this.store.updateCandidates(handoff, remaining);
        this.log(`Recovery failed for ${candidate.harness}:${candidate.threadId}; moved the thread to Needs attention.`);
        continue;
      }
      const currentCandidate = this.candidates.get(candidate.key);
      if (result !== "busy" && currentCandidate?.recoveryId === candidate.recoveryId) {
        this.candidates.delete(candidate.key);
      }
      remaining = remaining.filter((entry) => entry.key !== candidate.key);
      if (handoff) await this.store.updateCandidates(handoff, remaining);
    }
  }

  loadCandidates(candidates: WorkbenchTurnRecoveryHandoffCandidate[]) {
    for (const candidate of candidates) this.candidates.set(candidate.key, structuredClone(candidate));
  }

  private requireRecoveryPort(harness: WorkbenchRecoveryHarness) {
    const port = this.recoveryPorts[harness];
    if (!port) throw new Error(`Turn recovery has no active ${harness} provider port.`);
    return port;
  }
}
