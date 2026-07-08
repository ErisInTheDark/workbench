/*
 * Exports:
 * - NextDevHealthSupervisorOptions: configuration and callbacks for the Next.js dev-server health watchdog. Keywords: next, health, watchdog, restart.
 * - default NextDevHealthSupervisor: polling controller that restarts Next dev after repeated server errors. Keywords: next, turbopack, 500, recovery.
 */

type NextDevHealthProbeResult =
  | { ok: true; status: number }
  | { error: string; ok: false };

export type NextDevHealthSupervisorOptions = {
  healthUrl: string;
  intervalMs: number;
  isRestartPending: () => boolean;
  isShuttingDown: () => boolean;
  log: (message: string) => void;
  logError: (message: string) => void;
  requestTimeoutMs: number;
  restartCooldownMs: number;
  restartNextDev: (reason: string) => boolean;
  serverErrorThreshold: number;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export default class NextDevHealthSupervisor {
  private readonly options: NextDevHealthSupervisorOptions;
  private abortController: AbortController | null = null;
  private armed = false;
  private consecutiveServerErrors = 0;
  private inFlight = false;
  private lastRestartedAt = 0;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: NextDevHealthSupervisorOptions) {
    this.options = options;
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.schedule(0);
  }

  dispose() {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.abortController?.abort();
    this.abortController = null;
  }

  private schedule(delayMs: number) {
    if (!this.started || this.options.isShuttingDown()) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
    unrefTimer(this.timer);
  }

  private async poll() {
    if (!this.started || this.inFlight || this.options.isShuttingDown()) {
      this.schedule(this.options.intervalMs);
      return;
    }

    this.inFlight = true;
    try {
      this.handleProbeResult(await this.probe());
    } catch (error) {
      this.options.logError(error instanceof Error ? error.stack ?? error.message : String(error));
    } finally {
      this.inFlight = false;
      this.schedule(this.options.intervalMs);
    }
  }

  private async probe(): Promise<NextDevHealthProbeResult> {
    const abortController = new AbortController();
    this.abortController = abortController;
    const timeout = setTimeout(() => abortController.abort(), this.options.requestTimeoutMs);
    unrefTimer(timeout);

    try {
      const response = await fetch(this.options.healthUrl, {
        cache: "no-store",
        headers: {
          "x-workbench-health-check": "next-dev",
        },
        signal: abortController.signal,
      });
      return {
        ok: true,
        status: response.status,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    } finally {
      clearTimeout(timeout);
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  private handleProbeResult(result: NextDevHealthProbeResult) {
    if (!result.ok) {
      return;
    }

    if (result.status >= 200 && result.status < 300) {
      if (!this.armed) {
        this.options.log(`Next.js dev health check is healthy at ${this.options.healthUrl}`);
      }
      this.armed = true;
      this.consecutiveServerErrors = 0;
      return;
    }

    if (!this.armed || result.status < 500) {
      this.consecutiveServerErrors = 0;
      return;
    }

    this.consecutiveServerErrors += 1;
    this.options.log(
      `Next.js dev health check returned HTTP ${result.status} (${this.consecutiveServerErrors}/${this.options.serverErrorThreshold})`,
    );

    if (this.consecutiveServerErrors < this.options.serverErrorThreshold) {
      return;
    }

    this.restartAfterRepeatedServerErrors(result.status);
  }

  private restartAfterRepeatedServerErrors(status: number) {
    const now = Date.now();
    const elapsedSinceRestart = now - this.lastRestartedAt;
    if (this.lastRestartedAt > 0 && elapsedSinceRestart < this.options.restartCooldownMs) {
      this.options.log(
        `Next.js dev restart suppressed; last watchdog restart was ${elapsedSinceRestart}ms ago`,
      );
      this.consecutiveServerErrors = 0;
      return;
    }

    if (this.options.isRestartPending()) {
      this.options.log("Next.js dev restart already pending; watchdog will keep polling");
      this.consecutiveServerErrors = 0;
      return;
    }

    const reason = `Next.js dev health check returned ${this.options.serverErrorThreshold} consecutive 5xx responses; latest status was HTTP ${status}`;
    if (this.options.restartNextDev(reason)) {
      this.lastRestartedAt = now;
      this.consecutiveServerErrors = 0;
    }
  }
}
