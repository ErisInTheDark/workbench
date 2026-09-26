/*
 * Exports:
 * - default WorkbenchAppEventSocketController: own reloadable app event sockets, grants, delivery and bounded logs.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import { WORKBENCH_APP_NETWORK_SOCKET_PATH } from "workbench-shared/http/workbench-app-events";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes.ts";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController.ts";
import type WorkbenchPresentationImportController from "../state/WorkbenchPresentationImportController.ts";

type Frame =
  | { kind: "network"; snapshot: ReturnType<WorkbenchNetworkRoutes["snapshotFor"]> }
  | { kind: "presentation"; event: { revision: number } }
  | { kind: "presentation-import"; status: ReturnType<WorkbenchPresentationImportController["snapshot"]> };

function boundedSocketError(error: Error) {
  return error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 300);
}

export default class WorkbenchAppEventSocketController {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly connections = new Map<WebSocket, () => void>();
  private readonly traffic = new Map<Frame["kind"], { count: number; bytes: number }>();
  private trafficTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: {
    logger: WorkbenchProcessLogger;
    network: Pick<WorkbenchNetworkController, "subscribe">;
    routes: WorkbenchNetworkRoutes;
    presentation?: Pick<WorkbenchPresentationController, "subscribe" | "revision">;
    presentationImport?: Pick<WorkbenchPresentationImportController, "subscribe" | "snapshot">;
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
    const send = (frame: Frame) => {
      if (connection.readyState !== WebSocket.OPEN) return;
      if (!this.options.routes.admitSocket(request)) {
        this.options.logger.error("app", "WS network grant revoked; closing connection.");
        connection.close(1008, "Network grant revoked");
        return;
      }
      if (connection.bufferedAmount > 1_048_576) {
        this.options.logger.error("app", "WS network delivery backed up; closing connection.");
        connection.close(1013, "Delivery backlog");
        return;
      }
      const payload = JSON.stringify(frame);
      connection.send(payload, error => {
        if (error) this.options.logger.error("app",
          `WS network ${frame.kind} send failed: ${boundedSocketError(error)}`);
      });
      const window = this.traffic.get(frame.kind) ?? { count: 0, bytes: 0 };
      window.count++;
      window.bytes += Buffer.byteLength(payload);
      this.traffic.set(frame.kind, window);
      this.scheduleTraffic();
    };
    const sendNetwork = () => send({ kind: "network", snapshot: this.options.routes.snapshotFor(request, url) });
    const sendPresentation = (revision: number) => send({ kind: "presentation", event: { revision } });
    const sendImport = (status: ReturnType<WorkbenchPresentationImportController["snapshot"]>) =>
      send({ kind: "presentation-import", status });
    const unsubscribeNetwork = this.options.network.subscribe(sendNetwork);
    const unsubscribePresentation = this.options.presentation?.subscribe(sendPresentation);
    const unsubscribeImport = this.options.presentationImport?.subscribe(sendImport);
    const release = () => {
      if (released) return;
      released = true;
      unsubscribeNetwork();
      unsubscribePresentation?.();
      unsubscribeImport?.();
      this.connections.delete(connection);
      this.options.logger.line("app", `WS network disconnected (${this.connections.size} active)`);
    };
    this.connections.set(connection, release);
    this.options.logger.line("app", `WS network connected (${this.connections.size} active)`);
    connection.once("close", release);
    connection.on("error", error => this.options.logger.error("app",
      `WS network connection failed: ${boundedSocketError(error)}`));
    connection.on("message", () => {
      this.options.logger.error("app", "WS network rejected unexpected browser message.");
      connection.close(1003, "Notifications only");
    });
    sendNetwork();
    if (this.options.presentation) sendPresentation(this.options.presentation.revision());
    if (this.options.presentationImport) sendImport(this.options.presentationImport.snapshot());
  }

  private scheduleTraffic() {
    if (this.trafficTimer !== null) return;
    this.trafficTimer = setTimeout(() => {
      this.trafficTimer = null;
      this.flushTraffic();
    }, 2_000);
  }

  private flushTraffic() {
    for (const [kind, { count, bytes }] of this.traffic) {
      this.options.logger.line("app", ` WS out app:${kind} (count: ${count}, out: ${bytes}B)`);
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
