/*
 * Keywords: thread, archive, activity, settlement, expiry, scheduler, disposal.
 * Exports:
 * - default WorkbenchThreadArchiveController: derive archival deadlines from thread records and own one expiry wake.
 */
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";

const SETTLED_ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

export default class WorkbenchThreadArchiveController {
  private cancelWake: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private active = true;

  constructor(private readonly options: {
    records: () => Iterable<WorkbenchThreadStateRecord>;
    expire: () => Promise<void>;
    now: () => number;
    onError: (error: unknown) => void;
    schedule?: (callback: () => Promise<void>, delayMs: number) => () => void;
  }) {}

  private deadline(record: WorkbenchThreadStateRecord) {
    return record.entryKind === "thread" && record.lifecycle.settled && !record.metadata.archived
      && !record.metadata.pinned
      ? record.activityAt + SETTLED_ARCHIVE_AGE_MS
      : null;
  }

  isDue(record: WorkbenchThreadStateRecord) {
    const deadline = this.deadline(record);
    return deadline !== null && deadline <= this.options.now();
  }

  reschedule() {
    this.cancelWake?.();
    this.cancelWake = null;
    if (!this.active || this.running) return;
    let next = Infinity;
    for (const record of this.options.records()) {
      const deadline = this.deadline(record);
      if (deadline !== null) next = Math.min(next, deadline);
    }
    if (!Number.isFinite(next)) return;
    const schedule = this.options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(() => { void callback(); }, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
    // A future persisted timestamp must not overflow Node's timer range into a busy loop.
    this.cancelWake = schedule(() => this.expire(), Math.min(2_147_483_647, Math.max(0, next - this.options.now())));
  }

  private async expire() {
    this.cancelWake = null;
    if (!this.active || this.running) return;
    let succeeded = false;
    try {
      this.running = this.options.expire();
      await this.running;
      succeeded = true;
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.running = null;
      // Failure waits for a real state change, rather than spinning on an overdue record.
      if (succeeded) this.reschedule();
    }
  }

  async dispose() {
    this.active = false;
    this.cancelWake?.();
    this.cancelWake = null;
    await this.running?.catch(() => undefined); // The expiry boundary already reports this failure.
  }
}
