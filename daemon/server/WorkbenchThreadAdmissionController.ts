/*
 * Exports:
 * - WorkbenchThreadAdmissionHold: one explicit per-thread barrier settlement.
 * - default WorkbenchThreadAdmissionController: own FIFO message admission and rollover holds.
 */
interface AdmissionHold {
  failed: unknown | null;
  gate: Promise<void>;
  releaseGate(): void;
}

export interface WorkbenchThreadAdmissionHold {
  release(): void;
  fail(error: unknown): void;
}

export default class WorkbenchThreadAdmissionController {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly holds = new Map<string, AdmissionHold>();
  private readonly lifetime = new AbortController();

  hasPendingWork() { return this.lanes.size > 0 || this.holds.size > 0; }

  run<T>(threadId: string, admit: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    const previous = this.lanes.get(threadId) ?? Promise.resolve();
    const hold = this.holds.get(threadId);
    const operation = previous.then(async () => {
      this.lifetime.signal.throwIfAborted();
      if (hold?.failed) throw hold.failed;
      return await admit();
    });
    const tail = operation.then(() => {}, () => {}).finally(() => {
      if (this.lanes.get(threadId) === tail) this.lanes.delete(threadId);
    });
    this.lanes.set(threadId, tail);
    return operation;
  }

  hold(threadId: string): WorkbenchThreadAdmissionHold {
    this.lifetime.signal.throwIfAborted();
    if (this.holds.has(threadId)) throw new Error("Thread message admission is already held.");
    const deferred = Promise.withResolvers<void>();
    const hold: AdmissionHold = { failed: null, gate: deferred.promise, releaseGate: deferred.resolve };
    this.holds.set(threadId, hold);
    const previous = this.lanes.get(threadId) ?? Promise.resolve();
    const barrier = previous.then(() => hold.gate);
    const tail = barrier.then(() => {}, () => {}).finally(() => {
      if (this.lanes.get(threadId) === tail) this.lanes.delete(threadId);
    });
    this.lanes.set(threadId, tail);
    let settled = false;
    const settle = (error: unknown | null) => {
      if (settled) return;
      settled = true;
      hold.failed = error;
      if (this.holds.get(threadId) === hold) this.holds.delete(threadId);
      hold.releaseGate();
    };
    return {
      release: () => settle(null),
      fail: error => settle(error instanceof Error ? error : new Error(String(error))),
    };
  }

  beginRuntimeDrain() {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new Error("Thread message admission is reloading."));
    for (const hold of this.holds.values()) {
      hold.failed = this.lifetime.signal.reason;
      hold.releaseGate();
    }
    this.holds.clear();
  }

  async dispose() {
    this.beginRuntimeDrain();
    await Promise.allSettled(this.lanes.values());
  }
}
