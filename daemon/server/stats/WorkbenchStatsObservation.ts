/*
 * Exports:
 * - WorkbenchStatsObservationState: one published stats section with its refinement freshness.
 * - WorkbenchStatsInvalidation: which facts changed; claims also re-walk rename history.
 * - default WorkbenchStatsObservation: own one section's coalesced reads (two-stage for claims), publication, and release.
 */
import type { WorkbenchStatsReadRequest, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchClaimRenameRead } from "./WorkbenchClaimRenameController.ts";

export interface WorkbenchStatsObservationState {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  /** Pending while published data is provisional; only claim hotspots refine (once rename history merges). */
  refinement: WorkspaceSourcePhase;
  data: WorkbenchStatsResponse | null;
}

export type WorkbenchStatsInvalidation = "usage" | "claims";

const NO_RENAMES: WorkbenchClaimRenameRead = { renames: [], failures: [] };

function failureMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Statistics could not be read.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 500);
}

/**
 * A section publishes as soon as it is read. Claim hotspots publish first from known rename history, then again once
 * history is re-walked. Invalidations during a read collapse into one follow-up read, and only claim changes re-walk Git history.
 */
export default class WorkbenchStatsObservation {
  #state: WorkbenchStatsObservationState = { phase: "pending", failure: null, refinement: "pending", data: null };
  #dirty = { usage: true, claims: true };
  #history: WorkbenchClaimRenameRead | null = null;
  #work: Promise<void> | null = null;
  #released = false;
  /** Aborted on release, so reads still waiting for a database reader are dropped instead of run for nobody. */
  readonly #lifetime = new AbortController();

  constructor(
    private readonly request: WorkbenchStatsReadRequest,
    private readonly owner: {
      read(request: WorkbenchStatsReadRequest, history: WorkbenchClaimRenameRead, signal: AbortSignal): Promise<WorkbenchStatsResponse>;
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

  release() {
    this.#released = true;
    this.#lifetime.abort(new Error("The statistics observation was released."));
  }

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
    const refines = this.request.section === "claims";
    while (!this.#released && (this.#dirty.usage || this.#dirty.claims)) {
      const walkClaims = refines && (this.#dirty.claims || !this.#history);
      this.#dirty = { usage: false, claims: false };
      try {
        const known = this.#history ?? NO_RENAMES;
        const first = await this.owner.read(this.request, known, this.#lifetime.signal);
        if (this.#released) return;
        this.#update({ phase: "current", failure: null, refinement: walkClaims ? "pending" : this.#refinement(known), data: first });
        if (!walkClaims) continue;
        const history = await this.owner.readRenames(this.request);
        if (this.#released) return;
        this.#history = history;
        // Without renames or failures the first read already counted claims correctly.
        const complete = history.renames.length || history.failures.length ? await this.owner.read(this.request, history, this.#lifetime.signal) : first;
        if (this.#released) return;
        this.#update({ phase: "current", failure: null, refinement: this.#refinement(history), data: complete });
      } catch (error) {
        // Release aborts queued reads; their rejection is expected and has no reader left to tell.
        if (this.#released) return;
        const failure = failureMessage(error);
        this.owner.warn(`Statistics observation failed: ${failure}`);
        const data = this.#state.data;
        this.#update({ phase: data ? "stale" : "failed", failure, refinement: data ? "stale" : "failed", data });
      }
    }
  }

  #refinement(history: WorkbenchClaimRenameRead): WorkspaceSourcePhase {
    return history.failures.length ? "stale" : "current";
  }

  #update(state: WorkbenchStatsObservationState) {
    this.#state = state;
    this.publish(state);
  }
}
