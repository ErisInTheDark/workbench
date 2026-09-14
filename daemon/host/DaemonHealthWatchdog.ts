/*
 * Exports:
 * - DaemonHealthWatchdogAction/DaemonHealthProbeToken: explicit runner liveness decisions and stale-probe fence.
 * - default DaemonHealthWatchdog: own silence age, retry stage, in-flight probe, and restart admission.
 */
export type DaemonHealthProbeToken = {
  attempt: 1 | 2;
  generation: number;
};

export type DaemonHealthWatchdogAction =
  | { delayMs: number; kind: "wait" }
  | { kind: "probe"; token: DaemonHealthProbeToken }
  | { kind: "restart" };

export default class DaemonHealthWatchdog {
  private activityAt: number;
  private generation = 0;
  private probeAttempt: 0 | 1 | 2 = 0;
  private probeInFlight = false;
  private readonly firstProbeMs: number;
  private readonly retryProbeMs: number;

  constructor(
    private readonly idleTimeoutMs: number,
    startedAt: number,
  ) {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new Error("Daemon idle timeout must be positive.");
    }
    this.activityAt = startedAt;
    this.firstProbeMs = idleTimeoutMs / 2;
    this.retryProbeMs = idleTimeoutMs * 3 / 4;
  }

  observeOutput(observedAt: number) {
    this.activityAt = observedAt;
    this.generation += 1;
    this.probeAttempt = 0;
    this.probeInFlight = false;
  }

  nextAction(now: number): DaemonHealthWatchdogAction {
    const silentForMs = Math.max(0, now - this.activityAt);
    if (this.probeInFlight) return { delayMs: 0, kind: "wait" };
    if (this.probeAttempt === 0 && silentForMs >= this.firstProbeMs) return this.beginProbe(1);
    if (this.probeAttempt === 1 && silentForMs >= this.retryProbeMs) return this.beginProbe(2);
    if (this.probeAttempt === 2 && silentForMs >= this.idleTimeoutMs) return { kind: "restart" };
    const nextAt = this.probeAttempt === 0
      ? this.firstProbeMs
      : this.probeAttempt === 1
        ? this.retryProbeMs
        : this.idleTimeoutMs;
    return { delayMs: Math.max(0, nextAt - silentForMs), kind: "wait" };
  }

  completeProbe(token: DaemonHealthProbeToken, succeeded: boolean, completedAt: number) {
    if (
      token.generation !== this.generation
      || token.attempt !== this.probeAttempt + 1
      || !this.probeInFlight
    ) return false;
    this.probeInFlight = false;
    if (succeeded) {
      this.observeOutput(completedAt);
      return true;
    }
    this.probeAttempt = token.attempt;
    return true;
  }

  private beginProbe(attempt: 1 | 2): DaemonHealthWatchdogAction {
    this.probeInFlight = true;
    return {
      kind: "probe",
      token: { attempt, generation: this.generation },
    };
  }
}
