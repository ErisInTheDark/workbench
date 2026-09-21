/*
 * Exports:
 * - default WorkbenchAppLifetime: own browser lifetime streams independently of scoped reloads.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export default class WorkbenchAppLifetime {
  private readonly streams = new Set<ServerResponse>();
  private closed = false;

  handle(request: IncomingMessage, response: ServerResponse) {
    if (this.closed) { response.writeHead(503); response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    if (request.method === "HEAD") { response.end(); return; }
    this.streams.add(response);
    response.once("close", () => this.streams.delete(response));
    response.write("event: ready\ndata: {}\n\n");
  }

  close() {
    this.closed = true;
    for (const response of this.streams) response.end("event: stopped\ndata: {}\n\n");
    this.streams.clear();
  }
}
