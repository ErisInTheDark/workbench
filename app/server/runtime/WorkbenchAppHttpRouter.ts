/*
 * Exports:
 * - default WorkbenchAppHttpRouter: own network admission, app routes/upgrades, client diagnostics and static SPA resolution.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import StaticHttpRequestController from "workbench-shared/http/StaticHttpRequestController";
import { isLoopbackConnection } from "workbench-shared/http/loopback-connection";
import { WORKBENCH_APP_PORT_PATH } from "workbench-shared/http/workbench-app-port";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";

import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import WorkbenchAppStateRoutes from "../state/workbench-app-state-routes.ts";
import WorkbenchPresentationRoutes from "../state/workbench-presentation-routes.ts";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController.ts";
import type WorkbenchPresentationImportController from "../state/WorkbenchPresentationImportController.ts";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type WebSocketTrafficBuffer from "workbench-shared/process/WebSocketTrafficBuffer";
import type WorkbenchWorkspaceController from "../workspace/WorkbenchWorkspaceController";
import type WorkbenchWorkspaceThreads from "../workspace/WorkbenchWorkspaceThreads";
import type WorkbenchWorkspaceDrafts from "../workspace/WorkbenchWorkspaceDrafts";
import WorkbenchWorkspaceAssetRoutes from "../workspace/WorkbenchWorkspaceAssetRoutes";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import WorkbenchAppPortRoutes from "./WorkbenchAppPortRoutes.ts";
import WorkbenchAppSettingsController from "./WorkbenchAppSettingsController.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes.ts";
import WorkbenchAppEventSocketController from "./WorkbenchAppEventSocketController.ts";

const CLIENT_LOG_PATH = "/api/workbench-client-log";
const MAX_CLIENT_LOG_BODY_BYTES = 128_000;
const MAX_CLIENT_LOG_ENTRIES = 100;
const MAX_CLIENT_LOG_MESSAGE = 8_000;

function requestKind(pathname: string) {
  if (pathname === "/api/workbench-network/events") return "network stream";
  if (/^\/api\/workbench-presentation\/drafts\/[^/]+\/attachments\//u.test(pathname)) return "draft image";
  if (pathname.startsWith("/api/workbench-presentation")) return "presentation";
  if (pathname.startsWith("/api/workbench-network")) return "network";
  if (pathname.startsWith("/api/workbench-client-state")) return "app state";
  if (pathname.startsWith("/api/workbench-app-port")) return "app port";
  if (pathname.startsWith("/api/workbench-app-settings")) return "app settings";
  if (pathname === CLIENT_LOG_PATH) return "client log";
  if (pathname.startsWith("/api/")) return "api";
  return /\.[a-z0-9]{1,8}$/iu.test(pathname) ? "asset" : "page";
}

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
  private readonly settingsRoutes: WorkbenchAppSettingsController | null;
  private readonly stateRoutes: WorkbenchAppStateRoutes;
  private readonly presentationRoutes: WorkbenchPresentationRoutes | null;
  private readonly staticRequests: StaticHttpRequestController;
  private readonly networkRoutes: WorkbenchNetworkRoutes | null;
  private readonly eventSockets: WorkbenchAppEventSocketController | null;
  private readonly importController: WorkbenchPresentationImportController | null;
  private readonly assets: WorkbenchWorkspaceAssetRoutes | null;

  constructor(private readonly options: {
    appPort: WorkbenchAppPortControl;
    logger: WorkbenchProcessLogger;
    network?: WorkbenchNetworkController;
    outputDirectoryPath: string;
    readAppliedReactDevelopmentMode?: () => boolean;
    state: WorkbenchBrowserStateRegistry;
    presentation?: WorkbenchPresentationController;
    sources?: WorkbenchDaemonSources;
    socketTraffic?: Pick<WebSocketTrafficBuffer, "record">;
    workspace?: WorkbenchWorkspaceController;
    workspaceThreads?: WorkbenchWorkspaceThreads;
    workspaceDrafts?: WorkbenchWorkspaceDrafts;
    presentationImport?: WorkbenchPresentationImportController;
    runtime?: ConstructorParameters<typeof WorkbenchAppEventSocketController>[0]["runtime"];
    supportsAppWebSockets?: boolean;
  }) {
    this.assets = options.sources ? new WorkbenchWorkspaceAssetRoutes({
      sources: options.sources, warn: message => options.logger.error("app", message),
    }) : null;
    this.importController = options.presentationImport ?? null;
    this.networkRoutes = options.network
      ? new WorkbenchNetworkRoutes(options.network) : null;
    this.portRoutes = new WorkbenchAppPortRoutes({
      appPort: {
        read: () => options.appPort.read(),
        update: port => options.network ? options.network.updateLocalPort(port) : options.appPort.update(port),
      },
      canUpdate: () => options.network?.canChangePort() ?? true,
      stableOrigin: request => {
        const forwarded = request.headers["x-workbench-network-origin"];
        const origin = typeof forwarded === "string" ? forwarded : `http://${request.headers.host ?? ""}`;
        return options.network?.stableOrigin(origin) ?? null;
      },
      onDiagnostic: (message) => options.logger.error("app", `http ${message}`),
    });
    this.settingsRoutes = options.readAppliedReactDevelopmentMode
      ? new WorkbenchAppSettingsController({
          readAppliedReactDevelopmentMode: options.readAppliedReactDevelopmentMode,
          readRequestedReactDevelopmentMode: () => (
            options.state.readGlobalPreference("reactDevelopmentMode")
          ),
          writeRequestedReactDevelopmentMode: async (value) => {
            await options.state.mutate({
              action: "put",
              record: {
                kind: "globalPreference",
                preference: { key: "reactDevelopmentMode", value },
              },
            });
          },
        })
      : null;
    this.stateRoutes = new WorkbenchAppStateRoutes(options.state);
    this.presentationRoutes = options.presentation ? new WorkbenchPresentationRoutes(options.presentation) : null;
    this.eventSockets = options.network && this.networkRoutes
      ? new WorkbenchAppEventSocketController({
          logger: options.logger, network: options.network, routes: this.networkRoutes,
          presentation: options.presentation, presentationImport: this.importController ?? undefined,
          state: options.state, runtime: options.runtime,
          settings: this.settingsRoutes, port: this.portRoutes,
          sources: options.sources, workspace: options.workspace,
          workspaceThreads: options.workspaceThreads, workspaceDrafts: options.workspaceDrafts,
          traffic: options.socketTraffic,
        }) : null;
    this.staticRequests = new StaticHttpRequestController({
      cacheSeconds: 0,
      rootDirectoryPath: options.outputDirectoryPath,
      spaFallbackPath: "index.html",
    });
  }

  async start() {
    await this.staticRequests.start();
  }

  async close() {
    this.assets?.dispose();
    this.eventSockets?.close();
    await this.presentationRoutes?.close();
    this.networkRoutes?.close();
    this.staticRequests.close();
  }

  async quiesceSockets() {
    await this.eventSockets?.quiesce();
  }

  resumeSockets() {
    this.eventSockets?.resume();
  }

  async admitHttp(request: IncomingMessage, response: ServerResponse) {
    if (this.admitConnection(request)) return true;
    response.setHeader("Connection", "close");
    sendJson(response, 403, { error: "Workbench is available only through localhost or Tailscale." });
    return false;
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    const pathname = new URL(request.url ?? "/", "http://workbench.local").pathname;
    const kind = requestKind(pathname);
    const method = request.method ?? "UNKNOWN";
    const startedAt = Date.now();
    const stream = kind === "network stream";
    let recorded = false;
    const record = (closed: boolean) => {
      if (recorded) return;
      recorded = true;
      const duration = `${Date.now() - startedAt}ms`;
      this.options.logger.line("app", `${method} ${kind} ${response.statusCode} ${closed ? "closed " : ""}in ${duration}`);
    };
    response.once("finish", () => record(stream));
    response.once("close", () => record(true));
    await this.route(request, response);
    if (stream && response.headersSent && !recorded && !response.writableEnded) {
      this.options.logger.line("app", `${method} ${kind} ${response.statusCode} open`);
    }
  }

  admitConnection(request: IncomingMessage) {
    const nativeHeaders = Object.keys(request.headers).some(key => key.startsWith("x-workbench-network-")
      && key !== "x-workbench-network-request");
    return Boolean(isLoopbackConnection(request.socket)
      && (!nativeHeaders || this.options.network?.ingress(request.headers)));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!this.admitConnection(request) || !this.eventSockets) {
      this.options.logger.error("app", "WS network upgrade rejected: app ingress unavailable.");
      socket.destroy();
      return;
    }
    this.eventSockets.handleUpgrade(request, socket, head);
  }

  private async route(request: IncomingMessage, response: ServerResponse) {
    if (!await this.admitHttp(request, response)) return;
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (url.pathname === WORKBENCH_APP_PORT_PATH && request.method !== "GET"
      && this.options.network && !this.options.network.ingress(request.headers)?.manageApp) {
      sendJson(response, 403, { error: "This device cannot change the app's network port." });
      return;
    }
    if (this.networkRoutes && await this.networkRoutes.handle(request, response, url)) return;
    if (url.pathname === CLIENT_LOG_PATH) {
      await this.handleClientLogs(request, response);
      return;
    }
    if (await this.portRoutes.handle(request, response, url)) return;
    if (this.assets && await this.assets.handle(request, response, url)) return;
    if (await this.stateRoutes.handle(request, response, url)) return;
    if (this.presentationRoutes && await this.presentationRoutes.handle(request, response, url)) return;
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
