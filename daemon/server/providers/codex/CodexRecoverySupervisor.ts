/*
 * Exports:
 * - CodexRecoverySupervisorOptions: configure native recovery, retry timing and shutdown awareness.
 * - default CodexRecoverySupervisor: own coalesced recovery attempts and reversible reload suspension.
 */

export type CodexRecoverySupervisorOptions = {
  initialRetryDelayMs: number;
  isShuttingDown: () => boolean;
  log: (message: string) => void;
  logError: (message: string) => void;
  maxRetryDelayMs: number;
  recover: (reason: string) => Promise<void>;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export default class CodexRecoverySupervisor {
  private readonly options: CodexRecoverySupervisorOptions;
  private disposed = false;
  private paused = false;
  private failureCount = 0;
  private inFlight = false;
  private latestReason = "Codex recovery requested.";
  private recoveryRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CodexRecoverySupervisorOptions) {
    this.options = options;
  }

  requestRecovery(reason: string) {
    if (this.disposed || this.options.isShuttingDown()) {
      return;
    }

    this.latestReason = reason;
    this.recoveryRequested = true;
    if (!this.paused && !this.inFlight && !this.retryTimer) {
      void this.attemptRecovery();
    }
  }

  pause() {
    this.paused = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  resume() {
    if (this.disposed) return;
    this.paused = false;
    if (this.recoveryRequested && !this.inFlight) {
      this.scheduleAttempt(this.failureCount ? this.retryDelayMs() : 0);
    }
  }

  dispose() {
    this.disposed = true;
    this.pause();
    this.recoveryRequested = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleAttempt(delayMs: number) {
    if (this.disposed || this.paused || this.options.isShuttingDown() || this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attemptRecovery();
    }, delayMs);
    unrefTimer(this.retryTimer);
  }

  private retryDelayMs() {
    const exponent = Math.min(Math.max(this.failureCount - 1, 0), 30);
    return Math.min(this.options.initialRetryDelayMs * (2 ** exponent), this.options.maxRetryDelayMs);
  }

  private async attemptRecovery() {
    if (this.disposed || this.paused || this.inFlight || !this.recoveryRequested || this.options.isShuttingDown()) {
      return;
    }

    this.inFlight = true;
    this.recoveryRequested = false;
    const reason = this.latestReason;
    let nextDelayMs: number | null = null;
    try {
      await this.options.recover(reason);
      this.failureCount = 0;
      this.options.log(`Recovered Codex after: ${reason}`);
    } catch (error) {
      this.failureCount += 1;
      this.recoveryRequested = true;
      nextDelayMs = this.retryDelayMs();
      this.options.logError(
        `Codex recovery attempt ${this.failureCount} failed: ${error instanceof Error ? error.message : String(error)}; retrying in ${nextDelayMs}ms`,
      );
    } finally {
      this.inFlight = false;
      if (this.recoveryRequested && !this.disposed && !this.paused && !this.options.isShuttingDown()) {
        if (nextDelayMs === null) {
          void this.attemptRecovery();
        } else {
          this.scheduleAttempt(nextDelayMs);
        }
      }
    }
  }
}
