/*
 * Exports:
 * - default WorkbenchAppControl: publish private app control and admit process-bound Quit.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";
import { publishServiceEndpoint, removeServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import type { WorkbenchAppProcessInfo } from "../../shared/http/workbench-app-control.ts";

export default class WorkbenchAppControl {
  private readonly instanceId = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private endpoint: WorkbenchServiceEndpoint | null = null;
  private publication = Promise.resolve();
  private closed = false;
  private quitRequested = false;

  constructor(private readonly options: {
    endpointPath: string;
    root: string;
    quit(): void;
    warn(message: string): void;
  }) {}

  publish(origin: string) {
    if (this.closed) return Promise.reject(new Error("App control is closed."));
    const endpoint: WorkbenchServiceEndpoint = { version: 1, instanceId: this.instanceId, pid: process.pid, origin, token: this.token };
    const publication = this.publication.then(async () => {
      if (this.closed) return;
      this.endpoint = endpoint;
      await publishServiceEndpoint(this.options.endpointPath, endpoint);
    });
    this.publication = publication;
    return publication;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? "";
    if (!url.startsWith("/_workbench-control/")) return false;
    const token = request.headers.authorization?.replace(/^Bearer /u, "");
    const forwarded = Object.keys(request.headers).some(key => key.startsWith("x-workbench-network-"));
    if (this.closed || !this.endpoint || forwarded || !token || !/^[a-f0-9]{64}$/u.test(token)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) {
      response.writeHead(403); response.end(); return true;
    }
    const send = (value: object) => {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (url === "/_workbench-control/health" && request.method === "GET") {
      const { token: _token, ...endpoint } = this.endpoint;
      send(endpoint);
    } else if (url === "/_workbench-control/process" && request.method === "GET") {
      const info: WorkbenchAppProcessInfo = { instanceId: this.instanceId,
        logDirectory: path.join(this.options.root, ".workbench", "logs"), logPrefix: "workbench-app" };
      send(info);
    } else if (url === `/_workbench-control/quit/${this.instanceId}` && request.method === "POST") {
      send({ ok: true });
      if (!this.quitRequested) {
        this.quitRequested = true;
        setImmediate(() => {
          try { this.options.quit(); }
          catch (error) {
            this.quitRequested = false;
            this.options.warn(`App Quit failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
    } else { response.writeHead(404); response.end(); }
    return true;
  }

  async close() {
    this.closed = true;
    try { await this.publication; }
    finally { await removeServiceEndpoint(this.options.endpointPath, this.instanceId); }
  }
}
