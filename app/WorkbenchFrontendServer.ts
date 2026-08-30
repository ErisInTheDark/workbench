/*
 * Exports:
 * - WorkbenchFrontendBuildOwner: compiler lifecycle required by the frontend server. Keywords: compiler, lifecycle, test seam.
 * - WorkbenchFrontendServerOptions: listener, legacy origin, compiler, and diagnostic configuration. Keywords: app server, proxy, configuration.
 * - default WorkbenchFrontendServer: own compiled SPA serving, launch redirect, legacy proxying, and compiler disposal. Keywords: app server, controller, lifecycle.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

import StaticHttpServer, { type StaticHttpServerAddress } from "workbench-shared/http/StaticHttpServer";

import WorkbenchFrontendCompiler from "./WorkbenchFrontendCompiler.ts";
import WorkbenchAppStateRoutes from "./state/workbench-app-state-routes.ts";

export interface WorkbenchFrontendBuildOwner {
  readonly outputDirectoryPath: string;
  close(): Promise<void>;
  startWatching(): Promise<string>;
}

export interface WorkbenchFrontendServerOptions {
  compiler?: WorkbenchFrontendBuildOwner;
  hostname?: string;
  legacyOrigin?: string;
  onDiagnostic?: (message: string) => void;
  port?: number;
  stateRoutes?: Pick<WorkbenchAppStateRoutes, "handle">;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseCookie(request: IncomingMessage, name: string) {
  const source = request.headers.cookie;
  if (!source) return null;
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function filteredHeaders(headers: IncomingMessage["headers"]) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function sendProxyFailure(response: ServerResponse) {
  if (response.headersSent) {
    if (!response.writableEnded) response.destroy();
    return;
  }
  response.writeHead(502, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end("The legacy Workbench server is unavailable.");
}

export default class WorkbenchFrontendServer {
  private readonly compiler: WorkbenchFrontendBuildOwner;
  private readonly hostname: string;
  private readonly legacyOrigin: URL;
  private readonly onDiagnostic: (message: string) => void;
  private readonly port: number;
  private readonly stateRoutes: Pick<WorkbenchAppStateRoutes, "handle">;
  private staticServer: StaticHttpServer | null = null;

  constructor(options: WorkbenchFrontendServerOptions = {}) {
    this.compiler = options.compiler ?? new WorkbenchFrontendCompiler();
    this.hostname = options.hostname?.trim() || "0.0.0.0";
    this.legacyOrigin = new URL(options.legacyOrigin ?? "http://127.0.0.1:3002");
    if (this.legacyOrigin.protocol !== "http:" && this.legacyOrigin.protocol !== "https:") {
      throw new Error("Legacy Workbench origin must use HTTP or HTTPS.");
    }
    this.onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
    this.port = options.port ?? 0;
    this.stateRoutes = options.stateRoutes ?? { handle: async () => false };
  }

  async start(): Promise<StaticHttpServerAddress> {
    if (this.staticServer) throw new Error("Workbench frontend server is already running.");

    await this.compiler.startWatching();
    const staticServer = new StaticHttpServer({
      beforeStaticRequest: async ({ request, response, url }) => {
        if (await this.stateRoutes.handle(request, response, url)) return true;
        if (url.pathname === "/icon" || url.pathname.startsWith("/api/")) {
          await this.proxyLegacyRequest(request, response);
          return true;
        }
        return false;
      },
      hostname: this.hostname,
      onError: (error) => this.onDiagnostic(`Workbench frontend HTTP failure: ${error.message}`),
      port: this.port,
      rootDirectoryPath: this.compiler.outputDirectoryPath,
      spaFallbackPath: "index.html",
    });
    this.staticServer = staticServer;

    try {
      return await staticServer.start();
    } catch (error) {
      this.staticServer = null;
      await this.compiler.close();
      throw error;
    }
  }

  async close() {
    const staticServer = this.staticServer;
    this.staticServer = null;
    await Promise.all([
      staticServer?.close(),
      this.compiler.close(),
    ]);
  }

  private async proxyLegacyRequest(request: IncomingMessage, response: ServerResponse) {
    const target = new URL(request.url ?? "/", this.legacyOrigin);
    const client = target.protocol === "https:" ? https : http;
    await new Promise<void>((resolve) => {
      const proxyRequest = client.request(target, {
        headers: {
          ...filteredHeaders(request.headers),
          host: target.host,
        },
        method: request.method,
      }, (proxyResponse) => {
        response.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.statusMessage,
          filteredHeaders(proxyResponse.headers),
        );
        proxyResponse.once("error", (error) => {
          this.onDiagnostic(`Legacy Workbench response failed: ${error.message}`);
          if (!response.writableEnded) response.destroy(error);
          resolve();
        });
        proxyResponse.once("end", resolve);
        proxyResponse.pipe(response);
      });

      const fail = (error: Error) => {
        this.onDiagnostic(`Legacy Workbench request failed: ${error.message}`);
        sendProxyFailure(response);
        resolve();
      };
      proxyRequest.once("error", fail);
      proxyRequest.once("close", resolve);
      request.once("aborted", () => proxyRequest.destroy());
      response.once("close", () => {
        if (!response.writableEnded) proxyRequest.destroy();
      });
      request.pipe(proxyRequest);
    });
  }
}
