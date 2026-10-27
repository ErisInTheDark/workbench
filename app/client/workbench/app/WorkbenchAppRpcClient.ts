/*
 * Exports:
 * - default WorkbenchAppRpcClient: own the early tab-level app RPC transport, whose aborted requests are cancelled at the app.
 */
import { z } from "zod";
import { WORKBENCH_APP_NETWORK_SOCKET_PATH, conformWorkbenchAppNetworkEvent,
  type WorkbenchAppNetworkEvent } from "workbench-shared/http/workbench-app-events";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { describeObservationRepairs } from "workbench-shared/workbench/workspace/workspace-observation-conformance";
import type { WorkbenchAppRpcIntent } from "workbench-shared/http/workbench-app-rpc";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import WorkbenchRpcSocketClient, { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { sendCancellableRequest } from "workbench-shared/workbench/rpc-cancellation";
import { createWorkbenchRequestIdGenerator } from "workbench-shared/workbench/workbench-rpc";
import { WORKSPACE_COMMAND_NOT_SENT, WORKSPACE_COMMAND_UNCERTAIN } from "workbench-shared/workbench/workspace/workspace-commands";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

function boundedListenerError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown listener failure.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
}

const address = z.object({ subscriptionId: z.uuid(), generation: z.number().int().nonnegative() });
const WorkspaceObservationAddress = z.object({ kind: z.literal("workspaceDelta"), delta: address })
  .transform(value => value.delta);
type ObservationAddress = z.infer<typeof address>;

export default class WorkbenchAppRpcClient {
  private readonly transport: WorkbenchRpcSocketClient;
  /** Every request id is assigned here, so a cancellation can name it. */
  private readonly nextRequestId = createWorkbenchRequestIdGenerator();
  private readonly lifetime = new AbortController();
  private readonly eventListeners = new Set<(event: WorkbenchAppNetworkEvent) => void>();
  private readonly invalidObservationListeners = new Set<(address: ObservationAddress) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private latestImport: Extract<WorkbenchAppNetworkEvent, { kind: "presentation-import" }> | null = null;
  private started = false;

  constructor(private readonly options: {
    socket?: (url: string) => WebSocket;
    origin?: string;
  } = {}) {
    const transport = new WorkbenchRpcSocketClient(
      async () => new URL(WORKBENCH_APP_NETWORK_SOCKET_PATH,
        options.origin ?? globalThis.location?.href ?? "http://localhost/").href.replace(/^http/u, "ws"),
      "Workbench app RPC",
      this.options.socket,
    );
    this.transport = transport;
    transport.onMessage(value => {
      if (this.lifetime.signal.aborted || !value || typeof value !== "object" || "id" in value) return;
      const parsed = conformWorkbenchAppNetworkEvent(value);
      if (parsed.repairedPaths.length) {
        console.warn(`Workbench app RPC ${parsed.success ? parsed.data.kind : "event"} repaired: ${describeObservationRepairs(parsed.repairedPaths)}`);
      }
      if (!parsed.success) {
        console.warn("Workbench app RPC event could not be conformed.");
        const address = conformToZodSchema(WorkspaceObservationAddress, value);
        if (address.success) for (const listener of this.invalidObservationListeners) {
          try { listener(address.data); }
          catch (error) { console.error("Workspace failure listener failed:", boundedListenerError(error)); }
        }
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
  }

  get available() { return !this.lifetime.signal.aborted; }
  get connected() { return this.transport.isOpen; }
  getSnapshot = () => this.transport.getSnapshot();
  subscribe = (listener: () => void) => this.transport.subscribe(listener);
  onOpen(listener: () => void) { return this.transport.onOpen(listener); }

  start() {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    void this.transport.connect().catch(error => {
      if (!this.lifetime.signal.aborted) console.warn("Workbench app connection failed:", boundedListenerError(error));
    });
  }

  onEvent(listener: (event: WorkbenchAppNetworkEvent) => void) {
    this.eventListeners.add(listener);
    if (this.latestImport) this.deliverEvent(listener, this.latestImport);
    return () => { this.eventListeners.delete(listener); };
  }

  onInvalidObservation(listener: (address: ObservationAddress) => void) {
    this.invalidObservationListeners.add(listener);
    return () => { this.invalidObservationListeners.delete(listener); };
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

  async requestRaw(intent: WorkbenchAppRpcIntent, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.lifetime.signal.aborted) {
      throw new Error("Workbench app RPC is unavailable.");
    }
    const response = await sendCancellableRequest<unknown>(this.transport, { ...intent, id: this.nextRequestId() }, {
      requireOpen: true, signal: options.signal,
    });
    if ("error" in response) {
      const failure = z.object({ code: z.number().int(), message: z.string().max(512), data: z.json().optional() }).safeParse(response.error);
      if (!failure.success) reportClientSchemaError("Rejected Workbench app RPC error", failure.error);
      if (!failure.success) throw new Error("Workbench app RPC failed.");
      if (failure.data.code === WORKSPACE_COMMAND_NOT_SENT || failure.data.code === WORKSPACE_COMMAND_UNCERTAIN) {
        throw new WorkbenchRpcRequestInterruptedError(failure.data.message, failure.data.code === WORKSPACE_COMMAND_UNCERTAIN);
      }
      const data = failure.data.data;
      throw new WorkbenchDaemonRequestError(failure.data.message, failure.data.code,
        data && typeof data === "object" && !Array.isArray(data) ? data : null);
    }
    return response.result;
  }

  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("Workbench app RPC disposed."));
    this.transport.dispose();
    this.eventListeners.clear();
    this.invalidObservationListeners.clear();
    this.reconnectListeners.clear();
    this.latestImport = null;
  }
}
