/*
 * Exports:
 * - WorkbenchStatsLoadState: complete stats-read presentation state. Keywords: stats, loading, error.
 * - default WorkbenchStatsLoadController: own latest-request fencing and single-flight background reads. Keywords: stats, lifecycle, refresh.
 */
import type {
  WorkbenchStatsReadRequest,
  WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";

export interface WorkbenchStatsLoadState {
  error: string;
  loading: boolean;
  stats: WorkbenchStatsResponse | null;
}

export default class WorkbenchStatsLoadController {
  private active = true;
  private background: Promise<void> | null = null;
  private queuedRequest: WorkbenchStatsReadRequest | null = null;
  private readonly listeners = new Set<() => void>();
  private requestId = 0;
  private snapshot: WorkbenchStatsLoadState = { error: "", loading: true, stats: null };

  constructor(private readonly read: (request: WorkbenchStatsReadRequest) => Promise<WorkbenchStatsResponse>) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(request: WorkbenchStatsReadRequest, foreground = true) {
    const currentRequestId = ++this.requestId;
    if (foreground) this.install({ error: "", loading: true, stats: null });
    try {
      const stats = await this.read(request);
      if (this.active && currentRequestId === this.requestId) this.install({ error: "", loading: false, stats });
    } catch (error) {
      if (this.active && currentRequestId === this.requestId) {
        this.install({
          error: error instanceof Error ? error.message : "Unable to load usage statistics.",
          loading: false,
          stats: foreground ? null : this.snapshot.stats,
        });
      }
    }
  }

  refresh(request: WorkbenchStatsReadRequest) {
    this.queuedRequest = request;
    if (this.background) return this.background;
    this.background = this.runBackground().finally(() => { this.background = null; });
    return this.background;
  }

  dispose() {
    this.active = false;
    this.requestId += 1;
    this.queuedRequest = null;
    this.listeners.clear();
  }

  private async runBackground() {
    while (this.active && this.queuedRequest) {
      const request = this.queuedRequest;
      this.queuedRequest = null;
      await this.load(request, false);
    }
  }

  private install(snapshot: WorkbenchStatsLoadState) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
