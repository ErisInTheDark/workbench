/*
 * Exports:
 * - OpenCodeEventStreamControllerOptions: provider event stream and reconnect ports.
 * - default OpenCodeEventStreamController: own one reconnecting OpenCode event subscription.
 */
import type { OpenCodeEvent } from "@opencode/client";

export interface OpenCodeEventStreamControllerOptions {
  subscribe(signal: AbortSignal): AsyncIterable<OpenCodeEvent>;
  onEvent(event: OpenCodeEvent): Promise<void>;
  onConnected(input: { signal: AbortSignal; wasTouched(sessionID: string): boolean }): Promise<void>;
  waitBeforeRetry(signal: AbortSignal): Promise<void>;
  warn(message: string): void;
}

function supersedesActivitySnapshot(event: OpenCodeEvent) {
  return event.type === "session.inbox.delivered"
    || event.type === "session.execution.started"
    || event.type === "session.execution.succeeded"
    || event.type === "session.execution.failed"
    || event.type === "session.execution.interrupted";
}

export default class OpenCodeEventStreamController {
  private readonly lifetime = new AbortController();
  private running: Promise<void> | null = null;
  private readonly baselines = new Set<Promise<void>>();
  private pendingEvents = 0;
  private readyConnection: AbortSignal | null = null;
  private readonly readiness = new Set<{
    resolve(signal: AbortSignal): void;
    reject(error: Error): void;
  }>();

  constructor(private readonly options: OpenCodeEventStreamControllerOptions) {}

  start() {
    if (this.lifetime.signal.aborted || this.running) return;
    const running = this.run();
    this.running = running;
    void running.then(
      () => { if (this.running === running) this.running = null; },
      error => {
        if (!this.lifetime.signal.aborted) this.options.warn(`OpenCode event owner failed (${this.errorName(error)}).`);
        if (this.running === running) this.running = null;
      },
    );
  }

  hasPendingWork() {
    return this.pendingEvents > 0 || this.baselines.size > 0 || this.readiness.size > 0;
  }

  async waitForConnection(signal: AbortSignal): Promise<AbortSignal> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (this.readyConnection && !this.readyConnection.aborted) return this.readyConnection;
    return new Promise<AbortSignal>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        this.readiness.delete(waiter);
      };
      const waiter = {
        resolve: (connection: AbortSignal) => { cleanup(); resolve(connection); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const cancel = () => { cleanup(); reject(signal.reason); };
      this.readiness.add(waiter);
      signal.addEventListener("abort", cancel, { once: true });
      this.start();
    });
  }

  async dispose() {
    this.lifetime.abort(new Error("OpenCode event stream disposed."));
    await this.running;
    await Promise.allSettled([...this.baselines]);
  }

  private async run() {
    while (!this.lifetime.signal.aborted) {
      const connection = new AbortController();
      const cancel = () => connection.abort(this.lifetime.signal.reason);
      this.lifetime.signal.addEventListener("abort", cancel, { once: true });
      connection.signal.addEventListener("abort", () => {
        if (this.readyConnection === connection.signal) this.readyConnection = null;
        for (const waiter of this.readiness) waiter.reject(new Error("OpenCode event connection ended before readiness."));
      }, { once: true });
      let touched = new Set<string>();
      let connected = false;
      let queued = 0;
      let work = Promise.resolve();
      try {
        for await (const event of this.options.subscribe(connection.signal)) {
          if (connection.signal.aborted) break;
          if (event.type === "server.connected") {
            connected = true;
            const observed = new Set<string>();
            touched = observed;
            const baseline = this.options.onConnected({
              signal: connection.signal,
              wasTouched: sessionID => observed.has(sessionID),
            }).then(() => {
              if (connection.signal.aborted) return;
              this.readyConnection = connection.signal;
              for (const waiter of this.readiness) waiter.resolve(connection.signal);
            }).catch(error => {
              if (!connection.signal.aborted) {
                this.options.warn(`OpenCode activity reconciliation failed (${this.errorName(error)}).`);
                connection.abort(new Error("OpenCode activity reconciliation failed."));
              }
            }).finally(() => {
              this.baselines.delete(baseline);
            });
            this.baselines.add(baseline);
            work = work.then(() => baseline);
            continue;
          }
          if (!connected) throw new Error("OpenCode event stream did not start with server.connected.");
          const sessionID = "data" in event && event.data && "sessionID" in event.data
            ? event.data.sessionID : null;
          if (typeof sessionID === "string" && supersedesActivitySnapshot(event)) touched.add(sessionID);
          if (++queued > 4096) throw new Error("OpenCode event reconciliation queue exceeded capacity.");
          this.pendingEvents++;
          work = work.then(async () => {
            try {
              if (connection.signal.aborted) return;
              await this.options.onEvent(event);
            } catch (error) {
              if (!connection.signal.aborted) {
                this.options.warn(`OpenCode event reconciliation failed (${this.errorName(error)}).`);
                connection.abort(new Error("OpenCode event reconciliation failed."));
              }
            } finally {
              queued--;
              this.pendingEvents--;
            }
          });
        }
        await work;
        if (!connection.signal.aborted) this.options.warn(connected
          ? "OpenCode event stream ended unexpectedly." : "OpenCode event stream ended before connection.");
      } catch (error) {
        if (!connection.signal.aborted) this.options.warn(`OpenCode event stream failed (${this.errorName(error)}).`);
      } finally {
        connection.abort(new Error("OpenCode event connection ended."));
        this.lifetime.signal.removeEventListener("abort", cancel);
        await work;
        await Promise.allSettled([...this.baselines]);
      }
      if (this.lifetime.signal.aborted) break;
      try {
        await this.options.waitBeforeRetry(this.lifetime.signal);
      } catch (error) {
        if (!this.lifetime.signal.aborted) this.options.warn(`OpenCode event reconnect wait failed (${this.errorName(error)}).`);
        break;
      }
    }
  }

  private errorName(error: unknown) {
    return error instanceof Error ? error.name.slice(0, 80) : "unknown error";
  }
}
