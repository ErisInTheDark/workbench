/*
 * Exports:
 * - default GitArcClaimMutations: own the claim-mutation revision that wakes callers waiting for sibling claims to clear.
 */
export default class GitArcClaimMutations {
  private revision = 0;
  private readonly waiters = new Set<() => void>();

  notify() {
    this.revision += 1;
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * Repeat `attempt` until it is no longer blocked, waiting for a claim mutation between attempts. A mutation that
   * lands while an attempt runs triggers the next attempt immediately.
   */
  async waitUntil<Result extends { kind: string }>(
    attempt: () => Promise<Result | { kind: "blocked" }>,
    signal: AbortSignal,
  ): Promise<Exclude<Result, { kind: "blocked" }>> {
    while (true) {
      signal.throwIfAborted();
      const revision = this.revision;
      const result = await attempt();
      if (result.kind !== "blocked") return result as Exclude<Result, { kind: "blocked" }>;
      await this.waitForChange(revision, signal);
    }
  }

  private async waitForChange(revision: number, signal: AbortSignal) {
    if (revision !== this.revision) return;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        this.waiters.delete(wake);
        signal.removeEventListener("abort", abort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason ?? new Error("Git arc wait was interrupted."));
      this.waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
      if (revision !== this.revision) wake();
      else if (signal.aborted) abort();
    });
  }
}
