/*
 * Exports:
 * - ServiceHttp: reloadable identity, control-upgrade and daemon-forwarding boundary.
 * - default ServiceHttpNode: own forwarding cancellation beneath network admission.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import HttpReverseProxy from "../../../shared/http/HttpReverseProxy.ts";
import ReloadableNode from "../../../shared/reload/ReloadableNode.ts";
import type { ServiceProcessContext } from "./service-process-context.ts";
import type { ServiceRuntimeObjects } from "./service-runtime-objects.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";

export class ServiceHttp {
  private readonly local: HttpReverseProxy;
  private readonly remote: HttpReverseProxy;

  constructor(private readonly context: Pick<ServiceProcessContext,
    "identity" | "daemonTarget" | "warn" | "proxyActivityChanged" | "ingressToken" | "control">,
    private readonly network: Pick<WorkbenchNetworkController, "browserEndpoints">) {
    this.local = new HttpReverseProxy({ target: signal => context.daemonTarget(signal, false), warn: context.warn,
      activityChanged: context.proxyActivityChanged });
    this.remote = new HttpReverseProxy({ target: signal => context.daemonTarget(signal, true), warn: context.warn,
      activityChanged: context.proxyActivityChanged });
  }

  hasPendingWork() { return this.local.hasPendingWork() || this.remote.hasPendingWork(); }

  async handle(request: IncomingMessage, response: ServerResponse) {
    const ingress = this.admit(request);
    if (ingress === null) {
      response.writeHead(403); response.end("Unverified network ingress."); return;
    }
    if (request.url === "/_workbench-service/identity" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      const identity = this.context.identity();
      response.end(JSON.stringify(request.headers["x-workbench-identity-version"] === "2"
        ? { identity, endpoints: this.network.browserEndpoints() }
        : identity));
      return;
    }
    if (!this.checkExpectedDaemon(request)) {
      response.writeHead(409, { "Cache-Control": "no-store" });
      response.end("Daemon identity changed.");
      return;
    }
    await (ingress ? this.remote : this.local).handle(request, response);
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const ingress = this.admit(request);
    if (ingress === null) { socket.destroy(); return; }
    if (request.url === "/control") {
      if (ingress) { socket.destroy(); return; }
      this.context.control(request, socket, head);
      return;
    }
    if (!this.checkExpectedDaemon(request)) { socket.destroy(); return; }
    await (ingress ? this.remote : this.local).upgrade(request, socket, head);
  }

  close() { this.local.close(); this.remote.close(); }

  private checkExpectedDaemon(request: IncomingMessage) {
    try {
      const url = new URL(request.url ?? "/", "http://workbench.local");
      const values = url.searchParams.getAll("wb-daemon");
      if (!values.length) return true;
      if (values.length !== 1 || !values[0]) return false;
      if (values[0] !== this.context.identity().daemonId) return false;
      url.searchParams.delete("wb-daemon");
      request.url = `${url.pathname}${url.search}`;
      return true;
    } catch {
      return false;
    }
  }

  private admit(request: IncomingMessage) {
    const forwarded = Object.keys(request.headers).some(key => key.startsWith("x-workbench-network-") && key !== "x-workbench-network-request");
    if (!forwarded) return false;
    const token = request.headers["x-workbench-network-token"];
    const device = request.headers["x-workbench-network-device"];
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token) || typeof device !== "string" || !device || device.length > 256) return null;
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(this.context.ingressToken))) return null;
    return true;
  }
}

export default ReloadableNode.define<ServiceProcessContext, ServiceRuntimeObjects, never>()({
  scope: "host:http", access: "operator", lifecycle: "atomic", safeAll: false,
  description: "Reload host control, identity and daemon forwarding.",
  requires: ["network"], provides: ["http"], children: [],
  sources: [
    "daemon/host/runtime/ServiceHttpNode.ts", "shared/http/HttpReverseProxy.ts",
    "shared/http/workbench-service.ts",
  ].join("\n"),
  create(context, build) {
    const http = new ServiceHttp(context, build.get("network"));
    return { registrations: { http }, start: () => {}, dispose: () => http.close() };
  },
});
