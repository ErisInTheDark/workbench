/*
 * Exports:
 * - default WorkbenchAppHttpRouter: own app routes, bounded client diagnostics, legacy proxying, and static SPA resolution. Keywords: app, HTTP, proxy, client logs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

import StaticHttpRequestController from "workbench-shared/http/StaticHttpRequestController";

import type WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import WorkbenchAppStateRoutes from "../state/workbench-app-state-routes.ts";
import type WorkbenchAppStateController from "../state/WorkbenchAppStateController.ts";
import WorkbenchAppPortRoutes from "./WorkbenchAppPortRoutes.ts";

const CLIENT_LOG_PATH = "/api/workbench-client-log";
const MAX_CLIENT_LOG_BODY_BYTES = 128_000;
const MAX_CLIENT_LOG_ENTRIES = 100;
const MAX_CLIENT_LOG_MESSAGE = 8_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function filteredHeaders(headers: IncomingMessage["headers"]) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendProxyFailure(response: ServerResponse) {
  if (response.headersSent) {
    if (!response.writableEnded) response.destroy();
    return;
  }
  response.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
  response.end("The legacy Workbench server is unavailable.");
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_CLIENT_LOG_BODY_BYTES) throw new Error("Client log request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseClientLogs(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("entries" in value)) {
    throw new Error("Client log batch is invalid.");
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_CLIENT_LOG_ENTRIES) {
    throw new Error("Client log batch has an invalid entry count.");
  }
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Client log entry is invalid.");
    const record = entry as Record<string, unknown>;
    if (
      (record.level !== "warn" && record.level !== "error")
      || typeof record.message !== "string"
      || !record.message
      || record.message.length > MAX_CLIENT_LOG_MESSAGE
      || Object.keys(record).some((key) => key !== "level" && key !== "message")
    ) throw new Error("Client log entry is invalid.");
    return { level: record.level, message: record.message };
  });
}

export default class WorkbenchAppHttpRouter {
  private readonly legacyOrigin: URL;
  private readonly portRoutes: WorkbenchAppPortRoutes;
  private readonly stateRoutes: WorkbenchAppStateRoutes;
  private readonly staticRequests: StaticHttpRequestController;

  constructor(private readonly options: {
    appPort: WorkbenchAppPortControl;
    legacyOrigin: string;
    logger: WorkbenchAppLogger;
    outputDirectoryPath: string;
    state: WorkbenchAppStateController;
  }) {
    this.legacyOrigin = new URL(options.legacyOrigin);
    if (this.legacyOrigin.protocol !== "http:" && this.legacyOrigin.protocol !== "https:") {
      throw new Error("Legacy Workbench origin must use HTTP or HTTPS.");
    }
    this.portRoutes = new WorkbenchAppPortRoutes({
      appPort: options.appPort,
      onDiagnostic: (message) => options.logger.error("http", message),
    });
    this.stateRoutes = new WorkbenchAppStateRoutes(options.state);
    this.staticRequests = new StaticHttpRequestController({
      rootDirectoryPath: options.outputDirectoryPath,
      spaFallbackPath: "index.html",
    });
  }

  async start() {
    await this.staticRequests.start();
  }

  close() {
    this.staticRequests.close();
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (url.pathname === CLIENT_LOG_PATH) {
      await this.handleClientLogs(request, response);
      return;
    }
    if (await this.portRoutes.handle(request, response, url)) return;
    if (await this.stateRoutes.handle(request, response, url)) return;
    if (url.pathname === "/icon" || url.pathname.startsWith("/api/")) {
      await this.proxyLegacyRequest(request, response);
      return;
    }
    await this.staticRequests.handleRequest(request, response);
  }

  private async handleClientLogs(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }
    try {
      const entries = parseClientLogs(await readBoundedJson(request));
      for (const entry of entries) this.options.logger.error("client", `[${entry.level}] ${entry.message}`);
      sendJson(response, 202, { accepted: entries.length });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message.slice(0, 500) : "Client log request failed.",
      });
    }
  }

  private async proxyLegacyRequest(request: IncomingMessage, response: ServerResponse) {
    const target = new URL(request.url ?? "/", this.legacyOrigin);
    const client = target.protocol === "https:" ? https : http;
    await new Promise<void>((resolve) => {
      const proxyRequest = client.request(target, {
        headers: { ...filteredHeaders(request.headers), host: target.host },
        method: request.method,
      }, (proxyResponse) => {
        response.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.statusMessage,
          filteredHeaders(proxyResponse.headers),
        );
        proxyResponse.once("error", (error) => {
          this.options.logger.error("http", `legacy response failed: ${error.message}`);
          if (!response.writableEnded) response.destroy(error);
          resolve();
        });
        proxyResponse.once("end", resolve);
        proxyResponse.pipe(response);
      });
      const fail = (error: Error) => {
        this.options.logger.error("http", `legacy request failed: ${error.message}`);
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
