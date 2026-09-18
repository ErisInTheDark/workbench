/*
 * Exports:
 * - WorkbenchDaemonConnectionSnapshot: resolved browser daemon address and bounded connection failure.
 * - default WorkbenchDaemonConnection: own coalesced endpoint resolution and its browser-lifetime cancellation.
 */
import { WorkbenchDaemonConnectionSchema } from "../http/workbench-daemon-endpoint.ts";
import reportClientSchemaError from "./report-client-schema-error.ts";

export interface WorkbenchDaemonConnectionSnapshot {
  url: string | null;
  failure: string | null;
}

function websocketAddress(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
    throw new Error("Configured daemon address must be a WebSocket URL without credentials.");
  }
  return url.href.replace(/\/$/u, "");
}

export default class WorkbenchDaemonConnection {
  private snapshot: WorkbenchDaemonConnectionSnapshot = { url: null, failure: null };
  private readonly listeners = new Set<() => void>();
  private resolution: Promise<string> | null = null;
  private readonly cancellation = new AbortController();

  constructor(private readonly options: {
    location: () => string | null;
    configuredUrl?: () => string | null;
    fetcher?: typeof fetch;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  resolve(): Promise<string> {
    if (this.cancellation.signal.aborted) return Promise.reject(new Error("Daemon connection resolution has closed."));
    if (this.resolution) return this.resolution;
    this.resolution = this.read().then(url => {
      this.cancellation.signal.throwIfAborted();
      this.publish({ url, failure: null });
      return url;
    }).catch((error: unknown) => {
      if (!this.cancellation.signal.aborted) {
        this.publish({
          url: null,
          failure: error instanceof Error ? error.message.slice(0, 300) : "Daemon connection could not be resolved.",
        });
      }
      throw error;
    }).finally(() => { this.resolution = null; });
    return this.resolution;
  }

  private async read(): Promise<string> {
    const configured = this.options.configuredUrl?.();
    if (configured) return websocketAddress(configured);
    const location = this.options.location();
    if (!location) throw new Error("A non-browser daemon client requires an explicit endpoint.");
    const browser = new URL(location);
    const response = await (this.options.fetcher ?? fetch)("/api/workbench-network?connection=1", {
      cache: "no-store", signal: this.cancellation.signal,
    });
    if (!response.ok) throw new Error("Workbench could not resolve its daemon connection.");
    const parsed = WorkbenchDaemonConnectionSchema.safeParse(await response.json());
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench daemon connection", parsed.error);
      throw new Error("Workbench returned an invalid daemon connection.");
    }
    if (parsed.data.localPort === null) throw new Error("The local Workbench daemon is unavailable.");
    const host = browser.hostname.replace(/^\[|\]$/gu, "");
    const local = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
    if (local) browser.hostname = "127.0.0.1";
    browser.protocol = browser.protocol === "https:" ? "wss:" : "ws:";
    browser.port = String(local ? parsed.data.localPort : parsed.data.tailnetPort);
    browser.pathname = "";
    browser.search = "";
    browser.hash = "";
    return websocketAddress(browser.href);
  }

  private publish(snapshot: WorkbenchDaemonConnectionSnapshot) {
    if (snapshot.url === this.snapshot.url && snapshot.failure === this.snapshot.failure) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  dispose() {
    this.cancellation.abort(new Error("Daemon connection resolution disposed."));
    this.listeners.clear();
  }
}
