/*
 * Exports:
 * - default WorkbenchAppHttpRouter: own app routes, bounded client diagnostics, and static SPA resolution. Keywords: app, HTTP, client logs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

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

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
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
  private readonly portRoutes: WorkbenchAppPortRoutes;
  private readonly stateRoutes: WorkbenchAppStateRoutes;
  private readonly staticRequests: StaticHttpRequestController;

  constructor(private readonly options: {
    appPort: WorkbenchAppPortControl;
    logger: WorkbenchAppLogger;
    outputDirectoryPath: string;
    state: WorkbenchAppStateController;
  }) {
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
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Workbench app route not found." });
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

}
