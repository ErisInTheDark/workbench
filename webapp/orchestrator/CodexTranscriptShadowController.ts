/*
 * CodexTranscriptShadowJob: one replaceable unit of SQLite shadow work. Keywords: codex, transcript, shadow, batch.
 * default CodexTranscriptShadowController: batch latest-only shadow work without joining the legacy transcript lifecycle. Keywords: codex, transcript, shadow, lifecycle.
 */
import type { WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types.ts";

export interface CodexTranscriptShadowJob {
  key: string;
  load: () => Promise<readonly WorkbenchTranscriptObservation[]>;
  threadId: string;
}

interface CodexTranscriptShadowControllerOptions {
  onError?: (error: Error) => void;
  record: (observations: readonly WorkbenchTranscriptObservation[]) => Promise<void>;
  scheduleFlush?: (flush: () => void) => () => void;
}

function defaultScheduleFlush(flush: () => void) {
  const timer = setTimeout(flush, 25);
  timer.unref();
  return () => clearTimeout(timer);
}

export default class CodexTranscriptShadowController {
  readonly #onError: NonNullable<CodexTranscriptShadowControllerOptions["onError"]>;
  readonly #pendingByThread = new Map<string, Map<string, CodexTranscriptShadowJob>>();
  readonly #record: CodexTranscriptShadowControllerOptions["record"];
  readonly #scheduleFlush: NonNullable<CodexTranscriptShadowControllerOptions["scheduleFlush"]>;
  #accepting = true;
  #activeFlush: Promise<void> | null = null;
  #cancelScheduledFlush: (() => void) | null = null;

  constructor({
    onError = () => undefined,
    record,
    scheduleFlush = defaultScheduleFlush,
  }: CodexTranscriptShadowControllerOptions) {
    this.#onError = onError;
    this.#record = record;
    this.#scheduleFlush = scheduleFlush;
  }

  dispose() {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#cancelScheduledFlush?.();
    this.#cancelScheduledFlush = null;
    this.#pendingByThread.clear();
  }

  schedule(job: CodexTranscriptShadowJob) {
    if (!this.#accepting) return;
    const pending = this.#pendingByThread.get(job.threadId) ?? new Map();
    pending.delete(job.key);
    pending.set(job.key, job);
    this.#pendingByThread.set(job.threadId, pending);
    this.#ensureScheduled();
  }

  #ensureScheduled() {
    if (!this.#accepting || this.#activeFlush || this.#cancelScheduledFlush || !this.#pendingByThread.size) return;
    this.#cancelScheduledFlush = this.#scheduleFlush(() => {
      this.#cancelScheduledFlush = null;
      this.#startFlush();
    });
  }

  async #flush(batch: Map<string, Map<string, CodexTranscriptShadowJob>>) {
    for (const jobs of batch.values()) {
      try {
        const observations: WorkbenchTranscriptObservation[] = [];
        for (const job of jobs.values()) observations.push(...await job.load());
        if (observations.length) await this.#record(observations);
      } catch (error) {
        this.#onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #startFlush() {
    if (!this.#accepting || this.#activeFlush || !this.#pendingByThread.size) return;
    const batch = new Map(this.#pendingByThread);
    this.#pendingByThread.clear();
    const activeFlush = this.#flush(batch).finally(() => {
      if (this.#activeFlush === activeFlush) this.#activeFlush = null;
      this.#ensureScheduled();
    });
    this.#activeFlush = activeFlush;
    void activeFlush;
  }
}
