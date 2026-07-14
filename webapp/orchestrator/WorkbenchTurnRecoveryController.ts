/*
 * Exports:
 * - WorkbenchTurnRecoveryPort/WorkbenchTurnRecoveryResult: provider recovery boundary and terminal outcomes. Keywords: recovery, provider, turn.
 * - MAX_AUTOMATIC_RECOVERY_THREADS: cross-harness automatic recovery catastrophe fuse. Keywords: recovery, cap, safety.
 * - default WorkbenchTurnRecoveryController: own live-only multi-harness candidates, goal exclusion, recency caps, and handoff progress. Keywords: recovery, registry, codex, opencode.
 */

import { createWorkbenchThreadRecoveryId } from "../lib/workbench/thread/thread-recovery-message";
import type { JsonRpcNotification, JsonRpcRequest } from "./bridge-types";
import type WorkbenchTurnRecoveryHandoffStore from "./WorkbenchTurnRecoveryHandoffStore";
import type { WorkbenchRecoveryHarness, WorkbenchTurnRecoveryHandoff, WorkbenchTurnRecoveryHandoffCandidate } from "./WorkbenchTurnRecoveryHandoffStore";

export type WorkbenchTurnRecoveryResult = "busy" | "completed" | "recovered";
export type WorkbenchTurnRecoveryPort = (candidate: WorkbenchTurnRecoveryHandoffCandidate) => Promise<WorkbenchTurnRecoveryResult>;

export const MAX_AUTOMATIC_RECOVERY_THREADS = 10;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function threadIdFrom(value: unknown) {
  const params = record(value);
  const turn = record(params?.turn);
  return typeof params?.threadId === "string" ? params.threadId : typeof turn?.threadId === "string" ? turn.threadId : null;
}

export default class WorkbenchTurnRecoveryController {
  private readonly candidates = new Map<string, WorkbenchTurnRecoveryHandoffCandidate>();
  private readonly generationId = createWorkbenchThreadRecoveryId(`orchestrator:${process.pid}:${Date.now()}`);
  private readonly goalOwnedThreads = new Set<string>();

  constructor(private readonly store: WorkbenchTurnRecoveryHandoffStore, private readonly log: (message: string) => void) {}

  observeRequest(harness: WorkbenchRecoveryHarness, request: JsonRpcRequest, now = Date.now()) {
    const params = record(request.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (harness === "codex" && request.method === "thread/goal/set" && threadId) this.goalOwnedThreads.add(threadId);
    if (harness === "codex" && request.method === "thread/goal/clear" && threadId) this.goalOwnedThreads.delete(threadId);
    if (request.method !== "turn/start" || !threadId) return;
    const key = `${harness}:${threadId}`;
    this.candidates.set(key, {
      harness,
      key,
      lastEventAt: now,
      recoveryId: createWorkbenchThreadRecoveryId(`${harness}:${threadId}:${String(request.id ?? now)}`),
      request: structuredClone(request),
      startedAt: now,
      threadId,
      turnId: null,
    });
  }

  observeNotification(harness: WorkbenchRecoveryHarness, notification: JsonRpcNotification, now = Date.now()) {
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
    ) {
      this.candidates.delete(key);
    }
    if (harness === "codex" && notification.method === "thread/goal/cleared") this.goalOwnedThreads.delete(threadId);
    if (harness === "codex" && notification.method === "thread/goal/updated") {
      const goal = record(params?.goal);
      const status = goal?.status;
      if (status === "active" || status === "paused" || status === "blocked" || status === "usageLimited" || status === "budgetLimited") {
        this.goalOwnedThreads.add(threadId);
      } else {
        this.goalOwnedThreads.delete(threadId);
      }
    }
  }

  capture(harnesses: readonly WorkbenchRecoveryHarness[]) {
    const allowed = new Set(harnesses);
    const eligible = [...this.candidates.values()]
      .filter((candidate) => allowed.has(candidate.harness))
      .filter((candidate) => candidate.harness !== "codex" || !this.goalOwnedThreads.has(candidate.threadId))
      .sort((left, right) => right.lastEventAt - left.lastEventAt);
    if (eligible.length > MAX_AUTOMATIC_RECOVERY_THREADS) {
      this.log(`Skipped ${eligible.length - MAX_AUTOMATIC_RECOVERY_THREADS} older active turns beyond the automatic recovery safety limit.`);
    }
    return eligible.slice(0, MAX_AUTOMATIC_RECOVERY_THREADS).map((candidate) => structuredClone(candidate));
  }

  async persistControlledRestart() {
    const handoff: WorkbenchTurnRecoveryHandoff = {
      candidates: this.capture(["codex", "opencode"]),
      createdAt: Date.now(),
      generation: this.generationId,
      id: createWorkbenchThreadRecoveryId(`handoff:${process.pid}:${Date.now()}`),
      schemaVersion: 1,
    };
    await this.store.write(handoff);
    return handoff;
  }

  async recover(candidates: WorkbenchTurnRecoveryHandoffCandidate[], port: WorkbenchTurnRecoveryPort, handoff?: WorkbenchTurnRecoveryHandoff) {
    let remaining = [...candidates];
    for (const candidate of candidates) {
      const result = await port(candidate);
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
}
