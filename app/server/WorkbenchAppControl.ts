/*
 * Exports:
 * - default WorkbenchAppControl: publish private app control and admit Quit, reload and update operations.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";
import { publishServiceEndpoint, removeServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import { WorkbenchAppControlPullRequestSchema, type WorkbenchAppProcessInfo,
  type WorkbenchAppControlRuntime } from "../../shared/http/workbench-app-control.ts";
import { areDeeplyEqual } from "../../shared/workbench/deep-equality.ts";

interface OperationAdmission { start(): Promise<void>; cancel(): void; }

async function readPullRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_024) throw new Error("App pull request is too large.");
    chunks.push(buffer);
  }
  return WorkbenchAppControlPullRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export default class WorkbenchAppControl {
  private readonly instanceId = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private endpoint: WorkbenchServiceEndpoint | null = null;
  private publication = Promise.resolve();
  private closed = false;
  private quitRequested = false;
  private readonly streams = new Set<() => void>();

  constructor(private readonly options: {
    endpointPath: string;
    root: string;
    quit(): void;
    readRuntime?(): Promise<WorkbenchAppControlRuntime> | null;
    subscribeRuntime?(listener: () => void): () => void;
    reloadAll?(): OperationAdmission | null;
    pull?(reload: boolean): OperationAdmission | null;
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
    const send = (value: object, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (url === "/_workbench-control/health" && request.method === "GET") {
      const { token: _token, ...endpoint } = this.endpoint;
      send(endpoint);
    } else if (url === "/_workbench-control/process" && request.method === "GET") {
      const info: WorkbenchAppProcessInfo = { instanceId: this.instanceId,
        logDirectory: path.join(this.options.root, ".workbench", "logs"), logPrefix: "workbench-app" };
      send(info);
    } else if (url === "/_workbench-control/runtime/events" && request.method === "GET") {
      const initial = this.options.readRuntime?.();
      if (!initial) { send({ error: "App runtime is not ready." }, 503); return true; }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store",
        Connection: "keep-alive" });
      let open = true;
      let reading = false;
      let dirty = false;
      let previous: WorkbenchAppControlRuntime | null = null;
      let pendingInitial: Promise<WorkbenchAppControlRuntime> | null = initial;
      let unsubscribe = () => {};
      const close = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        this.streams.delete(close);
        response.end();
      };
      const changed = () => {
        dirty = true;
        if (reading || !open) return;
        reading = true;
        void (async () => {
          try {
            while (dirty && open) {
              dirty = false;
              const readingValue = pendingInitial ?? this.options.readRuntime?.();
              pendingInitial = null;
              const next = await readingValue;
              if (!open) return;
              if (!next) throw new Error("App runtime became unavailable.");
              if (areDeeplyEqual(previous, next)) continue;
              previous = next;
              if (!response.write(`data: ${JSON.stringify(next)}\n\n`)) {
                throw new Error("App runtime event consumer exceeded its delivery buffer.");
              }
            }
          } catch (error) {
            this.options.warn(`App runtime events failed: ${error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure."}`);
            close();
          } finally { reading = false; }
        })();
      };
      this.streams.add(close);
      response.once("close", close);
      unsubscribe = this.options.subscribeRuntime?.(changed) ?? (() => {});
      changed();
    } else if ((url === "/_workbench-control/runtime" && request.method === "GET")
      || ((url === "/_workbench-control/reload-all" || url === "/_workbench-control/pull") && request.method === "POST")) {
      void (async () => {
        if (url === "/_workbench-control/runtime") {
          const runtime = this.options.readRuntime?.();
          if (!runtime) { send({ error: "App runtime is not ready." }, 503); return; }
          send(await runtime);
          return;
        }
        let reload = false;
        if (url === "/_workbench-control/pull") {
          try { reload = (await readPullRequest(request)).reload; }
          catch { send({ error: "Invalid app pull request." }, 400); return; }
        }
        if (response.destroyed) return;
        const admission = url === "/_workbench-control/pull" ? this.options.pull?.(reload) : this.options.reloadAll?.();
        if (!admission) { send({ error: "App runtime is not ready." }, 503); return; }
        let acknowledged = false;
        response.once("finish", () => {
          acknowledged = true;
          void admission.start().catch(error => this.options.warn(
            `App control admission failed: ${error instanceof Error ? error.message.slice(0, 500) : "Unexpected failure."}`));
        });
        response.once("close", () => { if (!acknowledged && !response.writableFinished) admission.cancel(); });
        send({ admitted: true }, 202);
      })().catch(error => {
        const message = (error instanceof Error ? error.message : "App control failed.")
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500);
        this.options.warn(`App control failed: ${message}`);
        if (!response.headersSent && !response.destroyed) send({ error: message }, 409);
      });
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
    for (const close of [...this.streams]) close();
    try { await this.publication; }
    finally { await removeServiceEndpoint(this.options.endpointPath, this.instanceId); }
  }
}
