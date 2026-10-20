/*
 * Exports:
 * - default WorkbenchThreadPlacementController: own app thread pins and snoozes across daemons: record each from the
 *   thread's current summary, publish the placement, watch every pinned, snoozed and dependent-target thread, wake
 *   snoozes and drop archived pins from current facts, and expose the watched pinned rows for project summaries.
 */
import {
  ThreadReferenceSchema, WorkbenchThreadIdSchema, type DaemonId, type ProjectId, type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { isWorkbenchThreadSnoozeAvailable } from "workbench-shared/workbench/thread/thread-state";
import ThreadPlacement from "workbench-shared/workbench/thread/thread-placement";
import { ThreadSnooze } from "workbench-shared/workbench/thread/thread-snooze";
import type { LocatedThreadSummary } from "workbench-shared/workbench/thread/thread-summary";
import type { WorkbenchThreadSidebarThreadRow } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type WorkbenchDaemonSource from "../workspace/WorkbenchDaemonSource";
import type WorkbenchWorkspaceThreads from "../workspace/WorkbenchWorkspaceThreads";
import type WorkbenchPresentationController from "./WorkbenchPresentationController";

type Batch = ReturnType<WorkbenchDaemonSource["observe"]>;
export interface PlacedThreadRow {
  location: { daemonId: DaemonId; projectId: ProjectId };
  row: WorkbenchThreadSidebarThreadRow;
}

export default class WorkbenchThreadPlacementController {
  private readonly batches = new Map<DaemonId, Batch>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly cancellation = new AbortController();
  private placement = ThreadPlacement.empty;
  private pinnedRows: ReadonlyMap<string, PlacedThreadRow> = new Map();
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

  /** Every pin and snooze; a new object only when either set changes. */
  read() { return this.placement; }

  /** The current rows of pinned threads that a connected daemon reports, with placement applied. */
  readPinnedRows() { return this.pinnedRows; }

  /** Fires when the placement or a watched pinned row changes. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Settled and archived threads cannot gain a pin; unpinning always succeeds. */
  async pin(threadId: string, pinned: boolean) {
    const id = WorkbenchThreadIdSchema.parse(threadId);
    if (pinned) {
      const row = (await this.readSummary(id))?.summary.row;
      if (row?.entryKind !== "thread" || row.metadata.archived || row.lifecycle.settled) return false;
    }
    this.writePins(pinned ? [id] : [], pinned ? [] : [id]);
    return true;
  }

  /** A questionnaire's turn is interrupted first; the questionnaire stays and its leaving wakes the thread. */
  async snooze(threadId: string, snoozed: boolean, requestKey?: string) {
    const id = WorkbenchThreadIdSchema.parse(threadId);
    if (!snoozed) {
      this.writeSnoozes([], [id]);
      return true;
    }
    const row = (await this.readSummary(id))?.summary.row;
    if (row?.entryKind !== "thread" || !isWorkbenchThreadSnoozeAvailable(row)) return false;
    const question = row.pendingQuestionnaire?.requestKey ?? null;
    if (requestKey && requestKey !== question) return false;
    if (question) await this.options.threads.withThread(id, async source => {
      await source.daemon.threads.interrupt({ threadId: id, requestKey: question });
    }, this.cancellation.signal);
    this.writeSnoozes([{ threadId: id, basis: ThreadSnooze.capture(row, question), targets: [] }], []);
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
    const next = ThreadSnooze.toggleTarget(this.placement.snoozes.get(id) ?? null, sourceRow, {
      identity: targetRow.identity, projectId: target!.projectId, title: targetRow.title,
    }, ThreadSnooze.isTargetReady(targetRow));
    this.writeSnoozes(next ? [next] : [], next ? [] : [id]);
    return true;
  }

  /** Unchanged writes are skipped, so waking an unsnoozed thread publishes nothing. */
  private writeSnoozes(put: ThreadSnooze[], wake: ThreadSnooze["threadId"][]) {
    const current = ThreadSnooze.byThread(this.options.presentation.read().threadSnoozes);
    const changedPut = put.filter(snooze => !areDeeplyEqual(current.get(snooze.threadId), snooze));
    const changedWake = wake.filter(threadId => current.has(threadId));
    if (!changedPut.length && !changedWake.length) return;
    this.options.presentation.mutate({ kind: "setThreadSnoozes", put: changedPut, wake: changedWake });
  }

  private writePins(pin: WorkbenchThreadId[], unpin: WorkbenchThreadId[]) {
    const current = new Set(this.options.presentation.read().threadPins ?? []);
    const changedPin = pin.filter(threadId => !current.has(threadId));
    const changedUnpin = unpin.filter(threadId => current.has(threadId));
    if (!changedPin.length && !changedUnpin.length) return;
    this.options.presentation.mutate({ kind: "setThreadPins", pin: changedPin, unpin: changedUnpin });
  }

  /** Re-runs until stable, since its own writes change the placement it reads. */
  private evaluate() {
    if (this.cancellation.signal.aborted || this.options.canProject?.() === false) return;
    this.dirty = true;
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        const changed = this.readPlacement();
        this.observe();
        const rows = this.reportedRows();
        this.reconcile(rows);
        if (this.publishPinnedRows(rows) || changed) for (const listener of [...this.listeners]) listener();
      }
    } catch (error) {
      this.options.warn(`Thread placement evaluation failed: ${error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure."}`);
    } finally { this.evaluating = false; }
  }

  private readPlacement() {
    const next = ThreadPlacement.from(this.options.presentation.read());
    if (areDeeplyEqual([...next.snoozes.values()], [...this.placement.snoozes.values()])
      && areDeeplyEqual([...next.pins].sort(), [...this.placement.pins].sort())) return false;
    this.placement = next;
    return true;
  }

  private observe() {
    const threadIds = [...new Set([
      ...this.placement.pins,
      ...[...this.placement.snoozes.values()].flatMap(snooze =>
        [snooze.threadId, ...snooze.targets.map(target => target.identity.threadId)]),
    ])].sort().map(id => ThreadReferenceSchema.parse(id));
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
   * offline, so its pin, snooze or target keeps waiting rather than guessing it is gone.
   */
  private reportedRows() {
    const rows = new Map<string, PlacedThreadRow>();
    const conflicts = new Set<string>();
    for (const [daemonId, batch] of this.batches) {
      const fact = batch.getSnapshot();
      if (fact.value?.kind !== "threadSummaries") continue;
      for (const [threadId, located] of Object.entries(fact.value.summaries)) {
        if (!located) continue;
        if (rows.has(threadId)) conflicts.add(threadId);
        rows.set(threadId, { location: { daemonId, projectId: located.projectId }, row: located.summary.row });
      }
    }
    for (const threadId of conflicts) rows.delete(threadId);
    return rows;
  }

  /** Archiving drops a pin; settling keeps it so a restore comes back pinned. */
  private reconcile(rows: ReadonlyMap<string, PlacedThreadRow>) {
    const put: ThreadSnooze[] = [];
    const wake: ThreadSnooze["threadId"][] = [];
    for (const snooze of this.placement.snoozes.values()) {
      const row = rows.get(snooze.threadId)?.row;
      if (row && ThreadSnooze.isWakeDue(snooze, row)) {
        wake.push(snooze.threadId);
        continue;
      }
      const targets = snooze.targets.filter(target => {
        const targetRow = rows.get(target.identity.threadId)?.row;
        return !targetRow || !ThreadSnooze.isTargetReady(targetRow);
      });
      if (targets.length === snooze.targets.length) continue;
      if (targets.length) put.push({ ...snooze, targets });
      else wake.push(snooze.threadId);
    }
    if (put.length || wake.length) this.writeSnoozes(put, wake);
    const unpin = [...this.placement.pins].flatMap(threadId => {
      const row = rows.get(threadId)?.row;
      return row?.entryKind === "thread" && row.metadata.archived ? [WorkbenchThreadIdSchema.parse(threadId)] : [];
    });
    if (unpin.length) this.writePins([], unpin);
  }

  private publishPinnedRows(rows: ReadonlyMap<string, PlacedThreadRow>) {
    const next = new Map([...this.placement.pins].flatMap(threadId => {
      const placed = rows.get(threadId);
      return placed ? [[threadId, { ...placed, row: this.placement.apply(placed.row) }] as const] : [];
    }));
    if (areDeeplyEqual([...next.entries()], [...this.pinnedRows.entries()])) return false;
    this.pinnedRows = next;
    return true;
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
        const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Thread placement is closing."));
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
