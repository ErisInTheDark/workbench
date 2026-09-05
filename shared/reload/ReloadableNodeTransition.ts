/*
 * Keywords: reload, deadline, lifecycle, fencing, failure.
 * Exports:
 * - ReloadableNodeTransitionDeadline: cancellable process-owned reload deadline.
 * - default ReloadableNodeTransition: own one transition budget, phase, failure, and graph availability.
 */
export interface ReloadableNodeTransitionDeadline {
  cancel(): void;
  expired: Promise<void>;
}

export default class ReloadableNodeTransition {
  readonly affectedScopes = new Set<string>();
  // Only the host can establish whether detach/publication has made live work unsafe.
  liveGraphUsable = true;
  private failureValue: Error | null = null;
  private interrupt!: (error: Error) => void;
  private readonly interrupted = new Promise<Error>((resolve) => { this.interrupt = resolve; });
  private phase = "load graph";
  private finished = false;

  constructor(
    private readonly deadline: ReloadableNodeTransitionDeadline,
    timeoutMs: number,
    describePending: () => string,
    private readonly logError: (message: string) => void,
  ) {
    void deadline.expired.then(() => {
      if (this.finished) return;
      let details: string;
      let cause: unknown;
      try {
        details = describePending().slice(0, 2_000);
      } catch (error) {
        details = "Pending-work diagnostics failed.";
        cause = error;
      }
      this.fail(new Error(`Reload transition exceeded ${timeoutMs}ms during ${this.phase}. ${details}`, { cause }));
    });
  }

  get failure() { return this.failureValue; }

  fail(error: unknown) {
    if (this.failureValue) return;
    this.failureValue = error instanceof Error ? error : new Error("Reload transition failed.");
    this.interrupt(this.failureValue);
  }

  assertActive() {
    if (this.failureValue) throw this.failureValue;
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    this.assertActive();
    return await Promise.race([
      operation,
      this.interrupted.then((error) => { throw error; }),
    ]);
  }

  async execute(operation: () => Promise<void>) {
    const running = Promise.resolve().then(operation);
    void running.catch((error: unknown) => {
      if (this.failureValue && error !== this.failureValue) {
        this.logError(`A stopped reload later failed during ${this.phase} (${error instanceof Error ? error.name : "non-Error rejection"}).`);
      }
    });
    await this.waitFor(running);
  }

  async step<T>(phase: string, operation: () => Promise<T> | T): Promise<T> {
    this.assertActive();
    this.phase = phase.replace(/\s+/gu, " ").slice(0, 200);
    const result = await operation();
    // A deadline does not cancel arbitrary node code. Fence the host's continuation.
    this.assertActive();
    return result;
  }

  finish() {
    this.finished = true;
    this.deadline.cancel();
  }
}
