/*
 * Exports:
 * - WorkbenchReloadScopeClaim/WorkbenchReloadRequest: active arc claim and managed reload admission contracts. Keywords: reload, arc, claim, lifecycle.
 * - WorkbenchOrchestratorReloadControllerState: transferable waiter and active-batch state for coordinator self-reload. Keywords: reload, queue, handoff.
 * - WorkbenchOrchestratorReloadControllerOptions: claim read and low-level scope execution ports. Keywords: reload, ports, ownership.
 * - WorkbenchHardReloadNotification/WorkbenchHardReloadOptions: operator-only impending-restart notification and force-exit ports. Keywords: hard reload, notification, deadline, exit.
 * - default WorkbenchOrchestratorReloadController: own reload admission, useful batching, cancellation, and waiter completion. Keywords: reload, queue, batch, cancellation.
 */
import { randomUUID } from "node:crypto";

import type { OrchestratorReloadResponse, OrchestratorReloadScope, WorkbenchHarness } from "../lib/types";
import { ORCHESTRATOR_RELOAD_SCOPES } from "../lib/workbench/orchestrator-reload";

export interface WorkbenchReloadScopeClaim {
  harness: WorkbenchHarness;
  lifecycleKind: "completed" | "needsAttention" | "stopped" | "unknown" | "working";
  reloadScopes: OrchestratorReloadScope[];
  threadId: string;
}

export interface WorkbenchReloadRequest {
  cwd: string;
  harness: WorkbenchHarness;
  scopes: OrchestratorReloadScope[];
  threadId: string;
}

interface ReloadWaiter {
  cwd: string;
  identityKey: string;
  reject(error: unknown): void;
  requestedScopes: OrchestratorReloadScope[];
  resolve(response: OrchestratorReloadResponse): void;
  satisfiedScopes: Set<OrchestratorReloadScope>;
  startedAt: number;
}

interface ReloadBatch {
  scopes: OrchestratorReloadScope[];
}

export interface WorkbenchOrchestratorReloadControllerState {
  activeBatch: ReloadBatch | null;
  eligibilityChanged: boolean;
  hardReloadPhase: "admitted" | "idle" | "stopping";
  waiters: Map<string, ReloadWaiter>;
}

interface HardReloadDeadline {
  cancel(): void;
  expired: Promise<void>;
}

export interface WorkbenchHardReloadNotification {
  name: string;
  notify(): Promise<void> | void;
}

export interface WorkbenchHardReloadOptions {
  createDeadline?: (timeoutMs: number) => HardReloadDeadline;
  exitProcess(): void;
  logError?: (message: string) => void;
  notifications(): readonly WorkbenchHardReloadNotification[];
  timeoutMs?: number;
}

export interface WorkbenchOrchestratorReloadControllerOptions {
  executeBatch(scopes: OrchestratorReloadScope[]): Promise<void>;
  hardReload?: WorkbenchHardReloadOptions;
  initialState?: WorkbenchOrchestratorReloadControllerState;
  listClaims(cwd: string): Promise<WorkbenchReloadScopeClaim[]>;
  now?: () => number;
}

const SUPPORTED_SCOPES = new Set<OrchestratorReloadScope>(ORCHESTRATOR_RELOAD_SCOPES);
const DEFAULT_HARD_RELOAD_TIMEOUT_MS = 5_000;

function createDeadline(timeoutMs: number): HardReloadDeadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return {
    cancel: () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
    expired,
  };
}

function identityKey(harness: WorkbenchHarness, threadId: string) {
  return `${harness}\0${threadId}`;
}

function remainingScopes(waiter: ReloadWaiter) {
  return waiter.requestedScopes.filter((scope) => !waiter.satisfiedScopes.has(scope));
}

function isTerminalLifecycle(kind: WorkbenchReloadScopeClaim["lifecycleKind"]) {
  return kind === "completed" || kind === "stopped";
}

export default class WorkbenchOrchestratorReloadController {
  private attached = true;
  private hardReloadExitRequested = false;
  private readonly now: () => number;
  private selecting = false;
  private readonly state: WorkbenchOrchestratorReloadControllerState;

  constructor(private readonly options: WorkbenchOrchestratorReloadControllerOptions) {
    this.now = options.now ?? Date.now;
    this.state = options.initialState ?? { activeBatch: null, eligibilityChanged: false, hardReloadPhase: "idle", waiters: new Map() };
    // A controller loaded before hard reload existed transfers this same state object during self-reload.
    this.state.hardReloadPhase ??= "idle";
  }

