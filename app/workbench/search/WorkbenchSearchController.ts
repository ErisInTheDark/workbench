/*
 * Exports:
 * - WorkbenchSearchSnapshot: complete dialog/query/result lifecycle state. Keywords: search, state, lifecycle.
 * - default WorkbenchSearchController: owns debounce, request freshness, selection, activation, and disposal. Keywords: search, controller, debounce.
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
    this.update({ isOpen: true });
    this.schedule();
  }

  close() {
    if (!this.snapshot.isOpen) return;
    this.generation += 1;
    this.cancelTimer();
    this.update({ isLoading: false, isOpen: false });
  }

  setQuery(query: string) {
    if (this.disposed || query === this.snapshot.query) return;
    this.generation += 1;
    this.update({ error: null, query, selectedIndex: 0 });
    this.schedule();
  }

  setProjectId(projectId: string | null) {
    if (this.disposed || projectId === this.snapshot.projectId) return;
    this.generation += 1;
    this.update({ projectId, selectedIndex: 0 });
    if (this.snapshot.isOpen) this.schedule();
  }

  moveSelection(delta: number) {
    const maximum = Math.max(0, this.snapshot.results.length - 1);
    this.update({ selectedIndex: Math.max(0, Math.min(maximum, this.snapshot.selectedIndex + delta)) });
  }

  activateSelected() {
    const result = this.snapshot.results[this.snapshot.selectedIndex] ?? this.snapshot.results[0];
    if (!result) return false;
    this.close();
    this.options.activate?.(result);
    return true;
  }

  activate(result: WorkbenchSearchResult) {
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
    if (this.timer !== null) return;
    const schedule = this.options.setTimeout ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      void this.refresh();
    }, 80);
  }

  private async refresh() {
    if (this.disposed || !this.snapshot.isOpen) return;
    const generation = ++this.generation;
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
