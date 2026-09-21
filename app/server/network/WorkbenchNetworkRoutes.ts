/*
 * Exports:
 * - default WorkbenchNetworkRoutes: own bounded same-origin network actions and disposable progress responses.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { WORKBENCH_NETWORK_PATH, WorkbenchNetworkActionSchema } from "workbench-shared/http/workbench-network";
import type WorkbenchNetworkController from "./WorkbenchNetworkController.ts";

export default class WorkbenchNetworkRoutes {
  private closed = false;
  private readonly responses = new Map<ServerResponse, () => void>();
  constructor(private readonly controller: Pick<WorkbenchNetworkController, "snapshot" | "subscribe" | "action" | "connection" | "ingress" | "discovery">) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const progress = url.pathname === `${WORKBENCH_NETWORK_PATH}/events`;
    if (url.pathname !== WORKBENCH_NETWORK_PATH && !progress) return false;
    if (this.closed) {
      this.send(response, 503, { error: "Network settings are reloading." });
      return true;
    }
    const capability = this.controller.ingress(request.headers);
    if (!capability) {
      this.send(response, 403, { error: "Authenticated network ingress is required." });
      return true;
    }
    const snapshot = () => {
      const current = this.controller.ingress(request.headers);
      const { localPort, change, daemon, discovery: _discovery, ...legacy } = this.controller.snapshot();
      const version = url.searchParams.get("capabilities");
      return { ...legacy,
        ...(version === "3" || version === "4" ? { localPort, change } : {}),
        ...(version === "4" ? { daemon, discovery: current ? this.controller.discovery(current.deviceNodeId) : { refreshing: false, peers: [] } } : {}),
        capabilities: {
          manageApp: current?.manageApp ?? false, manageNetwork: current?.manageNetwork ?? false,
          ...(["2", "3", "4"].includes(version ?? "") ? { trustHost: current?.trustHost ?? false } : {}),
          ...(version === "3" || version === "4" ? { localConnection: current?.deviceNodeId === null, settingsApply: true } : {}),
        } };
    };
    if (request.method === "GET" && !progress) {
      if (url.searchParams.get("connection") === "1") {
        this.send(response, 200, this.controller.connection());
      } else this.send(response, 200, snapshot());
      return true;
    }
    if (request.method === "GET" && progress) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-store",
        Connection: "keep-alive", "X-Accel-Buffering": "no",
      });
      const write = () => {
        if (!response.write(`data: ${JSON.stringify(snapshot())}\n\n`)) response.end();
      };
      const unsubscribe = this.controller.subscribe(write);
      this.own(response, unsubscribe);
      write();
      return true;
    }
    if (request.method !== "POST" || progress) {
      response.writeHead(405, { Allow: progress ? "GET" : "GET, POST" });
      response.end();
      return true;
    }
    if (!this.sameOrigin(request)
      || request.headers["x-workbench-network-request"] !== "1"
      || request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      this.send(response, 403, { error: "Network changes require a same-origin Workbench settings request." });
      return true;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 6_100_000) {
          this.send(response, 413, { error: "Network request is too large." });
          return true;
        }
        chunks.push(buffer);
      }
      const parsed = WorkbenchNetworkActionSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) {
        this.send(response, 400, { error: "Network action is invalid." });
        return true;
      }
      const networkAction = ["dns-app", "access", "access-prepare", "transfer-owner", "create-setup"].includes(parsed.data.action);
      const currentCapability = this.controller.ingress(request.headers);
      if (!currentCapability || (!currentCapability.manageApp && parsed.data.action !== "daemon-discovery-refresh") || (networkAction && !currentCapability.manageNetwork)
        || (parsed.data.action === "trust-host" && !currentCapability.trustHost)) {
        this.send(response, 403, { error: "This device cannot manage these network settings." });
        return true;
      }
      if (this.closed) {
        this.send(response, 503, { error: "Network settings are reloading." });
        return true;
      }
      if (currentCapability.deviceNodeId !== null
        && ["mode", "host-serve", "tailnet-port", "machine-name", "private-access", "remove-registration"].includes(parsed.data.action)) {
        this.send(response, 409, { error: "Refresh settings and use Apply to change this connection safely." });
        return true;
      }
      this.own(response, () => {});
      // The controller owns the operation, not an HTTP reload lease. Closing this
      // route ends its response; disposing the parent controller cancels the work.
      void this.controller.action(parsed.data, { deviceNodeId: currentCapability.deviceNodeId, origin: request.headers.origin! }).then(
        result => this.send(response, 200, result),
        () => this.send(response, 409, { error: this.controller.snapshot().failure ?? "Network action could not complete." }),
      );
    } catch {
      this.send(response, 400, { error: "Network request could not be read." });
    }
    return true;
  }

  close() {
    this.closed = true;
    for (const [response, release] of this.responses) {
      release();
      if (response.headersSent) response.end();
      else this.send(response, 503, { error: "Network settings are reloading." });
    }
    this.responses.clear();
  }

  private own(response: ServerResponse, unsubscribe: () => void) {
    const release = () => {
      unsubscribe();
      this.responses.delete(response);
      response.off("close", release);
    };
    this.responses.set(response, release);
    response.once("close", release);
  }

  private send(response: ServerResponse, status: number, value: object) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  private sameOrigin(request: IncomingMessage) {
    const origin = request.headers.origin;
    if (!origin || !request.headers.host) return false;
    try {
      const parsed = new URL(origin);
      const host = parsed.hostname.replace(/^\[|\]$/gu, "");
      const configuration = this.controller.snapshot().configuration.privateAccess;
      const privateHostname = configuration ? `${configuration.label}.wb.inthedark.boo` : null;
      if (parsed.origin !== origin || parsed.username || parsed.password) return false;
      // ingress() has authenticated these native headers before admission.
      // ReverseProxy rewrites Host to loopback; compare the original origin.
      const forwarded = request.headers["x-workbench-network-origin"];
      if (forwarded !== undefined) {
        return typeof forwarded === "string" && forwarded === origin
          && (parsed.protocol === "http:" && isIP(host) !== 0
            || parsed.protocol === "https:" && host === privateHostname && parsed.port === "");
      }
      if (parsed.protocol === "https:" && host === privateHostname && parsed.port === "") return true;
      return parsed.protocol === "http:"
        && (host === "localhost" || isIP(host) !== 0)
        && parsed.host === request.headers.host;
    } catch { return false; }
  }
}
