/*
 * Exports:
 * - default WorkbenchAppRpcClient: own the early tab-level app RPC transport.
 */
import { z } from "zod";
import { WORKBENCH_APP_NETWORK_SOCKET_PATH, WorkbenchAppNetworkEventSchema,
  type WorkbenchAppNetworkEvent } from "workbench-shared/http/workbench-app-events";
import type { WorkbenchAppRpcIntent } from "workbench-shared/http/workbench-app-rpc";
import { WorkbenchNetworkSnapshotSchema } from "workbench-shared/http/workbench-network";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import WorkbenchRpcSocketClient from "workbench-shared/workbench/WorkbenchRpcSocketClient";

function boundedListenerError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown listener failure.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
}

export default class WorkbenchAppRpcClient {
  private transport: WorkbenchRpcSocketClient | null = null;
  private readonly lifetime = new AbortController();
  private readonly eventListeners = new Set<(event: WorkbenchAppNetworkEvent) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private latestImport: Extract<WorkbenchAppNetworkEvent, { kind: "presentation-import" }> | null = null;
  private started = false;
  private selected = false;

  constructor(private readonly options: {
    fetcher?: typeof fetch;
    socket?: (url: string) => WebSocket;
  } = {}) {}

  get available() { return this.selected; }

  async start() {
    if (this.started || this.lifetime.signal.aborted) throw new Error("App RPC already started or closed.");
    this.started = true;
    const response = await (this.options.fetcher ?? fetch)(
      "/api/workbench-app-lifetime?capabilities=3",
      { method: "HEAD", cache: "no-store", signal: this.lifetime.signal },
    );
    this.lifetime.signal.throwIfAborted();
    if (response.status === 404) return;
    if (!response.ok) throw new Error("Workbench app RPC capability could not be read.");
    if (response.headers.get("x-workbench-app-rpc") !== "1") return;
    const transport = new WorkbenchRpcSocketClient(
      async () => new URL(WORKBENCH_APP_NETWORK_SOCKET_PATH,
        globalThis.location?.href ?? "http://localhost/").href.replace(/^http/u, "ws"),
      "Workbench app RPC",
      this.options.socket,
    );
    this.transport = transport;
    this.selected = true;
    transport.onMessage(value => {
      if (this.lifetime.signal.aborted || !value || typeof value !== "object" || "id" in value) return;
      const parsed = WorkbenchAppNetworkEventSchema.safeParse(value);
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench app RPC event", parsed.error);
        return;
      }
      if (parsed.data.kind === "presentation-import") this.latestImport = parsed.data;
      for (const listener of this.eventListeners) this.deliverEvent(listener, parsed.data);
    });
    transport.onOpen(reconnected => {
      if (reconnected) for (const listener of this.reconnectListeners) {
        try { listener(); }
        catch (error) {
          console.error("Workbench app RPC reconnect listener failed:", boundedListenerError(error));
        }
      }
    });
    transport.onClose(() => { this.latestImport = null; });
    await transport.connect();
  }

  onEvent(listener: (event: WorkbenchAppNetworkEvent) => void) {
    this.eventListeners.add(listener);
    if (this.latestImport) this.deliverEvent(listener, this.latestImport);
    return () => { this.eventListeners.delete(listener); };
  }

  private deliverEvent(listener: (event: WorkbenchAppNetworkEvent) => void, event: WorkbenchAppNetworkEvent) {
    try { listener(event); }
    catch (error) {
      console.error("Workbench app RPC event listener failed:", boundedListenerError(error));
    }
  }

  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return () => { this.reconnectListeners.delete(listener); };
  }

  async request(method: "app/network/read", params: Record<string, never>) {
    const result = await this.requestRaw({ method, params });
    const parsed = WorkbenchNetworkSnapshotSchema.safeParse(result);
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench app RPC response", parsed.error);
      throw new Error("Workbench app RPC returned invalid data.");
    }
    return parsed.data;
  }

  async requestRaw(intent: WorkbenchAppRpcIntent): Promise<unknown> {
    if (!this.selected || !this.transport || this.lifetime.signal.aborted) {
      throw new Error("Workbench app RPC is unavailable.");
    }
    const response = await this.transport.sendRequest<unknown>(intent);
    if ("error" in response) {
      const failure = z.object({ code: z.number().int(), message: z.string().max(512) }).safeParse(response.error);
      if (!failure.success) reportClientSchemaError("Rejected Workbench app RPC error", failure.error);
      throw new Error(failure.success ? failure.data.message : "Workbench app RPC failed.");
    }
    return response.result;
  }

  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("Workbench app RPC disposed."));
    this.transport?.dispose();
    this.transport = null;
    this.selected = false;
    this.eventListeners.clear();
    this.reconnectListeners.clear();
    this.latestImport = null;
  }
}
