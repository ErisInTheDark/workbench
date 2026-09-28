/*
 * Exports:
 * - WorkbenchSearchHit: source-qualified selectable search result.
 * - WorkbenchSearchSnapshot: dialog intent, partial results and selection.
 * - default WorkbenchSearchController: own coalesced query interests, stale-result fencing and selection.
 */
import type {
  WorkbenchSearchResult,
} from "workbench-shared/workbench/search/workbench-search";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkspaceQuerySnapshot } from "../app/WorkbenchWorkspaceClient";

export type WorkbenchSearchHit = WorkbenchSearchResult & {
  logicalProjectId?: string;
  source?: ProjectLocationReference;
};

export interface WorkbenchSearchSnapshot {
  error: string | null;
  warning: string | null;
  isLoading: boolean;
  isOpen: boolean;
  projectId: string | null;
  query: string;
  results: readonly WorkbenchSearchHit[];
  selectedIndex: number;
}

type SearchTimer = number | ReturnType<typeof setTimeout>;

export default class WorkbenchSearchController {
  private disposed = false;
  private generation = 0;
  private release: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: SearchTimer | null = null;
  private snapshot: WorkbenchSearchSnapshot = {
    error: null,
    warning: null,
    isLoading: false,
    isOpen: false,
    projectId: null,
    query: "",
    results: [],
    selectedIndex: 0,
  };

  constructor(private readonly options: {
    activate?(result: WorkbenchSearchHit): void;
    clearTimeout?(timer: SearchTimer): void;
    observe(request: { projectId: string | null; query: string },
      publish: (snapshot: WorkspaceQuerySnapshot<"search">) => void): () => void;
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
    this.update({ error: null, warning: null, isLoading: true, isOpen: true, results: [], selectedIndex: 0 });
    this.schedule();
  }

  close() {
    if (!this.snapshot.isOpen) return;
    this.generation += 1;
    this.cancelTimer();
    this.releaseQuery();
    this.update({ isLoading: false, isOpen: false, results: [], selectedIndex: 0 });
  }

  setQuery(query: string) {
    if (this.disposed || query === this.snapshot.query) return;
    this.generation += 1;
    this.releaseQuery();
    this.update({ error: null, warning: null, isLoading: this.snapshot.isOpen, query, results: [], selectedIndex: 0 });
    this.schedule();
  }

  setProjectId(projectId: string | null) {
    if (this.disposed || projectId === this.snapshot.projectId) return;
    this.generation += 1;
    this.releaseQuery();
    this.update({ error: null, warning: null, isLoading: this.snapshot.isOpen, projectId, results: [], selectedIndex: 0 });
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

  activate(result: WorkbenchSearchHit) {
    if (this.disposed || !this.snapshot.isOpen || !this.snapshot.results.includes(result)) return;
    this.close();
    this.options.activate?.(result);
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.cancelTimer();
    this.releaseQuery();
    this.listeners.clear();
  }

  private schedule() {
    if (this.disposed || !this.snapshot.isOpen || this.timer !== null) return;
    const schedule = this.options.setTimeout ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      this.refresh();
    }, 80);
  }

  private refresh() {
    if (this.disposed || !this.snapshot.isOpen) return;
    const generation = this.generation;
    const request = { projectId: this.snapshot.projectId, query: this.snapshot.query };
    this.update({ error: null, isLoading: true });
    try {
      const release = this.options.observe(request, snapshot => {
        if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) return;
        const results = snapshot.value?.data.results.map(({ hit, ...owner }) => ({ ...hit, ...owner })) ?? [];
        const selected = this.snapshot.results[this.snapshot.selectedIndex]?.id;
        const selectedIndex = selected ? results.findIndex(result => result.id === selected) : 0;
        const pending = snapshot.value?.sources.some(source => source.phase === "pending" || source.phase === "stale");
        this.update({
          error: results.length ? null : snapshot.failure,
          warning: snapshot.value?.data.warning ?? (results.length ? snapshot.failure : null),
          isLoading: snapshot.phase === "pending" || pending === true,
          results, selectedIndex: Math.max(0, selectedIndex),
        });
      });
      if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) release();
      else this.release = release;
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

  private releaseQuery() {
    const release = this.release;
    this.release = null;
    release?.();
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
