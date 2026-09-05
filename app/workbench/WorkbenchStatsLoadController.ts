/*
 * Exports:
 * - WorkbenchStatsLoadState: complete stats-read presentation state. Keywords: stats, loading, error.
 * - default WorkbenchStatsLoadController: own latest-request fencing and single-flight background reads. Keywords: stats, lifecycle, refresh.
 */
import type {
  WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import { STATS_TOKEN_TYPES, type WorkbenchStatsDetailedReadRequest } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";

export interface WorkbenchStatsLoadState {
  error: string;
  loading: boolean;
  stats: WorkbenchStatsResponse | null;
  displayedRequest: WorkbenchStatsDetailedReadRequest | null;
}

function sameRequest(left: WorkbenchStatsDetailedReadRequest | null, right: WorkbenchStatsDetailedReadRequest) {
  return left !== null && left.projectId === right.projectId && left.range === right.range
    && (left.provider ?? null) === (right.provider ?? null) && (left.model ?? null) === (right.model ?? null)
    && STATS_TOKEN_TYPES.every((type) => (left.tokenTypes ?? STATS_TOKEN_TYPES).includes(type) === (right.tokenTypes ?? STATS_TOKEN_TYPES).includes(type));
}

export default class WorkbenchStatsLoadController {
  private active = true;
  private flight: Promise<void> | null = null;
  private desiredRequest: WorkbenchStatsDetailedReadRequest | null = null;
  private pending = false;
  private readonly listeners = new Set<() => void>();
  private requestId = 0;
  private snapshot: WorkbenchStatsLoadState = { error: "", loading: true, stats: null, displayedRequest: null };

  constructor(private readonly read: (request: WorkbenchStatsDetailedReadRequest) => Promise<WorkbenchStatsResponse>) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  load(request: WorkbenchStatsDetailedReadRequest) {
    if (!this.active) return Promise.resolve();
    if (!sameRequest(this.desiredRequest, request)) this.requestId += 1;
    this.desiredRequest = request;
    return this.enqueue();
  }

  refresh(request?: WorkbenchStatsDetailedReadRequest) {
    if (!this.active) return Promise.resolve();
    if (!this.desiredRequest && request) return this.load(request);
    return this.desiredRequest ? this.enqueue() : Promise.resolve();
  }

  dispose() {
    this.active = false;
    this.requestId += 1;
    this.pending = false;
    this.listeners.clear();
  }

  private enqueue() {
    this.pending = true;
    this.flight ??= Promise.resolve().then(() => this.drain());
    this.install({ ...this.snapshot, loading: true });
    return this.flight;
  }

  private async drain() {
    while (this.active && this.pending && this.desiredRequest) {
      const request = this.desiredRequest;
      const id = this.requestId;
      this.pending = false;
      try {
        const stats = await this.read(request);
        if (this.active && id === this.requestId) {
          this.install({ error: "", loading: this.pending, stats, displayedRequest: request });
        }
      } catch (error) {
        if (this.active && id === this.requestId) {
          this.install({
            ...this.snapshot,
            error: error instanceof Error ? error.message : "Unable to load usage statistics.",
            loading: this.pending,
          });
        }
      }
    }
    // Release before a result listener's queued microtask can request another read.
    this.flight = null;
  }

  private install(snapshot: WorkbenchStatsLoadState) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
