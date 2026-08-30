/*
 * Exports:
 * - default CodexThreadPageReadController: own active Codex thread-page reads, exact background single-flight, and reload draining. Keywords: codex, thread, page, read, reload.
 */
import type { WorkbenchThreadPageResponse } from "../lib/workbench/thread/workbench-thread-page";

export default class CodexThreadPageReadController {
  private acceptingReads = true;
  private readonly activeReads = new Set<Promise<WorkbenchThreadPageResponse>>();
  private readonly backgroundReads = new Map<string, Promise<WorkbenchThreadPageResponse>>();

  run(
    read: () => Promise<WorkbenchThreadPageResponse>,
    options: { backgroundKey?: string } = {},
  ) {
    if (!this.acceptingReads) {
      throw new Error("Codex thread-page reads are draining for reload.");
    }

    const backgroundKey = options.backgroundKey;
    const existing = backgroundKey ? this.backgroundReads.get(backgroundKey) : null;
    if (existing) return existing;

    let activeRead!: Promise<WorkbenchThreadPageResponse>;
    activeRead = Promise.resolve().then(read).finally(() => {
      this.activeReads.delete(activeRead);
      if (backgroundKey && this.backgroundReads.get(backgroundKey) === activeRead) {
        this.backgroundReads.delete(backgroundKey);
      }
    });
    this.activeReads.add(activeRead);
    if (backgroundKey) this.backgroundReads.set(backgroundKey, activeRead);
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
