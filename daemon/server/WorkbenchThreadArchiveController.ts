/*
 * Exports:
 * - default WorkbenchThreadArchiveController: query archival deadlines and own one expiry wake.
 */
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";

const SETTLED_ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

export default class WorkbenchThreadArchiveController {
  private cancelWake: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private querying: Promise<void> | null = null;
  private revision = 0;
  private active = true;

  constructor(private readonly options: {
    readNextActivity: () => Promise<number | null>;
    expire: (activeBefore: number) => Promise<void>;
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
    this.revision += 1;
    this.cancelWake?.();
    this.cancelWake = null;
    this.queryDeadline();
  }

  private queryDeadline() {
    if (!this.active || this.running || this.querying) return;
    const revision = this.revision;
    this.querying = Promise.resolve().then(async () => {
      const activityAt = await this.options.readNextActivity();
      if (!this.active || revision !== this.revision || activityAt === null) return;
      const schedule = this.options.schedule ?? ((callback, delayMs) => {
        const timer = setTimeout(() => { void callback(); }, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
      // A future persisted timestamp must not overflow Node's timer range into a busy loop.
      this.cancelWake = schedule(() => this.expire(), Math.min(2_147_483_647,
        Math.max(0, activityAt + SETTLED_ARCHIVE_AGE_MS - this.options.now())));
    }).catch(error => this.options.onError(error)).finally(() => {
      this.querying = null;
      if (revision !== this.revision) this.queryDeadline();
    });
  }

  private async expire() {
    this.cancelWake = null;
    if (!this.active || this.running) return;
    const revision = this.revision;
    let succeeded = false;
    try {
      this.running = Promise.resolve().then(() => this.options.expire(this.options.now() - SETTLED_ARCHIVE_AGE_MS));
      await this.running;
      succeeded = true;
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.running = null;
      // Failure waits for a real state change, rather than spinning on an overdue record.
      if (succeeded) this.reschedule();
      else if (revision !== this.revision) this.queryDeadline();
    }
  }

  async dispose() {
    this.active = false;
    this.cancelWake?.();
    this.cancelWake = null;
    await this.querying;
    await this.running?.catch(() => undefined); // The expiry boundary already reports this failure.
  }
}
