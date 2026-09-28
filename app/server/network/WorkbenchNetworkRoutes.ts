/*
 * Exports:
 * - default WorkbenchNetworkRoutes: admit app sockets and connection-changing HTTP handoffs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { WORKBENCH_NETWORK_PATH, WorkbenchNetworkActionSchema,
  type WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import type WorkbenchNetworkController from "./WorkbenchNetworkController.ts";

class NetworkActionAdmissionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export default class WorkbenchNetworkRoutes {
  private closed = false;
  private readonly responses = new Map<ServerResponse, () => void>();
  constructor(
    private readonly controller: Pick<WorkbenchNetworkController, "getFacts" | "subscribe" | "action" | "ingress" | "discovery">,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== WORKBENCH_NETWORK_PATH) return false;
    if (this.closed) {
      this.send(response, 503, { error: "Network settings are reloading." });
      return true;
    }
    const capability = this.controller.ingress(request.headers);
    if (!capability) {
      this.send(response, 403, { error: "Authenticated network ingress is required." });
      return true;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
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
      this.own(response, () => {});
      // The controller owns the operation, not an HTTP reload lease. Closing this
      // route ends its response; disposing the parent controller cancels the work.
      void this.actionFor(request, parsed.data).then(
        result => this.send(response, 200, result),
        error => this.send(response, error instanceof NetworkActionAdmissionError ? error.status : 409, {
          error: error instanceof NetworkActionAdmissionError ? error.message
            : this.controller.getFacts().failure ?? "Network action could not complete.",
        }),
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

  admitSocket(request: IncomingMessage) {
    return !this.closed && Boolean(this.controller.ingress(request.headers)) && this.sameOrigin(request);
  }

  canManageApp(request: IncomingMessage) {
    return this.admitSocket(request) && this.controller.ingress(request.headers)?.manageApp === true;
  }

  async actionFor(request: IncomingMessage, input: WorkbenchNetworkAction) {
    const action = WorkbenchNetworkActionSchema.parse(input);
    if (this.closed) throw new NetworkActionAdmissionError(503, "Network settings are reloading.");
    const capability = this.controller.ingress(request.headers);
    const networkAction = ["dns-app", "access", "access-prepare", "transfer-owner", "create-setup"].includes(action.action);
    if (!capability || !this.sameOrigin(request)
      || (!capability.manageApp && action.action !== "daemon-discovery-refresh")
      || networkAction && !capability.manageNetwork
      || action.action === "trust-host" && !capability.trustHost) {
      throw new NetworkActionAdmissionError(403, "This device cannot manage these network settings.");
    }
    if (capability.deviceNodeId !== null
      && ["mode", "host-serve", "tailnet-port", "machine-name", "private-access", "remove-registration"].includes(action.action)) {
      throw new NetworkActionAdmissionError(409, "Refresh settings and use Apply to change this connection safely.");
    }
    return await this.controller.action(action, {
      deviceNodeId: capability.deviceNodeId, origin: request.headers.origin!,
    });
  }

  snapshotFor(request: IncomingMessage, _url?: URL) {
    const current = this.controller.ingress(request.headers);
    const snapshot = this.controller.getFacts().snapshot;
    if (!snapshot) return null;
    return { ...snapshot,
      discovery: current ? this.controller.discovery(null) : { refreshing: false, peers: [] },
      capabilities: {
        manageApp: current?.manageApp ?? false, manageNetwork: current?.manageNetwork ?? false,
        trustHost: current?.trustHost ?? false,
        localConnection: current?.deviceNodeId === null, settingsApply: true,
        appEventsWebSocket: true,
      } };
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
      const configuration = this.controller.getFacts().snapshot?.configuration.privateAccess;
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
