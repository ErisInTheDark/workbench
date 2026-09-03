/*
 * Exports:
 * - CodexHealthMonitorOptions: configure end-to-end Codex health polling and recovery signaling. Keywords: codex, health, recovery.
 * - default CodexHealthMonitor: detect repeated bridge-path failures without owning restart execution. Keywords: codex, watchdog, lifecycle.
 */

export interface CodexHealthMonitorOptions {
  failureThreshold: number;
  intervalMs: number;
  isProbeAllowed: () => boolean;
  isShuttingDown: () => boolean;
  log: (message: string) => void;
  logError: (message: string) => void;
  probe: () => Promise<void>;
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
  private inFlight = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CodexHealthMonitorOptions) {}

  start({ armed = false }: { armed?: boolean } = {}) {
    if (this.started) return;
    this.armed = armed;
    this.started = true;
    this.schedule(0);
  }

  dispose() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (!this.started || this.options.isShuttingDown()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
    unrefTimer(this.timer);
  }

  private async poll() {
    if (!this.started || this.inFlight || this.options.isShuttingDown()) return;
    if (!this.options.isProbeAllowed()) {
      this.schedule(this.options.intervalMs);
      return;
    }

    this.inFlight = true;
    try {
      await this.options.probe();
      if (!this.armed) this.options.log("Codex end-to-end health monitor armed after a successful probe.");
      this.armed = true;
      this.consecutiveFailures = 0;
    } catch (error) {
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
      this.inFlight = false;
      this.schedule(this.options.intervalMs);
    }
  }

}
