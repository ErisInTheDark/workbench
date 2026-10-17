/*
 * Exports:
 * - default WorkbenchTurnRecoveryController: schedule reload-drained hidden-turn work and decide unfinished continuation.
 */
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";

export default class WorkbenchTurnRecoveryController {
  private readonly tasks = new Map<Promise<void>, {
    label: string; signal: AbortSignal; cancel(): void; startedAt: number;
  }>();
  private accepting = true;

  constructor(
    private readonly log: (message: string) => void,
    private readonly runTask: (label: string, task: () => Promise<void>) => Promise<void> = async (_label, task) => task(),
  ) {}

  shouldContinue(lifecycle: WorkbenchThreadLifecycle | null) {
    return lifecycle?.kind === "needsAttention" && lifecycle.reason === "noActiveTurn";
  }

  schedule(label: string, signal: AbortSignal, cancel: () => void, operation: () => Promise<void>) {
    if (!this.accepting) throw new Error("Turn recovery is draining; manual resume is temporarily unavailable.");
    signal.throwIfAborted();
    const task = this.runTask(label, async () => {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      if (!signal.aborted) await operation();
    }).catch(error => {
      this.log(`Manual resume failed outside the recovery boundary: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    }).finally(() => { this.tasks.delete(task); });
    this.tasks.set(task, { label, signal, cancel, startedAt: Date.now() });
  }

  beginRuntimeDrain() { this.accepting = false; }

  expireRuntimeDrain() {
    this.beginRuntimeDrain();
    for (const { cancel } of this.tasks.values()) cancel();
  }

  resumeAfterFailedReload() { this.accepting = true; }

  async waitForIdle() {
    await Promise.allSettled([...this.tasks].filter(([, task]) => !task.signal.aborted).map(([task]) => task));
  }

  listRuntimeDrainPending(now = Date.now()) {
    return [...this.tasks.values()].filter(task => !task.signal.aborted)
      .map(({ label, startedAt }) => ({ ageMs: Math.max(0, now - startedAt), label }));
  }
}
