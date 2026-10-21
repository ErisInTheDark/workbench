/*
 * Exports:
 * - WorkbenchSearchHit: source-qualified selectable search result; `.threadRoute` opens a thread hit by its found owner.
 * - WorkbenchSearchSummaries: the thread summary leases search waits on before showing thread rows.
 * - WORKBENCH_SEARCH_FILTERS: the kind filters in display and cycling order; null is every kind.
 * - WorkbenchSearchSnapshot: dialog intent, filters, the shown result set and selection.
 * - default WorkbenchSearchController: own query intent and the shown result set: earlier results stay up (stale) until the
 *   next set is complete with its thread summaries, or a short deadline passes; later arrivals join without reordering.
 */
import type {
  WorkbenchSearchCorrection, WorkbenchSearchKind, WorkbenchSearchRequest, WorkbenchSearchResult,
} from "workbench-shared/workbench/search/workbench-search";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { createLogicalThreadRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type { WorkspaceThreadSummary } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkspaceQuerySnapshot } from "../app/WorkbenchWorkspaceClient";

export type WorkbenchSearchHit = WorkbenchSearchResult & {
  logicalProjectId?: string;
  source?: ProjectLocationReference;
};

export const WorkbenchSearchHit = {
  /**
   * A thread hit's route, qualified by the owner and folder the search found it in, as sidebar rows are: most hits are
   * threads the client has never listed, so the navigator cannot look their owner up. Null for hits outside any project.
   */
  threadRoute(hit: Extract<WorkbenchSearchHit, { kind: "thread" }>): WorkbenchRoute | null {
    if (!hit.logicalProjectId || !hit.source) return null;
    return createLogicalThreadRoute(null, hit.logicalProjectId, hit.source, {
      kind: "provider", harness: WorkbenchHarnessSchema.parse(hit.harnessId), threadId: ThreadReferenceSchema.parse(hit.threadId),
    });
  },
};

export interface WorkbenchSearchSummaries {
  subscribe(threadId: string, listener: () => void): () => void;
  /** Whether the thread's summary is known, including known to be missing. */
  has(threadId: string): boolean;
  get(threadId: string): WorkspaceThreadSummary | null;
}

export const WORKBENCH_SEARCH_FILTERS: readonly (WorkbenchSearchKind | null)[] = [null, "thread", "file", "project", "projectSetting", "action"];

export interface WorkbenchSearchSnapshot {
  corrections: readonly WorkbenchSearchCorrection[];
  error: string | null;
  isLoading: boolean;
  isOpen: boolean;
  kind: WorkbenchSearchKind | null;
  projectId: string | null;
  projectOnly: boolean;
  query: string;
  results: readonly WorkbenchSearchHit[];
  selectedIndex: number;
  /** The shown results answer an earlier query or filter; they stay visible but cannot be activated. */
  stale: boolean;
  /** Bumps when a shown thread's summary changes, so rows re-read it. */
  summaryRevision: number;
}

type SearchTimer = number | ReturnType<typeof setTimeout>;
type Incoming = { complete: boolean; corrections: readonly WorkbenchSearchCorrection[]; error: string | null;
  results: readonly WorkbenchSearchHit[] };

const QUERY_DEBOUNCE_MS = 80;
/** Longest a new query waits for slow sources and thread summaries before showing what it has. */
export const SEARCH_DISPLAY_DEADLINE_MS = 350;

/** Shown rows keep their places; arrivals join the end of their kind's section, new kinds after the rest. */
function joinStable(shown: readonly WorkbenchSearchHit[], incoming: readonly WorkbenchSearchHit[]) {
  const incomingById = new Map(incoming.map(hit => [hit.id, hit]));
  const kinds = [...new Set([...shown, ...incoming].map(hit => hit.kind))];
  return kinds.flatMap(kind => [
    ...shown.flatMap(hit => hit.kind === kind && incomingById.has(hit.id) ? [incomingById.get(hit.id)!] : []),
    ...incoming.filter(hit => hit.kind === kind && !shown.some(item => item.id === hit.id)),
  ]);
}

export default class WorkbenchSearchController {
  private activationHandler: ((result: WorkbenchSearchHit) => void) | null = null;
  private disposed = false;
  private generation = 0;
  /** The generation whose results are on screen; later arrivals for it join without reordering. */
  private shownGeneration = -1;
  private release: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly leases = new Map<string, () => void>();
  private incoming: Incoming | null = null;
  private deadlinePassed = false;
  private activateWhenShown = false;
  private debounce: SearchTimer | null = null;
  private deadline: SearchTimer | null = null;
  private snapshot: WorkbenchSearchSnapshot = {
    corrections: [],
    error: null,
    isLoading: false,
    isOpen: false,
    kind: null,
    projectId: null,
    projectOnly: false,
    query: "",
    results: [],
    selectedIndex: 0,
    stale: false,
    summaryRevision: 0,
  };

