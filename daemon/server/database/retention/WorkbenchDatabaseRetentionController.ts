/*
 * Exports:
 * - WorkbenchRetentionRecord: when the last retention pass completed, surviving daemon restarts.
 * - fileRetentionRecord: a retention record kept in a small JSON file.
 * - default WorkbenchDatabaseRetentionController: own non-overlapping daily database retention that restarts and reloads do not
 *   repeat; disposal stops the pass between steps, and an in-flight pass reports pending work so the daemon does not sleep through it.
 */
import fs from "node:fs";
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";

const DAY_MS = 86_400_000;
/** Due passes start within this long of becoming due. */
const DUE_CHECK_MS = 3_600_000;

interface RetentionScheduler {
  clear(handle: ReturnType<typeof setInterval>): void;
  every(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
}

export interface WorkbenchRetentionRecord {
  readCompletedAt(): number | null;
  writeCompletedAt(at: number): void;
}

type RetentionDatabase = Pick<WorkbenchDatabaseController, "runRetention">;

const scheduler: RetentionScheduler = {
  clear: clearInterval,
  every: (callback, intervalMs) => setInterval(callback, intervalMs),
};

/** A missing or unreadable file reads as never completed, so retention simply runs. */
export function fileRetentionRecord(path: string): WorkbenchRetentionRecord {
  return {
    readCompletedAt: () => {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
        const completedAt = value && typeof value === "object" && "completedAt" in value ? value.completedAt : null;
        return typeof completedAt === "number" && Number.isFinite(completedAt) ? completedAt : null;
      } catch {
        return null;
      }
    },
    writeCompletedAt: at => { fs.writeFileSync(path, JSON.stringify({ completedAt: at })); },
  };
}

const unrecorded: WorkbenchRetentionRecord = { readCompletedAt: () => null, writeCompletedAt: () => {} };

export default class WorkbenchDatabaseRetentionController {
  private handle: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private readonly disposal = new AbortController();

  constructor(
    private readonly database: RetentionDatabase,
    private readonly now: () => number = Date.now,
    private readonly scheduling: RetentionScheduler = scheduler,
    private readonly readObservedThreadIds: () => string[] = () => [],
    private readonly record: WorkbenchRetentionRecord = unrecorded,
  ) {}

  /** Passes hold the database writer for minutes, so a reload only runs one when the last completed pass is a day old. */
  start() {
    if (this.handle || this.disposal.signal.aborted) return;
    void this.runIfDue();
    this.handle = this.scheduling.every(() => { void this.runIfDue(); }, DUE_CHECK_MS);
  }

  hasPendingWork() {
    return this.active !== null;
  }

  private async runIfDue() {
    const completedAt = this.record.readCompletedAt();
    if (completedAt !== null && this.now() - completedAt < DAY_MS) return;
    await this.run();
  }

  async run() {
    if (this.active) return await this.active;
    const now = this.now();
    const { signal } = this.disposal;
    this.active = this.database.runRetention({
      expiredAt: now,
      resultCutoff: now - DAY_MS,
      transcriptCutoff: now - 3 * DAY_MS,
    }, now - DAY_MS, signal, this.readObservedThreadIds).then(() => {
      this.record.writeCompletedAt(now);
    }).catch((error: unknown) => {
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