  async request(input: WorkbenchReloadRequest, signal: AbortSignal): Promise<OrchestratorReloadResponse> {
    if (!this.attached) throw new Error("The reload coordinator generation was replaced before admission completed.");
    if (this.isHardReloadPending()) throw new Error("The orchestrator is hard reloading; new reload work is unavailable.");
    if (signal.aborted) throw signal.reason;
    const requestedScopes = Array.from(new Set(input.scopes));
    if (!requestedScopes.length || requestedScopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) {
      throw new Error("At least one supported reload scope is required.");
    }
    const claims = await this.options.listClaims(input.cwd);
    const callerKey = identityKey(input.harness, input.threadId);
    const callerClaim = claims.find((claim) => identityKey(claim.harness, claim.threadId) === callerKey);
    if (!callerClaim) throw new Error("The managed thread must own an active Git arc before requesting a reload.");
    const unclaimed = requestedScopes.filter((scope) => !callerClaim.reloadScopes.includes(scope));
    if (unclaimed.length) {
      throw new Error(`The active Git arc does not claim these reload scopes: ${unclaimed.join(", ")}.`);
    }

    return await new Promise<OrchestratorReloadResponse>((resolve, reject) => {
      const waiterId = `${callerKey}\0${randomUUID()}`;
      const abort = () => {
        if (!this.state.waiters.delete(waiterId)) return;
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
        this.notifyEligibilityChanged();
      };
      this.state.waiters.set(waiterId, {
        cwd: input.cwd,
        identityKey: callerKey,
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
        requestedScopes,
        resolve: (response) => {
          signal.removeEventListener("abort", abort);
          resolve(response);
        },
        satisfiedScopes: new Set(),
        startedAt: this.now(),
      });
      signal.addEventListener("abort", abort, { once: true });
      this.notifyEligibilityChanged();
    });
  }

  notifyEligibilityChanged() {
    if (!this.attached || this.isHardReloadPending()) return;
    this.state.eligibilityChanged = true;
    this.schedule();
  }

  detachForReload() {
    this.attached = false;
    return this.state;
  }

  resumeAfterFailedReload() {
    this.attached = true;
  }

  completeTransferredBatch() {
    if (!this.attached) throw new Error("A detached reload coordinator cannot complete a transferred batch.");
    const batch = this.state.activeBatch;
    if (!batch) throw new Error("No reload batch is available to complete after coordinator replacement.");
    this.completeBatch(batch);
  }

  dispose() {
    this.attached = false;
    const error = new Error("The reload coordinator was disposed before queued reloads completed.");
    for (const waiter of this.state.waiters.values()) waiter.reject(error);
    this.state.waiters.clear();
    this.state.activeBatch = null;
  }

  admitHardReload(): OrchestratorReloadResponse {
    if (!this.options.hardReload) throw new Error("Hard reload is not configured.");
    if (this.state.hardReloadPhase !== "idle") throw new Error("A hard reload is already pending.");
    const startedAt = this.now();
    this.state.hardReloadPhase = "admitted";
    return {
      appliedScopes: [],
      completedAt: startedAt,
      error: null,
      ok: true,
      queuedScopes: ["orchestrator-server"],
      requestedScopes: ["orchestrator-server"],
      startedAt,
      state: "succeeded",
    };
  }

  cancelHardReloadAdmission() {
    if (this.state.hardReloadPhase === "admitted") this.state.hardReloadPhase = "idle";
  }

  isHardReloadPending() {
    return this.state.hardReloadPhase !== "idle";
  }

