/*
 * Exports:
 * - CodexHealthMonitorOptions: configure native health polling and recovery signalling.
 * - default CodexHealthMonitor: own cancellable health probes, not restart execution.
 */

export interface CodexHealthMonitorOptions {
  failureThreshold: number;
  intervalMs: number;
  isProbeAllowed: () => boolean;
  isShuttingDown: () => boolean;
  log: (message: string) => void;
  logError: (message: string) => void;
  probe: (signal: AbortSignal) => Promise<void>;
  requestRecovery: (reason: string) => void;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export default class CodexHealthMonitor {
  private armed = false;
  private consecutiveFailures = 0;
  private inFlight: AbortSignal | null = null;
  private generation: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CodexHealthMonitorOptions) {}

  start({ armed = false }: { armed?: boolean } = {}) {
    if (this.generation) return;
    this.armed = armed;
    this.generation = new AbortController();
    this.schedule(0);
  }

  dispose() {
    this.generation?.abort(new Error("Codex health monitor retired."));
    this.generation = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (!this.generation || this.options.isShuttingDown()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
    unrefTimer(this.timer);
  }

  private async poll() {
    const signal = this.generation?.signal;
    if (!signal || this.inFlight === signal || this.options.isShuttingDown()) return;
    if (!this.options.isProbeAllowed()) {
      this.schedule(this.options.intervalMs);
      return;
    }

    this.inFlight = signal;
    try {
      await this.options.probe(signal);
      if (signal.aborted) return;
      if (!this.armed) this.options.log("Codex end-to-end health monitor armed after a successful probe.");
      this.armed = true;
      this.consecutiveFailures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (this.armed) {
        this.consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.options.logError(`Codex health probe failed (${this.consecutiveFailures}/${this.options.failureThreshold}): ${message}`);
        if (this.consecutiveFailures >= this.options.failureThreshold) {
          this.consecutiveFailures = 0;
          this.options.requestRecovery(`Codex health probe failed ${this.options.failureThreshold} consecutive times; latest error: ${message}`);
        }
      }
    } finally {
      if (this.inFlight === signal) this.inFlight = null;
      if (!signal.aborted) this.schedule(this.options.intervalMs);
    }
  }

}