  constructor(private readonly options: {
    clearTimeout?(timer: SearchTimer): void;
    observe(request: WorkbenchSearchRequest,
      publish: (snapshot: WorkspaceQuerySnapshot<"search">) => void): () => void;
    setTimeout?(callback: () => void, delay: number): SearchTimer;
    summaries?: WorkbenchSearchSummaries | null;
  }) {}

  getSnapshot = () => this.snapshot;
  /** A shown thread hit's summary, leased while the hit is shown or about to be. */
  readSummary = (threadId: string) => this.options.summaries?.get(threadId) ?? null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open() {
    if (this.disposed || this.snapshot.isOpen) return;
    this.update({ corrections: [], error: null, isOpen: true, results: [], selectedIndex: 0, stale: false });
    this.restart();
  }

  close() {
    if (!this.snapshot.isOpen) return;
    this.generation += 1;
    this.cancelTimers();
    this.releaseQuery();
    this.incoming = null;
    this.activateWhenShown = false;
    this.lease([]);
    this.update({ isLoading: false, isOpen: false, results: [], selectedIndex: 0, stale: false });
  }

  setQuery(query: string) {
    if (this.disposed || query === this.snapshot.query) return;
    this.update({ query });
    this.restart();
  }

  setKind(kind: WorkbenchSearchKind | null) {
    if (this.disposed || kind === this.snapshot.kind) return;
    this.update({ kind });
    this.restart(false);
  }

  /** Step through the kind filters, wrapping at either end. */
  cycleKind(delta: number) {
    const index = WORKBENCH_SEARCH_FILTERS.indexOf(this.snapshot.kind);
    const count = WORKBENCH_SEARCH_FILTERS.length;
    this.setKind(WORKBENCH_SEARCH_FILTERS[(index + delta + count) % count] ?? null);
  }

  setProjectOnly(projectOnly: boolean) {
    if (this.disposed || projectOnly === this.snapshot.projectOnly) return;
    this.update({ projectOnly });
    if (this.snapshot.projectId) this.restart(false);
  }

  setProjectId(projectId: string | null) {
    if (this.disposed || projectId === this.snapshot.projectId) return;
    this.update({ projectId });
    this.restart(false);
  }

  moveSelection(delta: number) {
    const maximum = Math.max(0, this.snapshot.results.length - 1);
    this.update({ selectedIndex: Math.max(0, Math.min(maximum, this.snapshot.selectedIndex + delta)) });
  }

  /** Opens the selection; while the shown rows are stale, opens the first fresh result once it arrives. */
  activateSelected() {
    if (!this.snapshot.isOpen || this.disposed) return false;
    if (this.snapshot.stale || (this.snapshot.isLoading && !this.snapshot.results.length)) {
      this.activateWhenShown = true;
      return true;
    }
    const result = this.snapshot.results[this.snapshot.selectedIndex] ?? this.snapshot.results[0];
    if (!result) return false;
    this.activate(result);
    return true;
  }

  activate(result: WorkbenchSearchHit) {
    if (this.disposed || !this.snapshot.isOpen || this.snapshot.stale || !this.snapshot.results.includes(result)) return;
    this.close();
    this.activationHandler?.(result);
  }

  /** Route activated results to one handler; the latest registration wins until it unregisters. */
  onActivate(handler: (result: WorkbenchSearchHit) => void) {
    this.activationHandler = handler;
    return () => {
      if (this.activationHandler === handler) this.activationHandler = null;
    };
  }

  dispose() {
    this.disposed = true;
    this.activationHandler = null;
    this.generation += 1;
    this.cancelTimers();
    this.releaseQuery();
    this.lease([]);
    this.listeners.clear();
  }

  /** New intent: shown rows go stale, and typing waits a beat before asking while filter changes ask at once. */
  private restart(debounced = true) {
    this.generation += 1;
    this.cancelTimers();
    this.releaseQuery();
    this.incoming = null;
    this.deadlinePassed = false;
    this.activateWhenShown = false;
    if (!this.snapshot.isOpen) return;
    this.update({ error: null, isLoading: true, selectedIndex: 0, stale: this.snapshot.results.length > 0 });
    if (!debounced) {
      this.request();
      return;
    }
    const schedule = this.options.setTimeout ?? setTimeout;
    this.debounce = schedule(() => {
      this.debounce = null;
      this.request();
    }, QUERY_DEBOUNCE_MS);
  }

