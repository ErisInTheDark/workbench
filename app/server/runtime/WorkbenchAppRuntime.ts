/*
 * Exports:
 * - WorkbenchAppRuntimeOptions: process-owned compiler, database, logging, and port configuration.
 * - default WorkbenchAppRuntime: own the stable graph host and reload ingress while leasing requests.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import ReloadableNodeHost from "workbench-shared/reload/ReloadableNodeHost";
import { createReloadableNodeModuleLoader } from "workbench-shared/reload/reloadable-node-loader";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import {
  WORKBENCH_RELOAD_SCOPE_PATTERN,
  type WorkbenchReloadDirtSnapshot,
  type WorkbenchReloadScope,
} from "workbench-shared/reload/workbench-reload";

import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";

const RUNTIME_PATH = "/api/workbench-app-runtime";
const MAX_RELOAD_BODY_BYTES = 16_000;
const requiredRegistrations = [
  "compiler", "database", "http", "logger", "network", "reloadController", "reloadDirt", "state", "topology",
] as const satisfies readonly (keyof AppRuntimeObjects)[];

export interface WorkbenchAppRuntimeOptions {
  appPort: WorkbenchAppPortControl;
  createCompiler(logger: WorkbenchProcessLogger, readReactDevelopmentMode: () => boolean): WorkbenchFrontendCompiler;
  createDatabase(Repository: typeof WorkbenchAppStateRepository): WorkbenchAppStateRepository;
  createNetwork?: AppProcessContext["createNetwork"];
  daemonEndpointPath?: string;
  logger: WorkbenchProcessLogger;
  outputDirectoryPath: string;
  repositoryRootPath: string;
  requestProcessRestart?: () => Promise<void> | void;
}

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function projectReloadDirt(
  snapshot: WorkbenchReloadDirtSnapshot,
  includeDependants: boolean,
): WorkbenchReloadDirtSnapshot {
  if (includeDependants) return snapshot;
  return {
    ...snapshot,
    dirtyScopes: snapshot.dirtyScopes.map(({ dependantScopes: _dependantScopes, ...scope }) => scope),
  };
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
    || scopes.some((scope) => typeof scope !== "string" || (!scope.startsWith("client:") && !scope.startsWith("host:")) || !WORKBENCH_RELOAD_SCOPE_PATTERN.test(scope))
  ) throw new Error("App reload scopes are invalid.");
  return [...new Set(scopes as string[])] as WorkbenchReloadScope[];
}

export default class WorkbenchAppRuntime {
  private appliedReactDevelopmentMode: boolean | null = null;
  private readonly host: ReloadableNodeHost<AppProcessContext, AppRuntimeObjects, never>;

  constructor(private readonly options: WorkbenchAppRuntimeOptions) {
    let host!: ReloadableNodeHost<AppProcessContext, AppRuntimeObjects, never>;
    const context: AppProcessContext = {
      daemonEndpointPath: options.daemonEndpointPath ?? path.join(resolveWorkbenchDataRoot(), "daemon", "runtime.json"),
      appPort: options.appPort,
      createCompiler: (logger, readReactDevelopmentMode) => options.createCompiler(logger, () => {
        this.appliedReactDevelopmentMode ??= readReactDevelopmentMode();
        return this.appliedReactDevelopmentMode;
      }),
      createDatabase: options.createDatabase,
      createNetwork: options.createNetwork,
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
      outputDirectoryPath: options.outputDirectoryPath,
      processLogger: options.logger,
      readAppliedReactDevelopmentMode: () => {
        if (this.appliedReactDevelopmentMode === null) {
          throw new Error("Workbench frontend mode is unavailable before compiler startup.");
        }
        return this.appliedReactDevelopmentMode;
      },
      repositoryRootPath: options.repositoryRootPath,
    };
    const require = createRequire(import.meta.url);
    const loader = createReloadableNodeModuleLoader<AppProcessContext, AppRuntimeObjects, never>(
      require,
      "./app-root-node.ts",
      {
        repoRoot: options.repositoryRootPath,
        processModule: require.cache[require.resolve("../WorkbenchAppProcess.ts")],
      },
    );
    host = new ReloadableNodeHost(context, loader, {
      sourceExclusions: ["app/client/**"],
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
          "app/server/index.ts",
          "package.json",
          "shared/package.json",
          "app/tray/**",
          "!app/tray/target/**",
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

  async stopNetwork() {
    await this.host.get("network").suspend();
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
    if (!await this.host.get("http").admitHttp(request, response)) return;
    const url = new URL(request.url ?? "/", "http://workbench.local");
    if (url.pathname === RUNTIME_PATH && request.method === "GET") {
      const responseVersion = url.searchParams.get("version");
      const reloadDirt = this.host.get("reloadDirt").getSnapshot();
      const requestedReactDevelopmentMode = this.host.get("state")
        .readGlobalPreference("reactDevelopmentMode") === true;
      const appliedReactDevelopmentMode = this.appliedReactDevelopmentMode;
      const projectedDirt = requestedReactDevelopmentMode !== appliedReactDevelopmentMode
        && !reloadDirt.dirtyScopes.some(({ scope }) => scope === "client:process")
        ? {
            ...reloadDirt,
            dirtyScopes: [
              ...reloadDirt.dirtyScopes,
              {
                dependantScopes: this.host.getReloadScopeCatalog().map(({ scope }) => scope),
                description: "Restart the Workbench app to apply app-wide settings.",
                destructive: true,
                scope: "client:process",
              },
            ],
          }
        : reloadDirt;
      const hostDirt = responseVersion === "4" ? this.host.get("network").hostReloadDirt() : null;
      const combinedDirt = hostDirt ? {
        dirtyScopes: [...projectedDirt.dirtyScopes, ...hostDirt.dirtyScopes],
        pendingScopes: [...projectedDirt.pendingScopes, ...hostDirt.pendingScopes],
        error: [projectedDirt.error, hostDirt.error].filter(Boolean).join(" ").slice(0, 500) || null,
      } : projectedDirt;
      sendJson(response, 200, {
        ...(responseVersion === "3" || responseVersion === "4"
          ? { frontendGeneration: this.host.get("compiler").getFrontendGeneration() }
          : {}),
        reloadDirt: projectReloadDirt(
          combinedDirt,
          responseVersion === "2" || responseVersion === "3" || responseVersion === "4",
        ),
      });
      return;
    }
    if (url.pathname === RUNTIME_PATH && request.method === "POST") {
      try {
        const scopes = await readReloadScopes(request);
        const hostScopes = scopes.filter(scope => scope.startsWith("host:"));
        const clientScopes = scopes.filter(scope => scope.startsWith("client:"));
        if (clientScopes.length && !clientScopes.includes("client:process")) this.host.validateReloadScopes(clientScopes);
        const admission = clientScopes.length ? this.host.get("reloadController").admit(
          clientScopes,
          this.options.requestProcessRestart,
        ) : null;
        if (hostScopes.length) {
          try { await this.host.get("network").reloadHost(hostScopes); }
          catch (error) { admission?.cancel(); throw error; }
          if (!clientScopes.length) {
            sendJson(response, 202, {
              ok: true, state: "running", requestedScopes: hostScopes, queuedScopes: hostScopes,
              appliedScopes: [], startedAt: Date.now(), completedAt: null, error: null,
            });
            return;
          }
        }
        if (!admission) throw new Error("No app reload scopes were admitted.");
        let acknowledged = false;
        response.once("finish", () => {
          acknowledged = true;
          void admission.start().catch((error) => {
            this.options.logger.error(
              "app",
              `reload execution failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        });
        response.once("close", () => {
          if (acknowledged || response.writableFinished) return;
          admission.cancel();
        });
        sendJson(response, 202, {
          ...admission.response,
          requestedScopes: scopes,
          queuedScopes: [...hostScopes, ...admission.response.queuedScopes],
        });
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
