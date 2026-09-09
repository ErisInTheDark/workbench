/*
 * Keywords: search, controller, single-flight, freshness, lifecycle.
 * Exports:
 * - WorkbenchSearchSnapshot: complete dialog/query/result lifecycle state. Keywords: search, state, lifecycle.
 * - default WorkbenchSearchController: owns coalescing, single-flight requests, freshness, selection, activation, and disposal.
 */
import type {
  WorkbenchSearchResponse,
  WorkbenchSearchResult,
} from "workbench-shared/workbench/search/workbench-search";

export interface WorkbenchSearchSnapshot {
  error: string | null;
  isLoading: boolean;
  isOpen: boolean;
  projectId: string | null;
  query: string;
  results: readonly WorkbenchSearchResult[];
  selectedIndex: number;
}

type SearchTimer = number | ReturnType<typeof setTimeout>;

export default class WorkbenchSearchController {
  private disposed = false;
  private generation = 0;
  private activeGeneration: number | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: SearchTimer | null = null;
  private snapshot: WorkbenchSearchSnapshot = {
    error: null,
    isLoading: false,
    isOpen: false,
    projectId: null,
    query: "",
    results: [],
    selectedIndex: 0,
  };

  constructor(private readonly options: {
    activate?(result: WorkbenchSearchResult): void;
    clearTimeout?(timer: SearchTimer): void;
    request(request: { projectId: string | null; query: string }): Promise<WorkbenchSearchResponse>;
    setTimeout?(callback: () => void, delay: number): SearchTimer;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open() {
    if (this.disposed || this.snapshot.isOpen) return;
    this.generation += 1;
    this.update({ error: null, isLoading: true, isOpen: true, results: [], selectedIndex: 0 });
    this.schedule();
  }

  close() {
    if (!this.snapshot.isOpen) return;
    this.generation += 1;
    this.cancelTimer();
    this.update({ isLoading: false, isOpen: false, results: [], selectedIndex: 0 });
  }

  setQuery(query: string) {
    if (this.disposed || query === this.snapshot.query) return;
    this.generation += 1;
    this.update({ error: null, isLoading: this.snapshot.isOpen, query, results: [], selectedIndex: 0 });
    this.schedule();
  }

  setProjectId(projectId: string | null) {
    if (this.disposed || projectId === this.snapshot.projectId) return;
    this.generation += 1;
    this.update({ error: null, isLoading: this.snapshot.isOpen, projectId, results: [], selectedIndex: 0 });
    if (this.snapshot.isOpen) this.schedule();
  }

  moveSelection(delta: number) {
    const maximum = Math.max(0, this.snapshot.results.length - 1);
    this.update({ selectedIndex: Math.max(0, Math.min(maximum, this.snapshot.selectedIndex + delta)) });
  }

  activateSelected() {
    const result = this.snapshot.results[this.snapshot.selectedIndex] ?? this.snapshot.results[0];
    if (!result || !this.snapshot.isOpen || this.disposed) return false;
    this.activate(result);
    return true;
  }

  activate(result: WorkbenchSearchResult) {
    if (this.disposed || !this.snapshot.isOpen || !this.snapshot.results.includes(result)) return;
    this.close();
    this.options.activate?.(result);
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.cancelTimer();
    this.listeners.clear();
  }

  private schedule() {
    if (this.disposed || !this.snapshot.isOpen || this.timer !== null || this.activeGeneration !== null) return;
    const schedule = this.options.setTimeout ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      void this.refresh();
    }, 80);
  }

  private async refresh() {
    if (this.disposed || !this.snapshot.isOpen || this.activeGeneration !== null) return;
    const generation = this.generation;
    this.activeGeneration = generation;
    const request = { projectId: this.snapshot.projectId, query: this.snapshot.query };
    this.update({ error: null, isLoading: true });
    try {
      const response = await this.options.request(request);
      if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) return;
      this.update({ isLoading: false, results: response.results, selectedIndex: 0 });
    } catch (error) {
      if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) return;
      this.update({
        error: error instanceof Error ? error.message : "Search failed.",
        isLoading: false,
        results: [],
        selectedIndex: 0,
      });
    } finally {
      this.activeGeneration = null;
      if (generation !== this.generation) this.schedule();
    }
  }

  private cancelTimer() {
    if (this.timer === null) return;
    (this.options.clearTimeout ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private update(patch: Partial<WorkbenchSearchSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
