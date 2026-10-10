/*
 * Exports:
 * - ThreadSummaryStoreWorkspace: the workspace observation boundary the store batches through.
 * - default ThreadSummaryStore: lease per-thread summaries for every mounted thread display, batched into one retargeted `threadSummaries` observation.
 */
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkspaceQuery, WorkspaceThreadSummary } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkspaceQueryHandle } from "../app/WorkbenchWorkspaceClient";

type Query = Extract<WorkspaceQuery, { kind: "threadSummaries" }>;
export interface ThreadSummaryStoreWorkspace {
  observe(query: Query, listener: () => void): WorkspaceQueryHandle<"threadSummaries">;
}

export default class ThreadSummaryStore {
  private readonly demands = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private handle: WorkspaceQueryHandle<"threadSummaries"> | null = null;
  private requested: readonly string[] = [];
  private values: Readonly<Record<string, WorkspaceThreadSummary | null>> = {};
  private flushQueued = false;
  private disposed = false;

  constructor(private readonly workspace: ThreadSummaryStoreWorkspace) {}

  /** Leases one thread's summary until the returned release; leases in the same task share one retarget. */
  subscribe(threadId: string, listener: () => void) {
    this.demands.set(threadId, (this.demands.get(threadId) ?? 0) + 1);
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    this.queueFlush();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(threadId);
      const count = this.demands.get(threadId) ?? 0;
      if (count <= 1) this.demands.delete(threadId);
      else this.demands.set(threadId, count - 1);
      this.queueFlush();
    };
  }

  /** The thread's located summary; null while it is unknown, pending, or not leased. */
  get(threadId: string): WorkspaceThreadSummary | null {
    return this.values[threadId] ?? null;
  }

  dispose() {
    this.disposed = true;
    this.handle?.release();
    this.handle = null;
    this.listeners.clear();
    this.demands.clear();
  }

  private queueFlush() {
    if (this.flushQueued || this.disposed) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** One coalesced batch per task: open on the first lease, retarget as leases move, release when none remain. */
  private flush() {
    if (this.disposed) return;
    const threadIds = [...this.demands.keys()].sort();
    if (threadIds.length === this.requested.length && threadIds.every((id, index) => id === this.requested[index])) return;
    this.requested = threadIds;
    if (!threadIds.length) {
      this.handle?.release();
      this.handle = null;
      this.accept();
      return;
    }
    // Displays lease whatever id they hold; only real thread references reach the batch.
    const query: Query = { kind: "threadSummaries", threadIds: threadIds.flatMap(id => {
      const parsed = ThreadReferenceSchema.safeParse(id);
      return parsed.success ? [parsed.data] : [];
    }) };
    if (this.handle) this.handle.retarget(query);
    else this.handle = this.workspace.observe(query, () => this.accept());
    this.accept();
  }

  /** Notifies only the threads whose summary object changed; unchanged summaries keep their identity across deltas. */
  private accept() {
    const next = this.handle?.getSnapshot().value?.data ?? {};
    const previous = this.values;
    if (next === previous) return;
    this.values = next;
    const changed = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const threadId of changed) {
      if (previous[threadId] === next[threadId]) continue;
      for (const listener of [...this.listeners.get(threadId) ?? []]) listener();
    }
  }
}
