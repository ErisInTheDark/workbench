/*
 * Exports:
 * - default CooperativeRebuildQueue: serialize latest-wins browser rebuild jobs with cooperative work budgets. Keywords: scheduler, rebuild, queue.
 * - CooperativeRebuildQueueEntry: queued rebuild request with run, commit, and failure handlers. Keywords: scheduler, rebuild, queue.
 */

import {
  createCooperativeWorkBudget,
  type CooperativeWorkBudget,
} from "./cooperative-work";

export interface CooperativeRebuildQueueEntry<T> {
  commit(result: T): void;
  key: string;
  onError?(error: unknown): void;
  run(budget: CooperativeWorkBudget): Promise<T>;
  sliceMs?: number;
}

interface QueuedCooperativeRebuildQueueEntry {
  commit(result: unknown): void;
  key: string;
  onError?(error: unknown): void;
  run(budget: CooperativeWorkBudget): Promise<unknown>;
  sliceMs?: number;
}

export default class CooperativeRebuildQueue {
  private activeEntry: QueuedCooperativeRebuildQueueEntry | null = null;
  private readonly queuedEntries = new Map<string, QueuedCooperativeRebuildQueueEntry>();
  private readonly queuedKeys: string[] = [];

  enqueue<T>(entry: CooperativeRebuildQueueEntry<T>) {
    const queuedEntry: QueuedCooperativeRebuildQueueEntry = {
      commit: entry.commit as (result: unknown) => void,
      key: entry.key,
      onError: entry.onError,
      run: entry.run as (budget: CooperativeWorkBudget) => Promise<unknown>,
      sliceMs: entry.sliceMs,
    };

    if (!this.queuedEntries.has(entry.key)) {
      this.queuedKeys.push(entry.key);
    }
    this.queuedEntries.set(entry.key, queuedEntry);
    this.drain();
  }

  private drain() {
    if (this.activeEntry) {
      return;
    }

    const nextKey = this.queuedKeys.shift();
    if (nextKey === undefined) {
      return;
    }

    const nextEntry = this.queuedEntries.get(nextKey);
    if (!nextEntry) {
      this.drain();
      return;
    }

    this.queuedEntries.delete(nextKey);
    this.activeEntry = nextEntry;
    void this.runEntry(nextEntry);
  }

  private async runEntry(entry: QueuedCooperativeRebuildQueueEntry) {
    try {
      const result = await entry.run(createCooperativeWorkBudget({ sliceMs: entry.sliceMs }));
      entry.commit(result);
    } catch (error) {
      entry.onError?.(error);
    } finally {
      this.activeEntry = null;
      this.drain();
    }
  }
}
