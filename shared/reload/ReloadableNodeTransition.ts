/*
 * Keywords: reload, grace, lifecycle, phase, diagnostics.
 * Exports:
 * - ReloadableNodeTransitionDeadline: cancellable process-owned old-work grace deadline.
 * - default ReloadableNodeTransition: own one grace budget and generation-fenced phase diagnostics.
 */
export interface ReloadableNodeTransitionDeadline {
  cancel(): void;
  expired: Promise<void>;
}

export default class ReloadableNodeTransition {
  private expired = false;
  private phase = "load graph";
  private phaseOwner: symbol | null = null;
  private finished = false;

  constructor(
    private readonly deadline: ReloadableNodeTransitionDeadline,
    timeoutMs: number,
    describePending: () => string,
    private readonly logError: (message: string) => void,
  ) {
    void deadline.expired.then(() => {
      if (this.finished) return;
      this.expired = true;
      let details: string;
      try {
        details = describePending().slice(0, 2_000);
      } catch {
        details = "Pending-work diagnostics failed.";
      }
      this.logError(`Reload grace expired after ${timeoutMs}ms during ${this.phase}; forcing old work to retire. ${details}`);
    }).catch((error: unknown) => {
      console.error(`[reload] Grace diagnostics failed (${error instanceof Error ? error.name : "non-Error rejection"}).`);
    });
  }

  async drain(phase: string, wait: () => Promise<void>, expire: () => void) {
    if (this.expired) {
      expire();
      return;
    }
    const waiting = this.step(phase, wait);
    const completed = await Promise.race([
      waiting.then(() => true),
      this.deadline.expired.then(() => false),
    ]);
    if (completed) return;
    this.phaseOwner = null;
    expire();
    void waiting.catch((error: unknown) => {
      this.logError(`Retired reload work later failed during ${phase.slice(0, 200)} (${error instanceof Error ? error.name : "non-Error rejection"}).`);
    });
  }

  async step<T>(phase: string, operation: (reportPhase: (phase: string) => void) => Promise<T> | T): Promise<T> {
    const owner = Symbol("reload phase");
    const label = phase.replace(/\s+/gu, " ").slice(0, 200);
    this.phase = label;
    this.phaseOwner = owner;
    try {
      return await operation((detail) => {
        if (this.finished || this.phaseOwner !== owner) return;
        this.phase = `${label}: ${detail.replace(/\s+/gu, " ").trim().slice(0, 200)}`;
      });
    } finally {
      if (this.phaseOwner === owner) this.phaseOwner = null;
    }
  }

  finish() {
    this.finished = true;
    this.phaseOwner = null;
    this.deadline.cancel();
  }
}
