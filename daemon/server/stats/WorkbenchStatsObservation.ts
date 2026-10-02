/*
 * Exports:
 * - WorkbenchStatsObservationState: one published stats snapshot with usage and claim freshness.
 * - WorkbenchStatsInvalidation: which facts changed; claims also re-walk rename history.
 * - default WorkbenchStatsObservation: own one scope's coalesced two-stage reads, publication, and release.
 */
import type { WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchClaimRenameRead } from "./WorkbenchClaimRenameController.ts";

export interface WorkbenchStatsObservationState {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  claimsPhase: WorkspaceSourcePhase;
  data: WorkbenchStatsResponse | null;
}

export type WorkbenchStatsInvalidation = "usage" | "claims";

const NO_RENAMES: WorkbenchClaimRenameRead = { renames: [], failures: [] };

function failureMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Statistics could not be read.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 500);
}

/**
 * Usage publishes as soon as SQLite answers; claim hotspots follow once rename history is merged.
 * Invalidations during a read collapse into one follow-up read, and only claim changes re-walk Git history.
 */
export default class WorkbenchStatsObservation {
  #state: WorkbenchStatsObservationState = { phase: "pending", failure: null, claimsPhase: "pending", data: null };
  #dirty = { usage: true, claims: true };
  #history: WorkbenchClaimRenameRead | null = null;
  #work: Promise<void> | null = null;
  #released = false;

  constructor(
    private readonly request: WorkbenchStatsReadRequest,
    private readonly owner: {
      read(request: WorkbenchStatsReadRequest, history: WorkbenchClaimRenameRead): Promise<WorkbenchStatsResponse>;
      readRenames(request: WorkbenchStatsReadRequest): Promise<WorkbenchClaimRenameRead>;
      warn(message: string): void;
    },
    private readonly publish: (state: WorkbenchStatsObservationState) => void,
  ) {}

  get state() { return this.#state; }
  get settled() { return this.#work; }

  start() { this.#drive(); }

  invalidate(kind: WorkbenchStatsInvalidation) {
    if (this.#released) return;
    this.#dirty.usage = true;
    if (kind === "claims") this.#dirty.claims = true;
    this.#drive();
  }

  release() { this.#released = true; }

  #drive() {
    if (this.#work || this.#released) return;
    const work = this.#run();
    this.#work = work;
    void work.finally(() => {
      if (this.#work === work) this.#work = null;
      if (!this.#released && (this.#dirty.usage || this.#dirty.claims)) this.#drive();
    });
  }

  async #run() {
    while (!this.#released && (this.#dirty.usage || this.#dirty.claims)) {
      const walkClaims = this.#dirty.claims || !this.#history;
      this.#dirty = { usage: false, claims: false };
      try {
        const known = this.#history ?? NO_RENAMES;
        const usage = await this.owner.read(this.request, known);
        if (this.#released) return;
        this.#update({ phase: "current", failure: null, claimsPhase: walkClaims ? "pending" : this.#claimsPhase(known), data: usage });
        if (!walkClaims) continue;
        const history = await this.owner.readRenames(this.request);
        if (this.#released) return;
        this.#history = history;
        // Without renames the usage snapshot already counted claims correctly.
        const complete = history.renames.length || history.failures.length ? await this.owner.read(this.request, history) : usage;
        if (this.#released) return;
        this.#update({ phase: "current", failure: null, claimsPhase: this.#claimsPhase(history), data: complete });
      } catch (error) {
        if (this.#released) return;
        const failure = failureMessage(error);
        this.owner.warn(`Statistics observation failed: ${failure}`);
        const data = this.#state.data;
        this.#update({ phase: data ? "stale" : "failed", failure, claimsPhase: data ? "stale" : "failed", data });
      }
    }
  }

  #claimsPhase(history: WorkbenchClaimRenameRead): WorkspaceSourcePhase {
    return history.failures.length ? "stale" : "current";
  }

  #update(state: WorkbenchStatsObservationState) {
    this.#state = state;
    this.publish(state);
  }
}
