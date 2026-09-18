/*
 * Exports:
 * - WorkbenchDaemonHttpRouterOptions: reloadable HTTP controller ports owned by one route registry.
 * - default WorkbenchDaemonHttpRouter: own connection admission and dispatch reloadable daemon HTTP routes.
 */
import type http from "node:http";
import { isLoopbackConnection } from "workbench-shared/http/loopback-connection";

interface HttpController {
  handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
}

interface ProjectSnapshotHttpController {
  handleTreeHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
}

interface ProjectCatalogHttpController extends HttpController {
  handleIconHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
}

export interface WorkbenchDaemonHttpRouterOptions {
  agentCommand: HttpController;
  gitArc: HttpController;
  mcp: HttpController;
  projectCatalog: ProjectCatalogHttpController;
  projectSnapshot: ProjectSnapshotHttpController;
  threadGit: HttpController;
  transcriptAssets?: HttpController;
}

interface RouteDefinition {
  errorMessage: string;
  handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
  methods: readonly string[] | null;
  path: string;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: object) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export default class WorkbenchDaemonHttpRouter {
  private readonly routes: readonly RouteDefinition[];

  constructor(private readonly options: WorkbenchDaemonHttpRouterOptions) {
    this.routes = [
      {
        errorMessage: "Git arc request failed.",
        handle: (request, response) => options.gitArc.handleHttpRequest(request, response),
        methods: ["POST"],
        path: "/daemon/git-arc",
      },
      {
        errorMessage: "Thread Git request failed.",
        handle: (request, response) => options.threadGit.handleHttpRequest(request, response),
        methods: ["POST"],
        path: "/daemon/thread-git",
      },
      {
        errorMessage: "Agent command failed.",
        handle: (request, response) => options.agentCommand.handleHttpRequest(request, response),
        methods: ["POST"],
        path: "/daemon/agent-command",
      },
      {
        errorMessage: "Workbench MCP request failed.",
        handle: (request, response) => options.mcp.handleHttpRequest(request, response),
        methods: ["GET", "POST", "DELETE"],
        path: "/daemon/mcp",
      },
      {
        errorMessage: "Project discovery failed.",
        handle: (request, response) => options.projectCatalog.handleHttpRequest(request, response),
        methods: ["GET"],
        path: "/daemon/projects",
      },
      {
        errorMessage: "Project tree request failed.",
        handle: (request, response) => options.projectSnapshot.handleTreeHttpRequest(request, response),
        methods: ["GET", "POST"],
        path: "/daemon/tree",
      },
    ];
  }

  async admitUpgrade(request: http.IncomingMessage) {
    if (isLoopbackConnection(request.socket)) return !request.socket.destroyed;
    request.socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return false;
  }

  async admitHttp(request: http.IncomingMessage, response: http.ServerResponse) {
    if (isLoopbackConnection(request.socket)) return true;
    response.setHeader("Connection", "close");
    sendJson(response, 403, { error: "Workbench is available only through localhost or Tailscale." });
    return false;
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!await this.admitHttp(request, response)) return;
    const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && requestPath.startsWith("/daemon/project-icons/")) {
      try {
        await this.options.projectCatalog.handleIconHttpRequest(request, response);
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "Project icon request failed." });
      }
      return;
    }
    if (this.options.transcriptAssets && request.method === "GET" && requestPath.startsWith("/daemon/transcript-assets/")) {
      try {
        await this.options.transcriptAssets.handleHttpRequest(request, response);
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "Transcript asset request failed." });
      }
      return;
    }
    const route = this.routes.find((candidate) => (
      candidate.path === requestPath
      && (candidate.methods === null || candidate.methods.includes(request.method ?? ""))
    ));
    if (!route) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    try {
      await route.handle(request, response);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : route.errorMessage });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  }
}
