/*
 * Exports:
 * - WorkbenchAppRuntimeOptions/default WorkbenchAppRuntime: own the stable graph host and reload ingress while leasing feature requests. Keywords: app, process, reload, HTTP.
 */
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";

import ReloadableNodeHost from "workbench-shared/reload/ReloadableNodeHost";
import { createReloadableNodeModuleLoader } from "workbench-shared/reload/reloadable-node-loader";
import { WORKBENCH_RELOAD_SCOPE_PATTERN, type WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

import type WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";

const RUNTIME_PATH = "/api/workbench-app-runtime";
const MAX_RELOAD_BODY_BYTES = 16_000;
const requiredRegistrations = [
  "compiler", "database", "http", "reloadController", "reloadDirt", "state", "topology",
] as const satisfies readonly (keyof AppRuntimeObjects)[];

export interface WorkbenchAppRuntimeOptions {
  appPort: WorkbenchAppPortControl;
  createCompiler(): WorkbenchFrontendCompiler;
  createDatabase(): WorkbenchAppStateRepository;
  logger: WorkbenchAppLogger;
  outputDirectoryPath: string;
  repositoryRootPath: string;
}

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readReloadScopes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_RELOAD_BODY_BYTES) throw new Error("App reload request is too large.");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("App reload request is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "scopes") || !Array.isArray(record.scopes)) {
    throw new Error("App reload request is invalid.");
  }
  const scopes = record.scopes;
  if (
    !scopes.length
    || scopes.length > 32
    || scopes.some((scope) => typeof scope !== "string" || !scope.startsWith("client:") || !WORKBENCH_RELOAD_SCOPE_PATTERN.test(scope))
  ) throw new Error("App reload scopes are invalid.");
  return [...new Set(scopes as string[])] as WorkbenchReloadScope[];
}

export default class WorkbenchAppRuntime {
  private readonly host: ReloadableNodeHost<AppProcessContext, AppRuntimeObjects, never>;

  constructor(private readonly options: WorkbenchAppRuntimeOptions) {
    let host!: ReloadableNodeHost<AppProcessContext, AppRuntimeObjects, never>;
    const context: AppProcessContext = {
      appPort: options.appPort,
      createCompiler: options.createCompiler,
      createDatabase: options.createDatabase,
      executeReloadScopes: async (scopes) => {
        const previous = host.get("reloadController");
        const applied = host.getDependantClosure(scopes);
        try {
          await host.reload(scopes);
          const current = host.get("reloadController");
          if (current !== previous) current.completeTransferredBatchIfPresent(applied);
          return applied;
        } catch (error) {
          const current = host.get("reloadController");
          if (current !== previous) current.failTransferredBatch(error);
          throw error;
        }
      },
      getReloadScopeCatalog: () => host.getReloadScopeCatalog(),
      getReloadScopesForPaths: (paths) => host.getReloadScopesForPaths(paths),
      logger: options.logger,
      outputDirectoryPath: options.outputDirectoryPath,
      repositoryRootPath: options.repositoryRootPath,
    };
    const loader = createReloadableNodeModuleLoader<AppProcessContext, AppRuntimeObjects, never>(
      createRequire(import.meta.url),
      "./app-root-node.ts",
    );
    host = new ReloadableNodeHost(context, loader, {
      onSwap: (scopes) => options.logger.line("app", `reloaded app nodes: ${scopes.join(", ")}`),
      processScope: {
        descriptor: {
          access: "operator",
          description: "Restart the Workbench app to replace its stable process shell.",
          destructive: true,
          safeAll: false,
          scope: "client:process",
        },
        sources: [
          "app/package.json",
          "app/tsconfig.json",
          "app/index.ts",
          "app/WorkbenchApp.ts",
          "app/WorkbenchAppLaunchLease.ts",
          "app/WorkbenchAppLogger.ts",
          "app/WorkbenchAppProcessProtocol.ts",
          "app/WorkbenchFrontendServer.ts",
          "app/runtime/WorkbenchAppRuntime.ts",
          "shared/http/HttpServer.ts",
          "shared/package.json",
          "shared/reload/reloadable-node-loader.ts",
          "shared/reload/ReloadableNode.ts",
          "shared/reload/ReloadableNodeHost.ts",
          "shared/reload/workbench-reload.ts",
          "shared/source-pattern-matcher.ts",
        ].join("\n"),
      },
      requiredRegistrations,
      requiredScopes: ["client:topology"],
      topologyScope: "client:topology",
    });
    this.host = host;
  }

  get outputDirectoryPath() {
    return this.options.outputDirectoryPath;
  }

  getReloadScopeCatalog() {
    return this.host.getReloadScopeCatalog();
  }

  getReloadScopesForPaths(paths: readonly string[]) {
    return this.host.getReloadScopesForPaths(paths);
  }

  async start() {
    await this.host.start();
  }

  async close() {
    await this.host.dispose();
  }

  readAppPort() {
    return this.host.get("state").readGlobalPreference("appPort");
  }

  async writeAppPort(port: number) {
    await this.host.get("state").mutate({
      action: "put",
      record: {
        kind: "globalPreference",
        preference: { key: "appPort", value: port },
      },
    });
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (url.pathname === RUNTIME_PATH && request.method === "GET") {
      sendJson(response, 200, { reloadDirt: this.host.get("reloadDirt").getSnapshot() });
      return;
    }
    if (url.pathname === RUNTIME_PATH && request.method === "POST") {
      try {
        sendJson(response, 202, this.host.get("reloadController").admit(await readReloadScopes(request)));
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message.slice(0, 500) : "App reload request failed.",
        });
      }
      return;
    }
    await this.host.run(
      "http",
      async (router) => await router.handle(request, response),
      `app HTTP: ${request.method ?? "UNKNOWN"} ${url.pathname}`,
    );
  }
}
