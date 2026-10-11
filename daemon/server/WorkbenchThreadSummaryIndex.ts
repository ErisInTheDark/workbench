/*
 * Exports:
 * - WorkbenchThreadSummaryIndexPorts: thread ownership, project snapshots and live-fact seeds the index reads.
 * - default WorkbenchThreadSummaryIndex: own every read thread's canonical summary (lean row plus live facts) located in its owner project, announcing each thread whose summary changed.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { createThreadSummary, type LocatedThreadSummary, type ThreadSummaryFacts } from "workbench-shared/workbench/thread/thread-summary";

type ThreadEntry = Exclude<WorkbenchThreadSidebarSnapshot["entries"][number], { entryKind: "draft" }>;

export interface WorkbenchThreadSummaryIndexPorts {
  /** The project a thread belongs to, or null for a thread this daemon does not know. */
  resolveProject(threadId: string): Promise<ProjectId | null>;
  peekProject(projectId: ProjectId): WorkbenchThreadSidebarSnapshot | null;
  readProject(projectId: ProjectId): Promise<WorkbenchThreadSidebarSnapshot>;
  subscribeProjects(listener: (projectId: ProjectId) => void): () => void;
  /** Every thread's required todo count, read once; later counts arrive through `setRequiredTodoCount`. */
  readRequiredTodoCounts(): Promise<ReadonlyMap<string, number>>;
  warn(message: string): void;
}

export default class WorkbenchThreadSummaryIndex {
  /** Owner project of every thread read so far; only these threads follow project changes. */
  private readonly owners = new Map<string, ProjectId>();
  private readonly entries = new Map<string, ThreadEntry>();
  private readonly facts = new Map<string, ThreadSummaryFacts>();
  /** One located summary object per thread until it changes, so unchanged summaries diff as identical. */
  private readonly summaries = new Map<string, LocatedThreadSummary>();
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly stop: () => void;
  private readonly seeded: Promise<void>;
  private disposed = false;

  constructor(private readonly ports: WorkbenchThreadSummaryIndexPorts) {
    this.stop = ports.subscribeProjects(projectId => this.projectChanged(projectId));
    this.seeded = ports.readRequiredTodoCounts().then(counts => {
      for (const [threadId, requiredTodoCount] of counts) {
        // A todo change during the seed read is newer than the seed.
        if (this.facts.get(threadId)?.requiredTodoCount === undefined) this.setFact(threadId, { requiredTodoCount });
      }
    }, error => {
      ports.warn(`Thread todo counts could not be read: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
    });
  }

  subscribe(listener: (threadId: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The thread's summary and owner project when it has been read; null otherwise. */
  peek(threadId: string): LocatedThreadSummary | null {
    const cached = this.summaries.get(threadId);
    if (cached) return cached;
    const entry = this.entries.get(threadId);
    const projectId = this.owners.get(threadId);
    if (!entry || !projectId) return null;
    const located = { projectId, summary: createThreadSummary(entry, this.facts.get(threadId) ?? {}) };
    this.summaries.set(threadId, located);
    return located;
  }

  /** Reads the thread's owner project once; null for a thread this daemon does not hold. */
  async read(threadId: string): Promise<LocatedThreadSummary | null> {
    await this.seeded;
    const known = this.peek(threadId);
    if (known || this.disposed) return known;
    const projectId = this.owners.get(threadId) ?? await this.ports.resolveProject(threadId);
    if (!projectId || this.disposed) return null;
    const snapshot = this.ports.peekProject(projectId) ?? await this.ports.readProject(projectId);
    if (this.disposed) return null;
    this.owners.set(threadId, projectId);
    const entry = findThread(snapshot, threadId);
    if (entry) this.entries.set(threadId, entry);
    return this.peek(threadId);
  }

  setCompacting(threadId: string, compacting: boolean) {
    this.setFact(threadId, { compacting });
  }

  setRequiredTodoCount(threadId: string, requiredTodoCount: number) {
    this.setFact(threadId, { requiredTodoCount });
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  private setFact(threadId: string, patch: ThreadSummaryFacts) {
    const current = this.facts.get(threadId) ?? {};
    const next = { ...current, ...patch };
    if (areDeeplyEqual(current, next)) return;
    this.facts.set(threadId, next);
    this.changed(threadId);
  }

  /** Threads already read follow their project; a thread that left it reads as unknown. */
  private projectChanged(projectId: ProjectId) {
    const snapshot = this.ports.peekProject(projectId);
    if (!snapshot) return;
    for (const [threadId, owner] of this.owners) {
      if (owner !== projectId) continue;
      const entry = findThread(snapshot, threadId);
      const previous = this.entries.get(threadId);
      if (entry ? previous && areDeeplyEqual(createThreadSummary(previous, {}).row, createThreadSummary(entry, {}).row) : !previous) continue;
      if (entry) this.entries.set(threadId, entry);
      else this.entries.delete(threadId);
      this.changed(threadId);
    }
  }

  private changed(threadId: string) {
    this.summaries.delete(threadId);
    // Unread threads keep their facts for their first read; nobody observes them yet.
    if (!this.owners.has(threadId)) return;
    for (const listener of this.listeners) {
      try { listener(threadId); }
      catch (error) { this.ports.warn(`Thread summary listener failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`); }
    }
  }
}

function findThread(snapshot: WorkbenchThreadSidebarSnapshot, threadId: string) {
  return snapshot.entries.find((entry): entry is ThreadEntry => entry.entryKind !== "draft" && entry.identity.threadId === threadId) ?? null;
}
