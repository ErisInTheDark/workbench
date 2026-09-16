/*
 * Exports:
 * - default CodexThreadPageReadController: own page imports and detached refreshes, exact-key single-flight, and reload draining.
 */
import type { WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";

export default class CodexThreadPageReadController {
  private acceptingReads = true;
  private generation = new AbortController();
  private readonly activeReads = new Set<Promise<WorkbenchThreadPageResponse>>();
  private readonly keyedReads = new Map<string, Promise<WorkbenchThreadPageResponse>>();

  refresh(
    read: (signal: AbortSignal) => Promise<WorkbenchThreadPageResponse>,
    key: string,
    report: (error: unknown) => void,
  ) {
    if (!this.acceptingReads || this.keyedReads.has(key)) return;
    const signal = this.generation.signal;
    void this.run(read, { key }).catch(error => {
      if (!signal.aborted || error !== signal.reason) report(error);
    });
  }

  run(
    read: (signal: AbortSignal) => Promise<WorkbenchThreadPageResponse>,
    options: { key?: string } = {},
  ) {
    if (!this.acceptingReads) {
      throw new Error("Codex thread-page reads are draining for reload.");
    }

    const key = options.key;
    const existing = key ? this.keyedReads.get(key) : null;
    if (existing) return existing;

    const signal = AbortSignal.any([this.generation.signal]);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return read(signal);
    }).catch((error: unknown) => {
      if (signal.aborted && error !== signal.reason) {
        console.warn(`[codex] retired thread-page read failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      }
      throw error;
    });
    let activeRead!: Promise<WorkbenchThreadPageResponse>;
    activeRead = Promise.race([work, cancelled]).finally(() => {
      signal.removeEventListener("abort", onAbort);
      this.activeReads.delete(activeRead);
      if (key && this.keyedReads.get(key) === activeRead) {
        this.keyedReads.delete(key);
      }
    });
    this.activeReads.add(activeRead);
    if (key) this.keyedReads.set(key, activeRead);
    return activeRead;
  }

  beginDrain() {
    this.acceptingReads = false;
  }

  expire() {
    this.beginDrain();
    this.generation.abort(new Error("Codex thread-page read generation retired."));
    this.keyedReads.clear();
  }

  resumeAfterFailedReload() {
    if (this.generation.signal.aborted) this.generation = new AbortController();
    this.acceptingReads = true;
  }

  async waitForIdle() {
    while (this.activeReads.size) {
      await Promise.allSettled([...this.activeReads]);
    }
  }
}
