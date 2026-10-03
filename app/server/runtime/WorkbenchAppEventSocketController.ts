/*
 * Exports:
 * - default WorkbenchAppEventSocketController: own reloadable app event sockets, grants, delivery and bounded traffic logs named by the event each frame carries.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import { WORKBENCH_APP_NETWORK_SOCKET_PATH } from "workbench-shared/http/workbench-app-events";
import { WorkbenchAppRpcRequestSchema, WorkbenchAppRuntimeResponseSchema } from "workbench-shared/http/workbench-app-rpc";
import type { WorkspaceObservationDelta } from "workbench-shared/workbench/workspace/workspace-observation";
import { describeObservationDelta } from "workbench-shared/workbench/workspace/observation-patch";
import { formatWebSocketBytes, formatWebSocketEventSummary } from "workbench-shared/process/websocket-traffic-format";
import WorkbenchWorkspaceRequestController from "../workspace/WorkbenchWorkspaceRequestController";
import type WorkbenchWorkspaceController from "../workspace/WorkbenchWorkspaceController";
import type WorkbenchWorkspaceThreads from "../workspace/WorkbenchWorkspaceThreads";
import type WorkbenchWorkspaceDrafts from "../workspace/WorkbenchWorkspaceDrafts";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type { VoiceSessionEvent } from "workbench-shared/workbench/voice/voice-session-contract";
import type { WorkbenchAppNetworkEvent } from "workbench-shared/http/workbench-app-events";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { z } from "zod";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { WORKSPACE_COMMAND_NOT_SENT, WORKSPACE_COMMAND_UNCERTAIN } from "workbench-shared/workbench/workspace/workspace-commands";
import { WORKBENCH_RELOAD_METHOD } from "workbench-shared/workbench/daemon-reload";
import { workbenchNetworkActionKeepsAppConnection } from "workbench-shared/http/workbench-network";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes.ts";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController.ts";
import type WorkbenchPresentationImportController from "../state/WorkbenchPresentationImportController.ts";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import type WorkbenchAppSettingsController from "./WorkbenchAppSettingsController.ts";
import type WorkbenchAppPortRoutes from "./WorkbenchAppPortRoutes.ts";

type Frame =
  | Extract<WorkbenchAppNetworkEvent, { kind: "transcriptSnapshot" | "transcriptStream" | "transcriptState" }>
  | Extract<WorkbenchAppNetworkEvent, { kind: "threadEvent" }>
  | { kind: "voice"; event: VoiceSessionEvent }
  | { kind: "workspaceDelta"; delta: WorkspaceObservationDelta }
  | { kind: "network"; snapshot: ReturnType<WorkbenchNetworkRoutes["snapshotFor"]> }
  | { kind: "presentation"; event: { revision: number } }
  | { kind: "presentation-import"; status: ReturnType<WorkbenchPresentationImportController["snapshot"]> }
  | { kind: "state"; revision: number }
  | { kind: "runtime" };

function boundedSocketError(error: Error) {
  return error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 300);
}

const shortThread = (value: unknown) => typeof value === "string" && value
  ? ` thread=${value.replace(/[^\w-]/gu, "").slice(0, 8)}` : "";

/** Traffic logs name the event a frame carries, never its payload values. */
function describeFrame(frame: Frame): string {
  switch (frame.kind) {
    case "workspaceDelta":
      return `workspace ${frame.delta.kind} ${describeObservationDelta(frame.delta.delta)}`;
    case "threadEvent": {
      const params = frame.notification.params as { threadId?: unknown } | undefined;
      return `threadEvent ${frame.harness}:${frame.notification.method.slice(0, 80)}${shortThread(params?.threadId)}`;
    }
    case "transcriptSnapshot":
    case "transcriptStream":
      return `${frame.kind}${shortThread((frame.data as { threadId?: unknown }).threadId)}`;
    default:
      return frame.kind;
  }
}

/** Workspace pushes past this name themselves in the log: the tripwire for snapshot resends. */
const WORKSPACE_PUSH_WARNING_BYTES = 32 * 1024;
const MAX_OUTBOUND_FRAME_BYTES = 100 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 2 * MAX_OUTBOUND_FRAME_BYTES;
// Match the daemon WebSocket's existing default now that app RPC carries files
// and image-bearing messages. Client-log admission has its own smaller limits.
const MAX_INBOUND_FRAME_BYTES = 100 * 1024 * 1024;
type Json = z.infer<ReturnType<typeof z.json>>;

