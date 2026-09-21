/*
 * Exports:
 * - default WorkbenchAppLifetimeClient: gate daemon transport on the serving app's lifetime.
 */
const endpoint = "/api/workbench-app-lifetime";
interface LifetimeStream {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export default class WorkbenchAppLifetimeClient {
  private readonly lifetime = new AbortController();
  private source: LifetimeStream | null = null;
  private started = false;

  constructor(private readonly options: {
    available(value: boolean): void;
    status(message: string): void;
    fetcher?: typeof fetch;
    open?: (url: string) => LifetimeStream;
  }) {}

  async start() {
    if (this.started || this.lifetime.signal.aborted) throw new Error("App lifetime observation already started or closed.");
    this.started = true;
    this.options.available(false);
    try {
      const response = await (this.options.fetcher ?? globalThis.fetch.bind(globalThis))(endpoint, {
        method: "HEAD", cache: "no-store", signal: this.lifetime.signal,
      });
      this.lifetime.signal.throwIfAborted();
      if (response.status === 404) {
        // An older app server has no lifetime endpoint. Preserve its transport behaviour.
        this.options.available(true);
        return;
      }
      if (!response.ok) throw new Error("Workbench app lifetime is unavailable.");
      const source = (this.options.open ?? (url => new EventSource(url)))(endpoint);
      this.source = source;
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        const cancelled = () => reject(this.lifetime.signal.reason);
        this.lifetime.signal.addEventListener("abort", cancelled, { once: true });
        source.addEventListener("ready", () => {
          if (this.lifetime.signal.aborted) return;
          ready = true;
          this.lifetime.signal.removeEventListener("abort", cancelled);
          this.options.available(true);
          resolve();
        });
        const unavailable = () => {
          if (this.lifetime.signal.aborted) return;
          this.options.available(false);
          this.options.status("Workbench app is unavailable. Waiting for it to return.");
          if (!ready) reject(new Error("Workbench app disconnected during startup."));
        };
        source.addEventListener("stopped", unavailable);
        source.addEventListener("error", unavailable);
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose() {
    this.lifetime.abort(new Error("App lifetime observer disposed."));
    this.source?.close();
    this.source = null;
  }
}
