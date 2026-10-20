/*
 * Exports:
 * - default WorkbenchThreadSnoozeController: own app thread snoozes across daemons: record each from the thread's current
 *   summary, publish the snooze set, watch every snoozed thread and dependent target, and wake them from current facts.
 */
import { ThreadReferenceSchema, WorkbenchThreadIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { isWorkbenchThreadSnoozeAvailable } from "workbench-shared/workbench/thread/thread-state";
import { ThreadSnooze } from "workbench-shared/workbench/thread/thread-snooze";
import type { LocatedThreadSummary } from "workbench-shared/workbench/thread/thread-summary";
import type { WorkbenchThreadSidebarThreadRow } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type WorkbenchDaemonSource from "../workspace/WorkbenchDaemonSource";
import type WorkbenchWorkspaceThreads from "../workspace/WorkbenchWorkspaceThreads";
import type WorkbenchPresentationController from "./WorkbenchPresentationController";

type Batch = ReturnType<WorkbenchDaemonSource["observe"]>;

export default class WorkbenchThreadSnoozeController {
  private readonly batches = new Map<DaemonId, Batch>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly cancellation = new AbortController();
  private snoozes: ReadonlyMap<string, ThreadSnooze> = new Map();
  private evaluating = false;
  private dirty = false;

  constructor(private readonly options: {
    sources: Pick<WorkbenchDaemonSources, "all" | "subscribe">;
    presentation: Pick<WorkbenchPresentationController, "read" | "mutate" | "subscribe">;
    threads: Pick<WorkbenchWorkspaceThreads, "withThread">;
    warn(message: string): void;
    canProject?(): boolean;
  }) {}

  start() {
    if (this.unsubscribe.length) return;
    this.unsubscribe.push(
      this.options.presentation.subscribe(() => this.evaluate()),
      this.options.sources.subscribe(() => this.evaluate()),
    );
    this.evaluate();
  }

  resumeProjection() { this.evaluate(); }

  dispose() {
    this.cancellation.abort();
    for (const stop of this.unsubscribe.splice(0)) stop();
    for (const batch of this.batches.values()) batch.release();
    this.batches.clear();
    this.listeners.clear();
  }

  /** Every snooze by thread id; changes only when the snooze set does. */
  read() { return this.snoozes; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A pending questionnaire's turn is interrupted first; the questionnaire stays and its leaving wakes the thread. */
  async snooze(threadId: string, snoozed: boolean, requestKey?: string) {
    const id = WorkbenchThreadIdSchema.parse(threadId);
    if (!snoozed) {
      this.write([], [id]);
      return true;
    }
    const row = (await this.readSummary(id))?.summary.row;
    if (row?.entryKind !== "thread" || !isWorkbenchThreadSnoozeAvailable(row)) return false;
    const question = row.pendingQuestionnaire?.requestKey ?? null;
    if (requestKey && requestKey !== question) return false;
    // Without a named questionnaire, only one the thread is plainly waiting on may be snoozed.
    if (question && !requestKey && !(row.lifecycle.kind === "needsAttention" && row.lifecycle.reason === "pendingInput"
      && row.lifecycle.requestKey === question)) return false;
    if (question) await this.options.threads.withThread(id, async source => {
      await source.daemon.threads.interrupt({ threadId: id, requestKey: question });
    }, this.cancellation.signal);
    this.write([{ threadId: id, basis: ThreadSnooze.capture(row, question), targets: [] }], []);
    return true;
  }

  /** Wait on `targetThreadId`, wherever it lives, or stop waiting on it. */
  async toggleTarget(threadId: string, targetThreadId: string) {
    const id = WorkbenchThreadIdSchema.parse(threadId);
    if (id === targetThreadId) return false;
    const [source, target] = await Promise.all([this.readSummary(id), this.readSummary(targetThreadId)]);
    const sourceRow = source?.summary.row;
    const targetRow = target?.summary.row;
    if (sourceRow?.entryKind !== "thread" || !ThreadSnooze.canWait(sourceRow)
      || targetRow?.entryKind !== "thread" || targetRow.metadata.archived) return false;
    const next = ThreadSnooze.toggleTarget(this.snoozes.get(id) ?? null, sourceRow, {
      identity: targetRow.identity, projectId: target!.projectId, title: targetRow.title,
    }, ThreadSnooze.isTargetReady(targetRow));
    this.write(next ? [next] : [], next ? [] : [id]);
    return true;
  }

  /** Unchanged writes are skipped, so waking an unsnoozed thread publishes nothing. */
  private write(put: ThreadSnooze[], wake: ThreadSnooze["threadId"][]) {
    const current = ThreadSnooze.byThread(this.options.presentation.read().threadSnoozes);
    const changedPut = put.filter(snooze => !areDeeplyEqual(current.get(snooze.threadId), snooze));
    const changedWake = wake.filter(threadId => current.has(threadId));
    if (!changedPut.length && !changedWake.length) return;
    this.options.presentation.mutate({ kind: "setThreadSnoozes", put: changedPut, wake: changedWake });
  }

  /** Re-runs until stable, since its own writes change the snooze set it reads. */
  private evaluate() {
    if (this.cancellation.signal.aborted || this.options.canProject?.() === false) return;
    this.dirty = true;
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        this.publish();
        this.observe();
        this.wakeDue();
      }
    } catch (error) {
      this.options.warn(`Thread snooze evaluation failed: ${error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure."}`);
    } finally { this.evaluating = false; }
  }

  private publish() {
    const next = ThreadSnooze.byThread(this.options.presentation.read().threadSnoozes);
    if (areDeeplyEqual([...next.values()], [...this.snoozes.values()])) return;
    this.snoozes = next;
    for (const listener of [...this.listeners]) listener();
  }

  private observe() {
    const threadIds = [...new Set([...this.snoozes.values()].flatMap(snooze =>
      [snooze.threadId, ...snooze.targets.map(target => target.identity.threadId)]))].sort()
      .map(id => ThreadReferenceSchema.parse(id));
    const query = { kind: "threadSummaries" as const, threadIds };
    const sources = threadIds.length ? this.options.sources.all() : [];
    for (const [daemonId, batch] of this.batches) {
      if (sources.some(source => source.id === daemonId)) continue;
      batch.release();
      this.batches.delete(daemonId);
    }
    for (const source of sources) {
      const existing = this.batches.get(source.id);
      try {
        if (existing) existing.retarget(query);
        else this.batches.set(source.id, source.observe(query, () => this.evaluate()));
      } catch {
        // Another observer shares this batch's previous ids; take a batch of our own for the new ones.
        existing?.release();
        this.batches.set(source.id, source.observe(query, () => this.evaluate()));
      }
    }
  }

  /**
   * Only rows a daemon actually reports decide anything: a thread no connected daemon holds may sit on one that is
   * offline, so its snooze or target keeps waiting rather than guessing it is gone.
   */
  private wakeDue() {
    const rows = new Map<string, WorkbenchThreadSidebarThreadRow>();
    const conflicts = new Set<string>();
    for (const batch of this.batches.values()) {
      const fact = batch.getSnapshot();
      if (fact.value?.kind !== "threadSummaries") continue;
      for (const [threadId, located] of Object.entries(fact.value.summaries)) {
        if (!located) continue;
        if (rows.has(threadId)) conflicts.add(threadId);
        rows.set(threadId, located.summary.row);
      }
    }
    for (const threadId of conflicts) rows.delete(threadId);
    const put: ThreadSnooze[] = [];
    const wake: ThreadSnooze["threadId"][] = [];
    for (const snooze of this.snoozes.values()) {
      const row = rows.get(snooze.threadId);
      if (row && ThreadSnooze.isWakeDue(snooze, row)) {
        wake.push(snooze.threadId);
        continue;
      }
      const targets = snooze.targets.filter(target => {
        const targetRow = rows.get(target.identity.threadId);
        return !targetRow || !ThreadSnooze.isTargetReady(targetRow);
      });
      if (targets.length === snooze.targets.length) continue;
      if (targets.length) put.push({ ...snooze, targets });
      else wake.push(snooze.threadId);
    }
    if (put.length || wake.length) this.write(put, wake);
  }

  /** The thread's current summary from the daemon that holds it. */
  private async readSummary(threadId: string) {
    return await this.options.threads.withThread(threadId, (source, owner) =>
      new Promise<LocatedThreadSummary | null>((resolve, reject) => {
        const signal = this.cancellation.signal;
        const id = ThreadReferenceSchema.parse(owner.identity.threadId);
        let batch: Batch | null = null;
        let done = false;
        const finish = (result: LocatedThreadSummary | null | Error) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", abort);
          queueMicrotask(() => batch?.release());
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Thread snooze is closing."));
        const check = () => {
          const fact = batch?.getSnapshot();
          if (!fact) return;
          if (fact.failure) finish(new Error(fact.failure));
          else if (fact.phase === "current" && fact.value?.kind === "threadSummaries" && id in fact.value.summaries) {
            finish(fact.value.summaries[id] ?? null);
          }
        };
        signal.addEventListener("abort", abort, { once: true });
        batch = source.observe({ kind: "threadSummaries", threadIds: [id] }, check);
        if (signal.aborted) abort();
        else check();
      }), this.cancellation.signal);
  }
}
