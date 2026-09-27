/*
 * Exports:
 * - default WorkbenchAppEventSocketController: own reloadable app event sockets, grants, delivery and bounded logs.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import { WORKBENCH_APP_NETWORK_SOCKET_PATH } from "workbench-shared/http/workbench-app-events";
import { WorkbenchAppRpcRequestSchema } from "workbench-shared/http/workbench-app-rpc";
import { workbenchNetworkActionKeepsAppConnection } from "workbench-shared/http/workbench-network";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes.ts";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController.ts";
import type WorkbenchPresentationImportController from "../state/WorkbenchPresentationImportController.ts";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import type WorkbenchAppSettingsRoutes from "./WorkbenchAppSettingsRoutes.ts";
import type WorkbenchAppPortRoutes from "./WorkbenchAppPortRoutes.ts";

type Frame =
  | { kind: "network"; snapshot: ReturnType<WorkbenchNetworkRoutes["snapshotFor"]> }
  | { kind: "presentation"; event: { revision: number } }
  | { kind: "presentation-import"; status: ReturnType<WorkbenchPresentationImportController["snapshot"]> }
  | { kind: "state"; revision: number }
  | { kind: "runtime" };

function boundedSocketError(error: Error) {
  return error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 300);
}

const MAX_OUTBOUND_FRAME_BYTES = 16_000_000;
const MAX_BUFFERED_BYTES = 32_000_000;

export default class WorkbenchAppEventSocketController {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1_001_024 });
  private readonly connections = new Map<WebSocket, () => void>();
  private readonly traffic = new Map<string, { count: number; bytes: number }>();
  private trafficTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: {
    logger: WorkbenchProcessLogger;
    network: Pick<WorkbenchNetworkController, "subscribe">;
    routes: WorkbenchNetworkRoutes;
    presentation?: Pick<WorkbenchPresentationController, "subscribe" | "revision" | "read" | "mutate">;
    presentationImport?: Pick<WorkbenchPresentationImportController, "subscribe" | "snapshot">;
    state?: Pick<WorkbenchBrowserStateRegistry,
      "readBrowser" | "mutateBrowser" | "registerBrowserDaemon" | "remapBrowserProjects" | "subscribeBrowser">;
    settings?: Pick<WorkbenchAppSettingsRoutes, "read" | "update"> | null;
    port?: Pick<WorkbenchAppPortRoutes, "read">;
    runtime?: { read(): object; subscribe(listener: () => void): () => void };
    verifyAttachedDaemon?: (daemonId: string) => boolean;
  }) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (this.closed || url.pathname !== WORKBENCH_APP_NETWORK_SOCKET_PATH || !this.options.routes.admitSocket(request)) {
      this.options.logger.error("app", "WS network upgrade rejected: route, origin or network grant unavailable.");
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, connection => this.accept(connection, request, url));
  }

  private accept(connection: WebSocket, request: IncomingMessage, url: URL) {
    if (this.closed) { connection.close(1012, "App routes reloading"); return; }
    let released = false;
    let stateOwner: string | null | undefined;
    let unsubscribeState: (() => void) | null = null;
    const send = (frame: Frame | { id: number | null; result?: object; error?: { code: number; message: string } }) => {
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
      this.recordTraffic("out", kind, payloadBytes);
    };
    const sendNetwork = () => send({ kind: "network", snapshot: this.options.routes.snapshotFor(request, url) });
    const sendPresentation = (revision: number) => send({ kind: "presentation", event: { revision } });
    const sendImport = (status: ReturnType<WorkbenchPresentationImportController["snapshot"]>) =>
      send({ kind: "presentation-import", status });
    const unsubscribeNetwork = this.options.network.subscribe(sendNetwork);
    const unsubscribePresentation = this.options.presentation?.subscribe(sendPresentation);
    const unsubscribeImport = this.options.presentationImport?.subscribe(sendImport);
    const unsubscribeRuntime = this.options.runtime?.subscribe(() => send({ kind: "runtime" }));
    const release = () => {
      if (released) return;
      released = true;
      unsubscribeNetwork();
      unsubscribePresentation?.();
      unsubscribeImport?.();
      unsubscribeRuntime?.();
      unsubscribeState?.();
      this.connections.delete(connection);
      this.options.logger.line("app", `WS network disconnected (${this.connections.size} active)`);
    };
    this.connections.set(connection, release);
    this.options.logger.line("app", `WS network connected (${this.connections.size} active)`);
    connection.once("close", release);
    connection.on("error", error => this.options.logger.error("app",
      `WS network connection failed: ${boundedSocketError(error)}`));
    connection.on("message", bytes => {
      let value: unknown;
      const raw = bytes.toString();
      const receivedBytes = Buffer.byteLength(raw);
      this.recordTraffic("in", "rpc", receivedBytes);
      try { value = JSON.parse(raw); }
      catch {
        send({ id: null, error: { code: -32700, message: "Invalid app request." } });
        return;
      }
      const parsed = WorkbenchAppRpcRequestSchema.safeParse(value);
      if (!parsed.success) {
        const id = value && typeof value === "object" && "id" in value
          && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0
          ? value.id : null;
        send({ id, error: { code: -32600, message: "Invalid app request." } });
        return;
      }
      const input = parsed.data;
      if (receivedBytes > 1_001_024) {
        send({ id: input.id, error: { code: -32000, message: "App request exceeds its size limit." } });
        return;
      }
      void (async () => {
        if (!this.options.routes.admitSocket(request)) throw new Error("App network grant was revoked.");
        if (input.method === "app/network/read") return this.options.routes.snapshotFor(request, url);
        if (input.method === "app/network/action") {
          if (!workbenchNetworkActionKeepsAppConnection(input.params.action)) {
            throw new Error("This network action requires HTTP connection handoff.");
          }
          return await this.options.routes.actionFor(request, input.params.action);
        }
        if (input.method === "app/runtime/read") {
          if (!this.options.runtime) throw new Error("App runtime is unavailable.");
          return this.options.runtime.read();
        }
        if (input.method === "app/presentation/read") {
          if (!this.options.presentation) throw new Error("App presentation is unavailable.");
          return this.options.presentation.read();
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
          return this.options.port.read(request, new URL("/api/workbench-app-port?version=2", url));
        }
        if (!this.options.state) throw new Error("App state is unavailable.");
        const browserStateId = input.params.browserStateId;
        if (stateOwner !== undefined && stateOwner !== browserStateId) {
          throw new Error("App state request changed browser owner.");
        }
        if (stateOwner === undefined) {
          stateOwner = browserStateId;
          unsubscribeState = this.options.state.subscribeBrowser(browserStateId ?? undefined,
            revision => send({ kind: "state", revision }));
        }
        if (input.method === "app/state/read") {
          return await this.options.state.readBrowser(browserStateId ?? undefined,
            input.params.sinceRevision ?? undefined, true);
        }
        if (input.method === "app/state/mutate") {
          return await this.options.state.mutateBrowser(browserStateId ?? undefined,
            input.params.mutation, true);
        }
        if (input.method === "app/state/register") {
          if (input.params.request.attachedLocal
            && !this.options.verifyAttachedDaemon?.(input.params.request.daemonId)) {
            throw new Error("Daemon registration is invalid or not attached.");
          }
          await this.options.state.registerBrowserDaemon(browserStateId ?? undefined,
            input.params.request.daemonId, input.params.request.attachedLocal);
          return await this.options.state.readBrowser(browserStateId ?? undefined, undefined, true);
        }
        await this.options.state.remapBrowserProjects(browserStateId ?? undefined, input.params.request);
        return await this.options.state.readBrowser(browserStateId ?? undefined, undefined, true);
      })().then(result => send({ id: input.id, result }), error => {
        const message = error instanceof Error ? boundedSocketError(error) : "Unknown app request failure.";
        this.options.logger.error("app", `WS app RPC ${input.method} failed: ${message}`);
        send({ id: input.id, error: { code: -32000, message } });
      });
    });
    sendNetwork();
    if (this.options.presentation) sendPresentation(this.options.presentation.revision());
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
      const [direction, kind] = key.split(":");
      this.options.logger.line("app", ` WS ${direction} app:${kind} (count: ${count}, ${direction}: ${bytes}B)`);
    }
    this.traffic.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.trafficTimer !== null) clearTimeout(this.trafficTimer);
    this.trafficTimer = null;
    this.flushTraffic();
    this.options.logger.line("app", `WS network routes reloading; retiring ${this.connections.size} connections`);
    for (const [connection, release] of this.connections) {
      release();
      connection.terminate();
    }
    this.server.close();
  }
}