  async beginHardReload() {
    const options = this.options.hardReload;
    if (!options) throw new Error("Hard reload is not configured.");
    if (this.state.hardReloadPhase === "stopping") return;
    if (this.state.hardReloadPhase !== "admitted") throw new Error("Hard reload was not admitted before shutdown began.");
    this.state.hardReloadPhase = "stopping";
    this.attached = false;
    this.failAll(new Error("The orchestrator is hard reloading."));

    const logError = options.logError ?? (() => undefined);
    const deadline = (options.createDeadline ?? createDeadline)(options.timeoutMs ?? DEFAULT_HARD_RELOAD_TIMEOUT_MS);
    const settlements = options.notifications().map(({ name, notify }) => {
      try {
        return Promise.resolve(notify()).catch((error: unknown) => {
          logError(`${name} hard-reload notification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        logError(`${name} hard-reload notification failed: ${error instanceof Error ? error.message : String(error)}`);
        return Promise.resolve();
      }
    });
    const settled = Promise.all(settlements).then(() => undefined);
    const outcome = await Promise.race([
      settled.then(() => "settled" as const),
      deadline.expired.then(() => "deadline" as const),
    ]);
    if (outcome === "settled") deadline.cancel();
    if (this.hardReloadExitRequested) return;
    this.hardReloadExitRequested = true;
    options.exitProcess();
  }

  private schedule() {
    if (!this.attached || this.isHardReloadPending() || this.selecting || this.state.activeBatch || !this.state.waiters.size) return;
    this.selecting = true;
    this.state.eligibilityChanged = false;
    void this.selectBatch().then((batch) => {
      this.selecting = false;
      if (!this.attached) return;
      if (!batch) {
        if (this.state.eligibilityChanged) this.schedule();
        return;
      }
      this.state.activeBatch = batch;
      void this.executeBatch(batch);
    }).catch((error) => {
      this.selecting = false;
      if (!this.attached) return;
      this.failAll(error);
    });
  }

  private async selectBatch(): Promise<ReloadBatch | null> {
    const firstWaiter = this.state.waiters.values().next().value as ReloadWaiter | undefined;
    if (!firstWaiter) return null;
    const claims = await this.options.listClaims(firstWaiter.cwd);
    if (!this.attached) return null;
    const waitingIdentities = new Set(Array.from(this.state.waiters.values(), (waiter) => waiter.identityKey));
    const safeScopes = new Set<OrchestratorReloadScope>();
    for (const scope of ORCHESTRATOR_RELOAD_SCOPES) {
      const blockers = claims.filter((claim) => claim.reloadScopes.includes(scope));
      if (blockers.every((claim) => isTerminalLifecycle(claim.lifecycleKind) || waitingIdentities.has(identityKey(claim.harness, claim.threadId)))) {
        safeScopes.add(scope);
      }
    }
    const batchScopes = new Set<OrchestratorReloadScope>();
    for (const waiter of this.state.waiters.values()) {
      const remaining = remainingScopes(waiter);
      if (remaining.length && remaining.every((scope) => safeScopes.has(scope))) {
        for (const scope of remaining) batchScopes.add(scope);
      }
    }
    if (!batchScopes.size) return null;
    return { scopes: ORCHESTRATOR_RELOAD_SCOPES.filter((scope) => batchScopes.has(scope)) };
  }

  private async executeBatch(batch: ReloadBatch) {
    try {
      await this.options.executeBatch(batch.scopes);
      if (!this.attached) return;
      this.completeBatch(batch);
    } catch (error) {
      if (!this.attached) return;
      this.failBatch(batch, error);
    }
  }

  private completeBatch(batch: ReloadBatch) {
    if (this.state.activeBatch !== batch) throw new Error("Reload batch ownership changed before completion.");
    this.state.activeBatch = null;
    for (const [waiterId, waiter] of this.state.waiters) {
      for (const scope of batch.scopes) {
        if (waiter.requestedScopes.includes(scope)) waiter.satisfiedScopes.add(scope);
      }
      if (remainingScopes(waiter).length) continue;
      this.state.waiters.delete(waiterId);
      waiter.resolve({
        appliedScopes: waiter.requestedScopes.filter((scope) => scope !== "next-dev" && scope !== "orchestrator-server"),
        completedAt: this.now(),
        error: null,
        ok: true,
        queuedScopes: waiter.requestedScopes.filter((scope) => scope === "next-dev" || scope === "orchestrator-server"),
        requestedScopes: waiter.requestedScopes,
        startedAt: waiter.startedAt,
        state: "succeeded",
      });
    }
    this.notifyEligibilityChanged();
  }

  private failBatch(batch: ReloadBatch, error: unknown) {
    if (this.state.activeBatch !== batch) return;
    this.state.activeBatch = null;
    for (const [waiterId, waiter] of this.state.waiters) {
      if (!remainingScopes(waiter).some((scope) => batch.scopes.includes(scope))) continue;
      this.state.waiters.delete(waiterId);
      waiter.reject(error);
    }
    this.notifyEligibilityChanged();
  }

  private failAll(error: unknown) {
    for (const waiter of this.state.waiters.values()) waiter.reject(error);
    this.state.waiters.clear();
  }
}
