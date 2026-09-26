/*
 * Exports:
 * - default WorkbenchAppLifetimeClient: gate daemon transport on the serving app's lifetime.
 */
import { WORKBENCH_APP_LIFETIME_SOCKET_PATH, WorkbenchAppLifetimeEventSchema } from "workbench-shared/http/workbench-app-events";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import WorkbenchRpcSocketClient from "workbench-shared/workbench/WorkbenchRpcSocketClient";

const endpoint = "/api/workbench-app-lifetime";
interface LifetimeStream {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export default class WorkbenchAppLifetimeClient {
  private readonly lifetime = new AbortController();
  private source: LifetimeStream | null = null;
  private socket: WorkbenchRpcSocketClient | null = null;
  private started = false;

  constructor(private readonly options: {
    available(value: boolean): void;
    status(message: string): void;
    fetcher?: typeof fetch;
    open?: (url: string) => LifetimeStream;
    socket?: (url: string) => WebSocket;
  }) {}

  async start() {
    if (this.started || this.lifetime.signal.aborted) throw new Error("App lifetime observation already started or closed.");
    this.started = true;
    this.options.available(false);
    try {
      const response = await (this.options.fetcher ?? globalThis.fetch.bind(globalThis))(`${endpoint}?capabilities=2`, {
        method: "HEAD", cache: "no-store", signal: this.lifetime.signal,
      });
      this.lifetime.signal.throwIfAborted();
      if (response.status === 404) {
        // An older app server has no lifetime endpoint. Preserve its transport behaviour.
        this.options.available(true);
        return;
      }
      if (!response.ok) throw new Error("Workbench app lifetime is unavailable.");
      if (response.headers.get("x-workbench-app-lifetime-socket") === "1") {
        await this.startSocket();
        return;
      }
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

  private async startSocket() {
    const socket = new WorkbenchRpcSocketClient(
      async () => new URL(WORKBENCH_APP_LIFETIME_SOCKET_PATH, window.location.href).href.replace(/^http/u, "ws"),
      "Workbench app lifetime",
      this.options.socket,
    );
    this.socket = socket;
    let ready = false;
    let available = false;
    const firstReady = Promise.withResolvers<void>();
    socket.onMessage(message => {
      if (this.lifetime.signal.aborted || this.socket !== socket) return;
      const parsed = WorkbenchAppLifetimeEventSchema.safeParse(message);
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench app lifetime event", parsed.error);
        return;
      }
      if (parsed.data.kind === "ready") {
        ready = true;
        if (!available) this.options.available(true);
        available = true;
        firstReady.resolve();
      } else {
        if (available) this.options.available(false);
        available = false;
        this.options.status("Workbench app is unavailable. Waiting for it to return.");
        if (!ready) firstReady.reject(new Error("Workbench app disconnected during startup."));
      }
    });
    socket.onClose(() => {
      if (this.lifetime.signal.aborted || this.socket !== socket) return;
      if (available) this.options.available(false);
      available = false;
      this.options.status("Workbench app is unavailable. Waiting for it to return.");
      if (!ready) firstReady.reject(new Error("Workbench app disconnected during startup."));
    });
    void socket.connect().catch(error => {
      if (!ready) firstReady.reject(error);
    });
    await firstReady.promise;
  }

  dispose() {
    this.lifetime.abort(new Error("App lifetime observer disposed."));
    this.source?.close();
    this.source = null;
    this.socket?.dispose();
    this.socket = null;
  }
}