  private request() {
    if (this.disposed || !this.snapshot.isOpen) return;
    const generation = this.generation;
    const { kind, projectId, projectOnly, query } = this.snapshot;
    const request: WorkbenchSearchRequest = {
      projectId, query,
      ...(kind ? { kinds: [kind] } : {}),
      ...(projectOnly && projectId ? { projectOnly: true } : {}),
    };
    const schedule = this.options.setTimeout ?? setTimeout;
    this.deadline = schedule(() => {
      this.deadline = null;
      if (generation !== this.generation) return;
      this.deadlinePassed = true;
      this.settle();
    }, SEARCH_DISPLAY_DEADLINE_MS);
    try {
      const release = this.options.observe(request, snapshot => {
        if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) return;
        const pending = snapshot.phase === "pending"
          || snapshot.value?.sources.some(source => source.phase === "pending" || source.phase === "stale") === true;
        const results = snapshot.value?.data.results.map(({ hit, ...owner }) => ({ ...hit, ...owner })) ?? [];
        this.incoming = {
          complete: !pending,
          corrections: snapshot.value?.data.corrections ?? [],
          error: snapshot.phase === "failed" && !results.length ? snapshot.failure ?? "Search failed." : null,
          results,
        };
        this.settle();
      });
      if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) release();
      else this.release = release;
    } catch (error) {
      if (this.disposed || generation !== this.generation || !this.snapshot.isOpen) return;
      this.incoming = { complete: true, corrections: [], error: error instanceof Error ? error.message : "Search failed.", results: [] };
      this.deadlinePassed = true;
      this.settle();
    }
  }

  /** Show the incoming set once it is complete and its thread rows can render fully, or once the deadline passed. */
  private settle() {
    const incoming = this.incoming;
    this.lease([...this.snapshot.results, ...incoming?.results ?? []]);
    if (!incoming) return;
    const summaries = this.options.summaries;
    const rowsReady = !summaries || incoming.results.every(hit => hit.kind !== "thread" || summaries.has(hit.threadId));
    const showing = this.shownGeneration === this.generation;
    if (!showing && !this.deadlinePassed && !(incoming.complete && rowsReady)) {
      this.update({ isLoading: true });
      return;
    }
    const selected = showing ? this.snapshot.results[this.snapshot.selectedIndex]?.id : undefined;
    const results = showing ? joinStable(this.snapshot.results, incoming.results) : incoming.results;
    const selectedIndex = selected ? Math.max(0, results.findIndex(hit => hit.id === selected)) : 0;
    this.shownGeneration = this.generation;
    this.update({
      corrections: incoming.corrections, error: incoming.error,
      isLoading: !incoming.complete, results, selectedIndex, stale: false,
    });
    this.lease(results);
    if (this.activateWhenShown && (incoming.complete || results.length)) {
      this.activateWhenShown = false;
      const first = results[0];
      if (first) this.activate(first);
    }
  }

  /** Hold summary leases for exactly these thread hits. */
  private lease(hits: readonly WorkbenchSearchHit[]) {
    const summaries = this.options.summaries;
    if (!summaries) return;
    const wanted = new Set(hits.flatMap(hit => hit.kind === "thread" ? [hit.threadId] : []));
    for (const [threadId, release] of this.leases) {
      if (wanted.has(threadId)) continue;
      release();
      this.leases.delete(threadId);
    }
    for (const threadId of wanted) {
      if (this.leases.has(threadId)) continue;
      this.leases.set(threadId, summaries.subscribe(threadId, () => this.summaryChanged(threadId)));
    }
  }

  private summaryChanged(threadId: string) {
    if (this.disposed || !this.leases.has(threadId)) return;
    if (this.snapshot.results.some(hit => hit.kind === "thread" && hit.threadId === threadId)) {
      this.update({ summaryRevision: this.snapshot.summaryRevision + 1 });
    }
    if (this.shownGeneration !== this.generation) this.settle();
  }

  private releaseQuery() {
    const release = this.release;
    this.release = null;
    release?.();
  }

  private cancelTimers() {
    const clear = this.options.clearTimeout ?? clearTimeout;
    if (this.debounce !== null) clear(this.debounce as ReturnType<typeof setTimeout>);
    if (this.deadline !== null) clear(this.deadline as ReturnType<typeof setTimeout>);
    this.debounce = null;
    this.deadline = null;
  }

  private update(patch: Partial<WorkbenchSearchSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
