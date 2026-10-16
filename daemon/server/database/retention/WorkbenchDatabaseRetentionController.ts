/*
 * Exports:
 * - default WorkbenchDatabaseRetentionController: own non-overlapping startup and daily database retention; disposal stops the pass between steps,
 *   and an in-flight pass reports pending work so the daemon does not sleep through it.
 */
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";

const DAY_MS = 86_400_000;

interface RetentionScheduler {
  clear(handle: ReturnType<typeof setInterval>): void;
  every(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
}

type RetentionDatabase = Pick<WorkbenchDatabaseController, "runRetention">;

const scheduler: RetentionScheduler = {
  clear: clearInterval,
  every: (callback, intervalMs) => setInterval(callback, intervalMs),
};

export default class WorkbenchDatabaseRetentionController {
  private handle: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private readonly disposal = new AbortController();

  constructor(
    private readonly database: RetentionDatabase,
    private readonly now: () => number = Date.now,
    private readonly scheduling: RetentionScheduler = scheduler,
    private readonly readObservedThreadIds: () => string[] = () => [],
  ) {}

  start() {
    if (this.handle || this.disposal.signal.aborted) return;
    void this.run();
    this.handle = this.scheduling.every(() => { void this.run(); }, DAY_MS);
  }

  hasPendingWork() {
    return this.active !== null;
  }

  async run() {
    if (this.active) return await this.active;
    const now = this.now();
    const { signal } = this.disposal;
    this.active = this.database.runRetention({
      expiredAt: now,
      resultCutoff: now - DAY_MS,
      transcriptCutoff: now - 3 * DAY_MS,
    }, now - DAY_MS, signal, this.readObservedThreadIds).then(() => undefined).catch((error: unknown) => {
      if (signal.aborted) return;
      console.error(`database retention failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000));
    }).finally(() => { this.active = null; });
    return await this.active;
  }

  async dispose() {
    if (this.handle) this.scheduling.clear(this.handle);
    this.handle = null;
    this.disposal.abort();
    await this.active;
  }
}
