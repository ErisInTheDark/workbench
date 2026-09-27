/*
 * Exports:
 * - default WorkbenchAppLifetime: own browser lifetime streams independently of scoped reloads.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";

const readyFrame = JSON.stringify({ kind: "ready" });
const stoppedFrame = JSON.stringify({ kind: "stopped" });

function boundedSocketError(error: Error) {
  return error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 300);
}

export default class WorkbenchAppLifetime {
  private readonly streams = new Set<ServerResponse>();
  private readonly sockets = new Set<WebSocket>();
  private readonly socketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private closed = false;

  constructor(private readonly logger?: WorkbenchProcessLogger) {}

  handle(request: IncomingMessage, response: ServerResponse) {
    if (this.closed) { response.writeHead(503); response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    const capabilities = new URL(request.url ?? "/", "http://workbench.local").searchParams.get("capabilities");
    const wantsSocket = capabilities === "2" || capabilities === "3";
    response.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store",
      ...(wantsSocket ? { "X-Workbench-App-Lifetime-Socket": "1" } : {}),
      ...(capabilities === "3" ? { "X-Workbench-App-Rpc": "1" } : {}),
    });
    if (request.method === "HEAD") { response.end(); return; }
    this.streams.add(response);
    response.once("close", () => this.streams.delete(response));
    response.write("event: ready\ndata: {}\n\n");
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = request.headers.origin;
    const forwarded = request.headers["x-workbench-network-origin"];
    const expected = typeof forwarded === "string" ? forwarded
      : `http://${request.headers.host ?? ""}`;
    if (this.closed || !origin || origin !== expected) {
      this.logger?.error("app", "WS lifetime upgrade rejected: app unavailable or origin mismatch.");
      socket.destroy();
      return;
    }
    this.socketServer.handleUpgrade(request, socket, head, connection => {
      if (this.closed) { connection.close(1012, "App stopped"); return; }
      this.sockets.add(connection);
      this.logger?.line("app", `WS lifetime connected (${this.sockets.size} active)`);
      connection.once("close", () => {
        this.sockets.delete(connection);
        this.logger?.line("app", `WS lifetime disconnected (${this.sockets.size} active)`);
      });
      connection.on("error", error => this.logger?.error("app",
        `WS lifetime connection failed: ${boundedSocketError(error)}`));
      connection.on("message", () => {
        this.logger?.error("app", "WS lifetime rejected unexpected browser message.");
        connection.close(1003, "Notifications only");
      });
      connection.send(readyFrame, error => {
        if (error) this.logger?.error("app", `WS lifetime ready send failed: ${boundedSocketError(error)}`);
      });
      this.logger?.line("app", ` WS out app:lifetime/ready (count: 1, out: ${readyFrame.length}B)`);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const response of this.streams) response.end("event: stopped\ndata: {}\n\n");
    this.streams.clear();
    for (const connection of this.sockets) {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(stoppedFrame, error => {
          if (error) this.logger?.error("app", `WS lifetime stop send failed: ${boundedSocketError(error)}`);
          connection.close(1001, "App stopped");
        });
        this.logger?.line("app", ` WS out app:lifetime/stopped (count: 1, out: ${stoppedFrame.length}B)`);
      } else connection.close();
    }
    this.socketServer.close();
  }
}
