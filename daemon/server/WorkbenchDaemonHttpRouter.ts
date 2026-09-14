/*
 * Exports:
 * - WorkbenchDaemonHttpRouterOptions: reloadable HTTP controller ports owned by one route registry.
 * - default WorkbenchDaemonHttpRouter: dispatch non-shell daemon HTTP requests through reloadable feature controllers.
 */
import type http from "node:http";

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
  bridgeRequest: HttpController;
  gitArc: HttpController;
  legacyMigrationSource: HttpController;
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
        errorMessage: "Bridge request failed.",
        handle: (request, response) => options.bridgeRequest.handleHttpRequest(request, response),
        methods: ["POST"],
        path: "/daemon/bridge-request",
      },
      {
        errorMessage: "Legacy migration source failed.",
        handle: (request, response) => options.legacyMigrationSource.handleHttpRequest(request, response),
        methods: null,
        path: "/daemon/legacy-migration-source",
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

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
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
