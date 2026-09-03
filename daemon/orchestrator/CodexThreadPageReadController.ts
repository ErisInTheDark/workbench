/*
 * Exports:
 * - default CodexThreadPageReadController: own active Codex thread-page reads, exact-key single-flight, and reload draining. Keywords: codex, thread, page, read, reload.
 */
import type { WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";

export default class CodexThreadPageReadController {
  private acceptingReads = true;
  private readonly activeReads = new Set<Promise<WorkbenchThreadPageResponse>>();
  private readonly keyedReads = new Map<string, Promise<WorkbenchThreadPageResponse>>();

  run(
    read: () => Promise<WorkbenchThreadPageResponse>,
    options: { key?: string } = {},
  ) {
    if (!this.acceptingReads) {
      throw new Error("Codex thread-page reads are draining for reload.");
    }

    const key = options.key;
    const existing = key ? this.keyedReads.get(key) : null;
    if (existing) return existing;

    let activeRead!: Promise<WorkbenchThreadPageResponse>;
    activeRead = Promise.resolve().then(read).finally(() => {
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

  resumeAfterFailedReload() {
    this.acceptingReads = true;
  }

  async waitForIdle() {
    while (this.activeReads.size) {
      await Promise.allSettled([...this.activeReads]);
    }
  }
}