export default class WorkbenchAppEventSocketController {
  // Remote and mobile browsers pay for every byte; JSON frames over 1KB compress several-fold.
  private readonly server = new WebSocketServer({
    noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES, perMessageDeflate: { threshold: 1_024 },
  });
  private readonly connections = new Map<WebSocket, () => void>();
  private readonly pendingRequests = new Set<Promise<void>>();
  private readonly traffic = new Map<string, { count: number; bytes: number }>();
  private trafficTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private suspended = false;

  constructor(private readonly options: {
    logger: WorkbenchProcessLogger;
    network: Pick<WorkbenchNetworkController, "subscribe" | "getFacts">;
    routes: WorkbenchNetworkRoutes;
    presentation?: Pick<WorkbenchPresentationController, "subscribe" | "revision" | "read" | "mutate">;
    presentationImport?: Pick<WorkbenchPresentationImportController, "subscribe" | "snapshot">;
    state?: Pick<WorkbenchBrowserStateRegistry,
      "readWorkspaceBrowser" | "mutateBrowser" | "subscribeBrowser">;
    settings?: Pick<WorkbenchAppSettingsController, "read" | "update"> | null;
    port?: Pick<WorkbenchAppPortRoutes, "read">;
    runtime?: { read(): object; subscribe(listener: () => void): () => void };
    sources?: WorkbenchDaemonSources;
    workspace?: WorkbenchWorkspaceController;
    workspaceThreads?: WorkbenchWorkspaceThreads;
    workspaceDrafts?: WorkbenchWorkspaceDrafts;
  }) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (this.closed || this.suspended || url.pathname !== WORKBENCH_APP_NETWORK_SOCKET_PATH || !this.options.routes.admitSocket(request)) {
      this.options.logger.error("app", "WS network upgrade rejected: route, origin or network grant unavailable.");
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, connection => this.accept(connection, request, url));
  }

  private accept(connection: WebSocket, request: IncomingMessage, url: URL) {
    if (this.closed || this.suspended) { connection.close(1012, "App routes reloading"); return; }
    let released = false;
    let stateOwner: string | null | undefined;
    /** `method` names the request an RPC response answers. */
    const send = (
      frame: Frame | { id: number | null; result?: Json | object; error?: { code: number; message: string; data?: Json } },
      method = "invalid",
    ) => {
      const kind = "kind" in frame ? frame.kind : "rpc";
      if (connection.readyState !== WebSocket.OPEN) return;
      if (!this.options.routes.admitSocket(request)) {
        this.options.logger.error("app", "WS network grant revoked; closing connection.");
        connection.close(1008, "Network grant revoked");
        return;
      }
      let payload: string;
      try { payload = JSON.stringify(frame); }
      catch (error) {
        const message = error instanceof Error ? boundedSocketError(error) : "Unknown serialization failure.";
        this.options.logger.error("app", `WS app ${kind} could not serialize: ${message}`);
        connection.close(1011, "Invalid app response");
        return;
      }
      const payloadBytes = Buffer.byteLength(payload);
      if (payloadBytes > MAX_OUTBOUND_FRAME_BYTES
        || connection.bufferedAmount + payloadBytes > MAX_BUFFERED_BYTES) {
        this.options.logger.error("app", `WS app ${kind} delivery exceeded its byte budget; closing connection.`);
        connection.close(1013, "Delivery backlog");
        return;
      }
      connection.send(payload, error => {
        if (error) this.options.logger.error("app",
          `WS network ${kind} send failed: ${boundedSocketError(error)}`);
      });
      const label = "kind" in frame ? describeFrame(frame) : `rpc ${method}`;
      if (kind === "workspaceDelta" && payloadBytes > WORKSPACE_PUSH_WARNING_BYTES) {
        this.options.logger.error("app", `WS oversized workspace push ${formatWebSocketBytes(payloadBytes)}: ${label}`);
      }
      this.recordTraffic("out", label, payloadBytes);
    };
    const bindState = (browserStateId: string | null) => {
      if (stateOwner !== undefined && stateOwner !== browserStateId) throw new Error("App state request changed browser owner.");
      stateOwner = browserStateId;
    };
    const workspace = this.options.workspace && this.options.sources && this.options.workspaceThreads
      && this.options.presentation && this.options.runtime && this.options.state
      ? new WorkbenchWorkspaceRequestController({
        workspace: this.options.workspace, sources: this.options.sources, threads: this.options.workspaceThreads,
        presentation: this.options.presentation,
        network: {
          read: () => ({ kind: "network", phase: this.options.network.getFacts().phase,
            failure: this.options.network.getFacts().failure, data: this.options.routes.snapshotFor(request, url) }),
          subscribe: listener => this.options.network.subscribe(listener),
        },
        runtime: {
          read: () => WorkbenchAppRuntimeResponseSchema.parse(this.options.runtime!.read()),
          subscribe: listener => this.options.runtime!.subscribe(listener),
        },
        appState: {
          read: browserStateId => {
            bindState(browserStateId);
            return this.options.state!.readWorkspaceBrowser(browserStateId ?? undefined,
              this.options.workspace!.getBindings());
          },
          subscribe: (browserStateId, listener) => {
            bindState(browserStateId);
            return this.options.state!.subscribeBrowser(browserStateId ?? undefined, listener);
          },
        },
        publishDelta: delta => send({ kind: "workspaceDelta", delta }),
        publishVoice: event => send({ kind: "voice", event }),
        publishThreadEvent: (notification, harness, daemonId) => send({ kind: "threadEvent", notification, harness, daemonId }),
        publishTranscript: event => send(event),
        warn: message => this.options.logger.error("app", message),
      }) : null;
    const sendImport = (status: ReturnType<WorkbenchPresentationImportController["snapshot"]>) =>
      send({ kind: "presentation-import", status });
    const unsubscribeImport = this.options.presentationImport?.subscribe(sendImport);
    const unsubscribeAdmission = this.options.network.subscribe(() => {
      if (!this.options.routes.admitSocket(request)) {
        this.options.logger.error("app", "WS network grant revoked; closing connection.");
        connection.close(1008, "Network grant revoked");
      }
    });
    const release = () => {
      if (released) return;
      released = true;
      unsubscribeImport?.();
      unsubscribeAdmission();
      workspace?.dispose();
      this.connections.delete(connection);
      this.options.logger.line("app", `WS network disconnected (${this.connections.size} active)`);
    };
    this.connections.set(connection, release);
    this.options.logger.line("app", `WS network connected (${this.connections.size} active)`);
    connection.once("close", release);
    connection.on("error", error => this.options.logger.error("app",
      `WS network connection failed: ${boundedSocketError(error)}`));
    connection.on("message", bytes => {
      if (this.suspended || released) return;
      let value: unknown;
      const raw = bytes.toString();
      const receivedBytes = Buffer.byteLength(raw);
      try { value = JSON.parse(raw); }
      catch {
        this.recordTraffic("in", "rpc invalid", receivedBytes);
        send({ id: null, error: { code: -32700, message: "Invalid app request." } });
        return;
      }
      const parsed = WorkbenchAppRpcRequestSchema.safeParse(value);
      this.recordTraffic("in", parsed.success ? `rpc ${parsed.data.method}` : "rpc invalid", receivedBytes);
      if (!parsed.success) {
        const id = value && typeof value === "object" && "id" in value
          && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0
          ? value.id : null;
        send({ id, error: { code: -32600, message: "Invalid app request." } });
        return;
      }
      const input = parsed.data;
      if (receivedBytes > MAX_INBOUND_FRAME_BYTES) {
        send({ id: input.id, error: { code: -32000, message: "App request exceeds its size limit." } }, input.method);
        return;
      }
      const operation = (async () => {
        if (!this.options.routes.admitSocket(request)) throw new Error("App network grant was revoked.");
        if (input.method === "workspace/thread/action") {
          if (!workspace) throw new Error("Workspace actions are unavailable.");
          return workspace.threadAction(input.params);
        }
        if (input.method === "workspace/layout") {
          if (!workspace) throw new Error("Workspace layouts are unavailable.");
          return workspace.layout(input.params);
        }
        if (input.method === "workspace/daemon/reload") {
          const source = input.params.daemonId ? this.options.sources?.get(input.params.daemonId) : this.options.sources?.attached;
          if (!source) throw new WorkbenchRpcRequestInterruptedError("Selected daemon is unavailable; reload was not sent.", false);
          return source.request<Json>(WORKBENCH_RELOAD_METHOD, input.params.request);
        }
        if (input.method === "workspace/thread/mutate") {
          if (!workspace) throw new Error("Workspace thread mutations are unavailable.");
          return workspace.mutateThread(input.params);
        }
        if (input.method === "workspace/transcript") {
          if (!workspace) throw new Error("Workspace transcripts are unavailable.");
          return workspace.transcript(input.params);
        }
        if (input.method === "workspace/command") {
          if (!workspace) throw new Error("Workspace commands are unavailable.");
          return workspace.command(input.params);
        }
        if (input.method === "workspace/observe") {
          if (!workspace) throw new Error("Workspace queries are unavailable.");
          return workspace.observe(input.params);
        }
        if (input.method === "workspace/release") {
          if (!workspace) throw new Error("Workspace queries are unavailable.");
          return workspace.release(input.params);
        }
        if (input.method === "workspace/draft/launch") {
          if (!this.options.workspaceDrafts) throw new Error("Draft launch service is unavailable.");
          return await this.options.workspaceDrafts.launch(input.params.draftId, input.params.expectedRevision, {
            ...input.params.context, additionalWritableRoots: input.params.additionalWritableRoots,
          });
        }
        if (input.method === "app/network/action") {
          if (!workbenchNetworkActionKeepsAppConnection(input.params.action)) {
            throw new Error("This network action requires HTTP connection handoff.");
          }
          return await this.options.routes.actionFor(request, input.params.action);
        }
        if (input.method === "app/presentation/mutate") {
          if (!this.options.presentation) throw new Error("App presentation is unavailable.");
          return this.options.presentation.mutate(input.params.mutation);
        }
        if (input.method === "app/settings/read") {
          if (!this.options.settings) throw new Error("App settings are unavailable.");
          return this.options.settings.read();
        }
        if (input.method === "app/settings/update") {
          if (!this.options.settings) throw new Error("App settings are unavailable.");
          if (!this.options.routes.canManageApp(request)) throw new Error("This device cannot change app settings.");
          return await this.options.settings.update(input.params);
        }
        if (input.method === "app/port/read") {
          if (!this.options.port) throw new Error("App port is unavailable.");
          return this.options.port.read(request);
        }
        if (!this.options.state) throw new Error("App state is unavailable.");
        const browserStateId = input.params.browserStateId;
        bindState(browserStateId);
        return await this.options.state.mutateBrowser(browserStateId ?? undefined,
          input.params.mutation, true);
      })().then(result => send({ id: input.id, result }, input.method), error => {
        const message = error instanceof Error ? boundedSocketError(error) : "Unknown app request failure.";
        this.options.logger.error("app", `WS app RPC ${input.method} failed: ${message}`);
        const data = error instanceof WorkbenchDaemonRequestError ? z.json().safeParse(error.data) : null;
        const code = error instanceof WorkbenchRpcRequestInterruptedError
          ? error.dispatched ? WORKSPACE_COMMAND_UNCERTAIN : WORKSPACE_COMMAND_NOT_SENT
          : error instanceof WorkbenchDaemonRequestError ? error.code : -32000;
        send({ id: input.id, error: { code, message,
          ...(data?.success ? { data: data.data } : {}) } }, input.method);
      });
      this.pendingRequests.add(operation);
      void operation.then(() => { this.pendingRequests.delete(operation); });
    });
    if (this.options.presentationImport) sendImport(this.options.presentationImport.snapshot());
  }

  private recordTraffic(direction: "in" | "out", kind: string, bytes: number) {
    const key = `${direction}:${kind}`;
    const window = this.traffic.get(key) ?? { count: 0, bytes: 0 };
    window.count++;
    window.bytes += bytes;
    this.traffic.set(key, window);
    this.scheduleTraffic();
  }

  private scheduleTraffic() {
    if (this.trafficTimer !== null) return;
    this.trafficTimer = setTimeout(() => {
      this.trafficTimer = null;
      this.flushTraffic();
    }, 2_000);
  }

  private flushTraffic() {
    for (const [key, { count, bytes }] of this.traffic) {
      const separator = key.indexOf(":");
      const direction = key.slice(0, separator);
      const label = key.slice(separator + 1);
      this.options.logger.line("app", formatWebSocketEventSummary(direction === "in" ? "in" : "out", `app:${label}`, count, bytes));
    }
    this.traffic.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.suspended = true;
    if (this.trafficTimer !== null) clearTimeout(this.trafficTimer);
    this.trafficTimer = null;
    this.flushTraffic();
    this.options.logger.line("app", `WS network routes reloading; retiring ${this.connections.size} connections`);
    this.retireConnections();
    this.server.close();
  }

  async quiesce() {
    if (this.closed) return;
    this.suspended = true;
    this.retireConnections();
    await Promise.all(this.pendingRequests);
  }

  resume() {
    if (!this.closed) this.suspended = false;
  }

  private retireConnections() {
    for (const [connection, release] of this.connections) {
      release();
      connection.terminate();
    }
  }
}
