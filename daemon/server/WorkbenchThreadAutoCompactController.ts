/*
 * Exports:
 * - ThreadAutoCompactEvidence: canonical activity and current-context measurement.
 * - default WorkbenchThreadAutoCompactController: serialise message admission and compact eligible idle threads.
 */
import type { ThreadAutoCompactSettings } from "workbench-shared/workbench/settings/thread-auto-compact";
import type WorkbenchProvider from "./WorkbenchProvider";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";

export interface ThreadAutoCompactEvidence {
  activityAt: number;
  contextTokens: number | null;
}

export default class WorkbenchThreadAutoCompactController {
  private readonly admissions = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  hasPendingWork() { return this.admissions.size > 0; }
  constructor(private readonly ports: {
    readSettings(): Promise<ThreadAutoCompactSettings>;
    readEvidence(threadId: string): Promise<ThreadAutoCompactEvidence | null>;
    now(): number;
  }) {}

  async run<T>(threadId: string, provider: { threads: Pick<WorkbenchProvider["threads"], "read" | "latestTurn" | "isTurnLive" | "compact"> }, admit: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    const previous = this.admissions.get(threadId);
    const operation = (previous ?? Promise.resolve()).then(async () => {
      const signal = this.lifetime.signal;
      signal.throwIfAborted();
      const settings = await this.ports.readSettings();
      if (settings.enabled) {
        const evidence = await this.ports.readEvidence(threadId);
        if (evidence && evidence.contextTokens !== null && evidence.contextTokens >= settings.tokenThreshold
          && this.ports.now() - evidence.activityAt >= settings.idleMinutes * 60_000) {
          const thread = await provider.threads.read(threadId);
          signal.throwIfAborted();
          if (!isThreadStatusActive(thread.status)) {
            const latest = await provider.threads.latestTurn(threadId);
            if (latest && !await provider.threads.isTurnLive(threadId, latest.id)) {
              await provider.threads.compact(threadId, { waitForCompletion: true, signal });
            }
          }
        }
      }
      signal.throwIfAborted();
      return admit();
    });
    // Each caller receives its failure. The lane remains usable for later independent input.
    const tail = operation.then(() => {}, () => {}).finally(() => {
      if (this.admissions.get(threadId) === tail) this.admissions.delete(threadId);
    });
    this.admissions.set(threadId, tail);
    return operation;
  }

  beginRuntimeDrain() { this.lifetime.abort(new Error("Auto-compaction admission is reloading.")); }
  async dispose() { this.beginRuntimeDrain(); await Promise.all(this.admissions.values()); }
}
