/*
 * Exports:
 * - startOrchestrator side effect: starts the Workbench bridge server, managed Next.js dev server, Browse cleanup supervisor, and bridge integrations. Keywords: orchestrator, next-dev, codex, copilot, opencode.
 *
 * Helpers:
 * - HTTP reload helpers: parse, proxy, queue, and report orchestrator reload scopes. Keywords: reload, next-dev, bridge.
 * - Server bridge request helpers: route allowlisted stateless Next RPCs over buffered HTTP into live harness bridges. Keywords: bridge, http, rpc, allowlist, server.
 * - Legacy migration source helper: expose capability-fenced bounded catalog pages and selected snapshots from stable bridges. Keywords: migration, readonly, lazy, bridge.
 * - Browse ingress helpers: route native agent commands directly and stateless Next proxies through the drainable orchestrator-owned Browse controller. Keywords: browse, agent, direct, controller, queue, streaming, reload.
 * - Project catalog and snapshot HTTP helpers: route stateless Next proxies through orchestrator-owned structured discovery and bounded tree caches. Keywords: project, catalog, tree, snapshot, cache, watcher, reload.
 * - Child process helpers: start, restart, and schedule managed process lifecycles. Keywords: process, restart, child.
 * - Bridge helpers: route websocket JSON-RPC messages across Codex, Copilot, and OpenCode harnesses. Keywords: websocket, harness, rpc.
 * - Health helpers: supervise the Next.js dev server and restart it after repeated 5xx health probes. Keywords: watchdog, turbopack, 500.
 * - Codex recovery helpers: replace and reinitialize a failed Codex bridge while a supervisor owns retry timing. Keywords: codex, recovery, retry, lifecycle.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

import { WebSocketServer } from "next/dist/compiled/ws";

import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import { createInitializeCapabilities, createInitializeRequest } from "../lib/codex/protocol";
import { getCurrentInProgressTurn, getCurrentTurn, hasThreadActiveFlag } from "../lib/codex/thread-state";
import type {
    OrchestratorReloadRequest,
    OrchestratorReloadResponse,
    OrchestratorReloadScope,
    WorkbenchBrowseResultEntry,
    WorkbenchHarness,
} from "../lib/types";
import {
    normalizeOrchestratorReloadScopes,
    validateOrchestratorReloadScopeCombination,
} from "../lib/workbench/orchestrator-reload";
import {
    createWorkbenchThreadRecoveryInput,
    isWorkbenchThreadRecoveryUserMessage,
} from "../lib/workbench/thread/thread-recovery-message";
import type { BridgeClient, HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexAppServer from "./CodexAppServer";
import CodexBridgeTransitionController from "./CodexBridgeTransitionController";
import CodexRecoverySupervisor from "./CodexRecoverySupervisor";
import CodexStdioBridge from "./CodexStdioBridge";
import { CopilotBridge } from "./copilot-bridge";
import { OpenCodeBridge } from "./opencode-bridge";
import {
    createSpawnOptions,
    getSpawnDescriptor,
    killProcessTree,
    log,
    logError,
    pipeChildStream,
    type ProcessSpec,
    type RunningProcess,
} from "./process-helpers";
import {
    loadOrchestratorReloadableModules,
    reloadOrchestratorReloadableModules,
} from "./reloadable-modules";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import WorkbenchTurnRecoveryHandoffStore, { type WorkbenchTurnRecoveryHandoffCandidate } from "./WorkbenchTurnRecoveryHandoffStore";

const ORCHESTRATOR_ROOT = __dirname;
const WEBAPP_ROOT = path.resolve(ORCHESTRATOR_ROOT, "..");
const PROJECT_ROOT = path.resolve(WEBAPP_ROOT, "..");
const DEFAULT_CODEX_BRIDGE_URL = "ws://0.0.0.0:4500";
const CODEX_BRIDGE_URL = process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_BRIDGE_URL;
const NEXT_PORT = process.env.PORT ?? "3002";
const RESTART_DELAY_MS = 1000;
const NEXT_DEV_HEALTH_PATH = "/api/next-dev-health";
const NEXT_DEV_HEALTH_INTERVAL_MS = 5000;
const NEXT_DEV_HEALTH_REQUEST_TIMEOUT_MS = 2000;
const NEXT_DEV_HEALTH_RESTART_COOLDOWN_MS = 30000;
const NEXT_DEV_HEALTH_SERVER_ERROR_THRESHOLD = 3;
const ORCHESTRATOR_RELOAD_PATH = "/orchestrator/reload";
const ORCHESTRATOR_BROWSE_PATH = "/orchestrator/browse";
const ORCHESTRATOR_BROWSE_SESSIONS_PATH = "/orchestrator/browse/sessions";
const ORCHESTRATOR_AGENT_COMMAND_PATH = "/orchestrator/agent-command";
const ORCHESTRATOR_BRIDGE_REQUEST_PATH = "/orchestrator/bridge-request";
const ORCHESTRATOR_LEGACY_MIGRATION_SOURCE_PATH = "/orchestrator/legacy-migration-source";
const ORCHESTRATOR_PROJECTS_PATH = "/orchestrator/projects";
const ORCHESTRATOR_TREE_PATH = "/orchestrator/tree";
const CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS = 5000;
const CODEX_RECOVERY_INITIAL_RETRY_DELAY_MS = 1000;
const CODEX_RECOVERY_MAX_RETRY_DELAY_MS = 30000;
const CODEX_HEALTH_INTERVAL_MS = 30000;
const CODEX_HEALTH_REQUEST_TIMEOUT_MS = 5000;
const CODEX_HEALTH_FAILURE_THRESHOLD = 5;
const BROWSE_CONTROLLER_RELOAD_DRAIN_TIMEOUT_MS = 5000;
const WORKBENCH_HARNESS_FIELD = "workbenchHarness";

function readNonEmptyEnv(value: string | undefined) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

function parseWebSocketPort(url: string) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error(`Codex bridge URL must use ws:// or wss://, received ${url}`);
  }

  return parsedUrl.port || (parsedUrl.protocol === "wss:" ? "443" : "80");
}

const CODEX_PUBLIC_BRIDGE_URL = readNonEmptyEnv(process.env.NEXT_PUBLIC_CODEX_APP_SERVER_URL);
const CODEX_PUBLIC_BRIDGE_PORT = readNonEmptyEnv(process.env.NEXT_PUBLIC_CODEX_APP_SERVER_PORT)
  ?? parseWebSocketPort(CODEX_PUBLIC_BRIDGE_URL ?? CODEX_BRIDGE_URL);
const LOCAL_WORKBENCH_ORIGIN = readNonEmptyEnv(process.env.NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN)
  ?? `http://127.0.0.1:${NEXT_PORT}`;
const LOCAL_ORCHESTRATOR_ORIGIN = `http://127.0.0.1:${parseWebSocketPort(CODEX_BRIDGE_URL)}`;
const workbenchAgentCliEnvironment = new WorkbenchAgentCliEnvironment({
  origin: LOCAL_ORCHESTRATOR_ORIGIN,
  runtimeDirectoryPath: path.join(WEBAPP_ROOT, "node_modules", ".bin"),
  shellSourcePath: path.join(WEBAPP_ROOT, "lib", "workbench", "cli", "workbench-agent-cli.sh"),
});

const nextDevEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CODEX_APP_SERVER_URL: CODEX_BRIDGE_URL,
  NEXT_PUBLIC_CODEX_APP_SERVER_PORT: CODEX_PUBLIC_BRIDGE_PORT,
  NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN: LOCAL_WORKBENCH_ORIGIN,
  PORT: NEXT_PORT,
};

if (CODEX_PUBLIC_BRIDGE_URL) {
  nextDevEnv.NEXT_PUBLIC_CODEX_APP_SERVER_URL = CODEX_PUBLIC_BRIDGE_URL;
}

const processes = new Map<string, RunningProcess>();
const bridgeConnections = new Set<BridgeClient>();
let bridgeServer: http.Server | null = null;
let bridgeWebSocketServer: WebSocketServer | null = null;
let codexReadyPromise: Promise<void> | null = null;
let lastReloadResponse: OrchestratorReloadResponse = {
  appliedScopes: [],
  completedAt: null,
  error: null,
  ok: true,
  queuedScopes: [],
  requestedScopes: [],
  startedAt: null,
  state: "idle",
};
let reloadableModules = loadOrchestratorReloadableModules();
let workbenchAgentCommandController = createAgentCommandController();
let bridgeRequestController = createBridgeRequestController();
let legacyMigrationSourceController = createLegacyMigrationSourceController();
let shuttingDown = false;
let codexBridge: CodexStdioBridge;
let opencodeBridge: OpenCodeBridge;
let browseSessionCleanupSupervisor = createBrowseSessionCleanupSupervisor();
let browseController: import("./WorkbenchBrowseController").default | null = null;
let browseRuntime: import("../lib/workbench/browse/WorkbenchBrowseRuntime").default | null = null;
let nextDevHealthSupervisor = createNextDevHealthSupervisor();
let projectCatalogController = createProjectCatalogController();
let projectSnapshotController = createProjectSnapshotController();
let opencodeBridgeReloadPromise: Promise<void> | null = null;
let browseControllerReloadPromise: Promise<void> | null = null;
let codexAcceptsUpstreamMessages = true;
let codexRecoverySupervisor: CodexRecoverySupervisor;
let codexHealthMonitor: import("./CodexHealthMonitor").default;
let controlledRestartPending = false;
const codexBridgeTransitionController = new CodexBridgeTransitionController();
const turnRecoveryHandoffStore = new WorkbenchTurnRecoveryHandoffStore(PROJECT_ROOT);
const turnRecoveryController = new WorkbenchTurnRecoveryController(
  turnRecoveryHandoffStore,
  (message) => log("turn-recovery", message),
);
const subagentStore = new WorkbenchSubagentStore(PROJECT_ROOT);

const copilotBridge = new CopilotBridge({
  getReloadableModules: () => reloadableModules,
  onNotification: (notification) => {
    broadcastToClients("copilot", notification);
  },
  projectRoot: WEBAPP_ROOT,
});

const codexAppServer = new CodexAppServer({
  onFatalExit: (reason) => {
    if (shuttingDown) {
      return;
    }
    codexAcceptsUpstreamMessages = false;
    codexBridge.beginStopping();
    for (const client of bridgeConnections) {
      client.close(1011, reason);
    }
    codexReadyPromise = null;
    codexRecoverySupervisor.requestRecovery(reason);
  },
  onMessage: (message) => {
    if (!codexAcceptsUpstreamMessages) {
      log("codex-bridge", "ignored upstream message after fatal app-server exit");
      return;
    }

    const upstreamNotification = asRecord(message);
    if (typeof upstreamNotification?.method === "string" && !("id" in upstreamNotification)) {
      turnRecoveryController.observeNotification("codex", message as JsonRpcNotification);
    }

    void codexBridgeTransitionController.enqueueUpstreamMessage(
      codexBridgeTransitionController.currentGeneration,
      () => codexBridge.handleUpstreamMessage(message),
      (error) => {
        logError("codex-bridge", `failed to handle upstream message: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  },
  projectRoot: WEBAPP_ROOT,
});

codexBridge = createCodexBridge();
opencodeBridge = createOpenCodeBridge();
codexRecoverySupervisor = createCodexRecoverySupervisor();
codexHealthMonitor = createCodexHealthMonitor();

const specs: ProcessSpec[] = [
  {
    name: "next-dev",
    command: "pnpm",
    args: ["run", "dev:next"],
    env: nextDevEnv,
  },
];

function sendJsonToClient(client: BridgeClient, message: unknown) {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function broadcastToClients(harness: HarnessKind, message: JsonRpcNotification) {
  void subagentStore.observeNotification(harness, message).catch((error) => {
    logError("subagent-store", error instanceof Error ? error.message : String(error));
  });
  if (harness === "codex" || harness === "opencode") {
    turnRecoveryController.observeNotification(harness, message);
  }
  for (const client of bridgeConnections) {
    sendJsonToClient(client, {
      ...message,
      workbenchHarness: harness,
    });
  }
}

function readHarness(message: JsonRpcRequest): HarnessKind {
  const harness = message[WORKBENCH_HARNESS_FIELD];
  return harness === "copilot" || harness === "opencode" ? harness : "codex";
}

function stripHarnessField(message: JsonRpcRequest) {
  const nextMessage = { ...message };
  delete nextMessage[WORKBENCH_HARNESS_FIELD];
  return nextMessage;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getBridgeInitializeMessage() {
  return createInitializeRequest(0, {
    capabilities: createInitializeCapabilities({
      experimentalApi: true,
    }),
  });
}

function ensureCodexReady() {
  if (codexReadyPromise) {
    return codexReadyPromise;
  }

  let trackedReadyPromise: Promise<void>;
  trackedReadyPromise = codexBridge.ensureInitialized(getBridgeInitializeMessage())
    .catch((error) => {
      if (codexReadyPromise === trackedReadyPromise) {
        codexReadyPromise = null;
      }
      throw error;
    });
  codexReadyPromise = trackedReadyPromise;

  return codexReadyPromise;
}

function sendHttpJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

function createReloadResponse(scopes: OrchestratorReloadScope[]): OrchestratorReloadResponse {
  return {
    appliedScopes: scopes.filter((scope) => scope !== "next-dev" && scope !== "orchestrator-server"),
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: scopes.filter((scope) => scope === "next-dev" || scope === "orchestrator-server"),
    requestedScopes: scopes,
    startedAt: Date.now(),
    state: "running",
  };
}

function finalizeReloadResponse(
  startedAt: number | null,
  updates: Partial<Pick<OrchestratorReloadResponse, "completedAt" | "error" | "state">>,
) {
  if (startedAt === null || lastReloadResponse.startedAt !== startedAt) {
    return;
  }

  lastReloadResponse = {
    ...lastReloadResponse,
    ...updates,
  };
}

async function stopAllChildren() {
  codexRecoverySupervisor.dispose();
  codexHealthMonitor.dispose();
  browseSessionCleanupSupervisor.dispose();
  nextDevHealthSupervisor.dispose();
  projectCatalogController.dispose();
  projectSnapshotController.dispose();

  for (const entry of processes.values()) {
    if (entry.child && !entry.child.killed) {
      killProcessTree(entry.child.pid);
    }
  }

  for (const client of bridgeConnections) {
    client.close();
  }
  bridgeConnections.clear();

  await codexBridge.dispose();
  await opencodeBridge.stop();
  codexAppServer.stop();

  if (bridgeWebSocketServer) {
    bridgeWebSocketServer.close();
    bridgeWebSocketServer = null;
  }

  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
}

function findProcessSpec(name: string) {
  return specs.find((spec) => spec.name === name) ?? null;
}

function restartChild(spec: ProcessSpec) {
  const existing = processes.get(spec.name);
  if (existing?.restartTimer) {
    clearTimeout(existing.restartTimer);
    existing.restartTimer = null;
  }

  if (existing?.child && !existing.child.killed) {
    killProcessTree(existing.child.pid);
    return "scheduled";
  }

  startChild(spec);
  return "started";
}

function reloadOrchestratorLogic() {
  browseSessionCleanupSupervisor.dispose();
  codexHealthMonitor.dispose();
  nextDevHealthSupervisor.dispose();
  projectCatalogController.dispose();
  projectSnapshotController.dispose();
  reloadableModules = reloadOrchestratorReloadableModules();
  workbenchAgentCommandController = createAgentCommandController();
  bridgeRequestController = createBridgeRequestController();
  legacyMigrationSourceController = createLegacyMigrationSourceController();
  browseSessionCleanupSupervisor = createBrowseSessionCleanupSupervisor();
  nextDevHealthSupervisor = createNextDevHealthSupervisor();
  codexHealthMonitor = createCodexHealthMonitor();
  projectCatalogController = createProjectCatalogController();
  projectSnapshotController = createProjectSnapshotController();
  browseSessionCleanupSupervisor.start();
  nextDevHealthSupervisor.start();
  if (codexReadyPromise) {
    void codexReadyPromise.then(() => codexHealthMonitor.start({ armed: true })).catch(() => undefined);
  }
  log("orchestrator", "reloaded orchestrator helper modules");
}

function isThreadActiveForBrowseCleanup(thread: ThreadReadResponse["thread"]) {
  return getCurrentInProgressTurn(thread) !== null
    || hasThreadActiveFlag(thread.status, "waitingOnUserInput")
    || hasThreadActiveFlag(thread.status, "waitingOnApproval");
}

async function readThreadActiveForBrowseCleanup(threadId: string) {
  for (const harness of ["codex", "copilot", "opencode"] as const satisfies readonly HarnessKind[]) {
    try {
      const response = await requestLiveHarness(harness, {
        id: 0,
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId,
        },
        workbenchThreadHydration: { mode: "latest" },
      });
      if (response.error) throw new Error(response.error.message);
      return isThreadActiveForBrowseCleanup((response.result as ThreadReadResponse).thread);
    } catch {
      // Try the next harness; preserve sessions if no harness can read the thread.
    }
  }

  return null;
}

function createBrowseSessionCleanupSupervisor() {
  const Supervisor = reloadableModules.browseSessionCleanupSupervisor.default;
  return new Supervisor({
    cleanupStaleInactiveSessions: async (options) => {
      if (!browseController) return;
      await runAfterBrowseControllerReload(async () => {
        if (browseController) await browseController.cleanupStaleInactiveSessions(options);
      });
    },
    readThreadActive: readThreadActiveForBrowseCleanup,
  });
}

function loadBrowseControllerModule() {
  return require("./WorkbenchBrowseController") as typeof import("./WorkbenchBrowseController");
}

function loadBrowseRuntimeModule() {
  return require("../lib/workbench/browse/WorkbenchBrowseRuntime") as typeof import("../lib/workbench/browse/WorkbenchBrowseRuntime");
}

function loadBrowseResultControllerModule() {
  return require("./WorkbenchBrowseResultController") as typeof import("./WorkbenchBrowseResultController");
}

async function requestBrowseHarness<TValue>(
  harness: Exclude<WorkbenchHarness, "codex">,
  message: JsonRpcRequest,
): Promise<TValue> {
  const response = harness === "copilot"
    ? await copilotBridge.handleRequest(message)
    : await runAfterOpenCodeBridgeReload(() => opencodeBridge.handleRequest(message));
  if (response.error) throw new Error(response.error.message);
  return response.result as TValue;
}

function createBrowseResultController() {
  const { default: Controller } = loadBrowseResultControllerModule();
  return new Controller({
    logError: (message) => logError("browse-results", message),
    readThread: async (harness, threadId) => {
      if (harness === "codex") return await runAfterCodexBridgeReload(() => codexBridge.readThreadForBrowse(threadId));
      return await requestBrowseHarness<ThreadReadResponse>(harness, {
        id: 0,
        method: "thread/read",
        params: { includeTurns: true, threadId },
      });
    },
    recordResult: async (entry: WorkbenchBrowseResultEntry) => {
      await runAfterCodexBridgeReload(() => codexBridge.recordBrowseResultForBrowse(entry));
    },
    steerTurn: async (harness, threadId, expectedTurnId, input: UserInput[]) => {
      if (harness === "codex") {
        return await runAfterCodexBridgeReload(() => codexBridge.steerTurnForBrowse(threadId, expectedTurnId, input));
      }
      const result = await requestBrowseHarness<{ turnId?: string } | { ok?: boolean }>(harness, {
        id: 0,
        method: "turn/steer",
        params: { expectedTurnId, input, threadId },
      });
      const resultRecord = asRecord(result);
      return typeof resultRecord?.turnId === "string" ? resultRecord.turnId : null;
    },
  });
}

function createBrowseController() {
  const { default: Controller } = loadBrowseControllerModule();
  return new Controller(createBrowseResultController(), getBrowseRuntime());
}

function createBrowseRuntime() {
  const { default: Runtime } = loadBrowseRuntimeModule();
  return new Runtime({
    resolveProjectFromCwd: (cwd, options) => projectCatalogController.resolveAgentEndpointProjectFromCwd(cwd, options),
  });
}

function getBrowseRuntime() {
  browseRuntime ??= createBrowseRuntime();
  return browseRuntime;
}

function getBrowseController() {
  browseController ??= createBrowseController();
  return browseController;
}

function createNextDevHealthSupervisor() {
  const Supervisor = reloadableModules.nextDevHealthSupervisor.default;
  return new Supervisor({
    healthUrl: new URL(NEXT_DEV_HEALTH_PATH, `http://localhost:${NEXT_PORT}`).toString(),
    intervalMs: NEXT_DEV_HEALTH_INTERVAL_MS,
    isRestartPending: () => Boolean(processes.get("next-dev")?.restartTimer),
    isShuttingDown: () => shuttingDown,
    log: (message) => log("next-dev-health", message),
    logError: (message) => logError("next-dev-health", message),
    requestTimeoutMs: NEXT_DEV_HEALTH_REQUEST_TIMEOUT_MS,
    restartCooldownMs: NEXT_DEV_HEALTH_RESTART_COOLDOWN_MS,
    restartNextDev: restartNextDevFromWatchdog,
    serverErrorThreshold: NEXT_DEV_HEALTH_SERVER_ERROR_THRESHOLD,
  });
}

function createCodexRecoverySupervisor() {
  return new CodexRecoverySupervisor({
    initialRetryDelayMs: CODEX_RECOVERY_INITIAL_RETRY_DELAY_MS,
    isShuttingDown: () => shuttingDown,
    log: (message) => log("codex-recovery", message),
    logError: (message) => logError("codex-recovery", message),
    maxRetryDelayMs: CODEX_RECOVERY_MAX_RETRY_DELAY_MS,
    recover: recoverCodexBridge,
  });
}

function createCodexHealthMonitor() {
  const Monitor = reloadableModules.codexHealthMonitor.default;
  return new Monitor({
    failureThreshold: CODEX_HEALTH_FAILURE_THRESHOLD,
    intervalMs: CODEX_HEALTH_INTERVAL_MS,
    isProbeAllowed: () => codexAcceptsUpstreamMessages
      && !controlledRestartPending
      && !codexBridgeTransitionController.isTransitioning,
    isShuttingDown: () => shuttingDown,
    log: (message) => log("codex-health", message),
    logError: (message) => logError("codex-health", message),
    probe: async () => {
      const response = await requestLiveCodexWithDeadline({ id: "codex-health", method: "account/read", params: {} });
      if (response.error) throw new Error(response.error.message);
    },
    requestRecovery: (reason) => codexRecoverySupervisor.requestRecovery(reason),
  });
}

function createProjectSnapshotController() {
  const Controller = reloadableModules.projectSnapshotController.default;
  return new Controller();
}

function createProjectCatalogController() {
  const Controller = reloadableModules.projectCatalogController.default;
  return new Controller();
}

function resolveProjectFromCurrentCatalog(
  cwd: string | null | undefined,
  options: { endpointName?: string } = {},
) {
  return projectCatalogController.resolveAgentEndpointProjectFromCwd(cwd, options);
}

function createBridgeRequestController() {
  const Controller = reloadableModules.bridgeRequestController.default;
  return new Controller({
    requestHarness: requestLiveHarness,
  });
}

function createLegacyMigrationSourceController() {
  const module = reloadableModules.legacyMigrationSourceController;
  const Controller = module.default;
  const { allowedProjectIds, capability } = module.readLegacyMigrationSourceConfig(PROJECT_ROOT);
  return new Controller({
    allowedProjectIds,
    capability,
    requestHarness: requestLiveHarness,
    resolveProjectFromCwd: async (cwd) => await projectCatalogController.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Legacy migration source" }),
  });
}

function createAgentCommandController() {
  const Controller = reloadableModules.agentCommandController.default;
  return new Controller(LOCAL_WORKBENCH_ORIGIN, LOCAL_ORCHESTRATOR_ORIGIN, {
    executeBrowseRequest: async (body, signal) => await runAfterBrowseControllerReload(
      () => getBrowseController().executeBrowseRequest(body, signal),
    ),
    executeSessionRequest: async (request, signal) => await runAfterBrowseControllerReload(
      () => getBrowseController().executeSessionRequest(request, signal),
    ),
    requestSubagent: async (request) => await requestLiveHarness("codex", request),
  });
}

async function requestLiveHarness(harness: HarnessKind, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (controlledRestartPending) throw new Error("The orchestrator is restarting; new harness work is temporarily unavailable.");
  if (harness === "codex" || harness === "opencode") turnRecoveryController.observeRequest(harness, request);
  if (harness === "copilot") return await copilotBridge.handleRequest(request);
  if (harness === "opencode") {
    return await runAfterOpenCodeBridgeReload(() => opencodeBridge.handleRequest(request));
  }
  return await runAfterCodexBridgeReload(async () => {
    await ensureCodexReady();
    return await codexBridge.handleServerRequest(request);
  });
}

async function requestLiveCodexWithDeadline(request: JsonRpcRequest, timeoutMs = CODEX_HEALTH_REQUEST_TIMEOUT_MS) {
  if (controlledRestartPending) throw new Error("The orchestrator is restarting; new harness work is temporarily unavailable.");
  turnRecoveryController.observeRequest("codex", request);
  return await runAfterCodexBridgeReload(async () => {
    await ensureCodexReady();
    return await codexBridge.handleServerRequest(request, { timeoutMs });
  });
}

function restartNextDevFromWatchdog(reason: string) {
  const nextSpec = findProcessSpec("next-dev");
  if (!nextSpec) {
    logError("next-dev-health", "Next.js dev process is not registered with the orchestrator.");
    return false;
  }

  const result = restartChild(nextSpec);
  log("next-dev-health", `${reason}; ${result} Next.js dev restart`);
  return true;
}

async function ensureWorkbenchPromptFiles() {
  await reloadableModules.workbenchPromptFiles.ensureWorkbenchPromptFiles();
}

async function waitForCodexBridgeReload() {
  await codexBridgeTransitionController.waitForTransition();
}

async function runAfterCodexBridgeReload<TValue>(task: () => TValue | Promise<TValue>) {
  await waitForCodexBridgeReload();
  return await task();
}

function withTimeout<TValue>(promise: Promise<TValue>, timeoutMs: number, message: string) {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function collectCacheSubtree(moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) {
    return visited;
  }

  const cachedModule = require.cache[moduleId];
  if (!cachedModule) {
    return visited;
  }

  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (!child?.id || /[\\/]node_modules[\\/]/u.test(child.id)) {
      continue;
    }

    collectCacheSubtree(child.id, visited);
  }

  return visited;
}

function reloadCodexBridgeModule() {
  const resolvedPath = require.resolve("./CodexStdioBridge");
  for (const moduleId of collectCacheSubtree(resolvedPath)) {
    delete require.cache[moduleId];
  }

  return require("./CodexStdioBridge") as typeof import("./CodexStdioBridge");
}

function reloadOpenCodeBridgeModule() {
  const resolvedPath = require.resolve("./opencode-bridge");
  for (const moduleId of collectCacheSubtree(resolvedPath)) {
    delete require.cache[moduleId];
  }

  return require("./opencode-bridge") as typeof import("./opencode-bridge");
}

function reloadBrowseControllerModule() {
  const modulePaths = [
    "./WorkbenchBrowseController",
    "./WorkbenchBrowseResultController",
    "../lib/workbench/browse/WorkbenchBrowseDaemonClient",
    "../lib/workbench/browse/WorkbenchBrowseRawCli",
    "../lib/workbench/browse/WorkbenchBrowseRequestHandler",
    "../lib/workbench/browse/WorkbenchBrowseRuntime",
    "../lib/workbench/browse/WorkbenchBrowseSessionController",
    "../lib/workbench/browse/actions/browse-action-registry",
    "../lib/workbench/browse/actions/element-input-actions",
    "../lib/workbench/browse/actions/mouse-actions",
    "../lib/workbench/browse/actions/navigation-actions",
    "../lib/workbench/browse/actions/runtime-actions",
    "../lib/workbench/browse/actions/session-actions",
    "../lib/workbench/browse/browse-result-events",
    "../lib/workbench/browse/browse-command-runtime",
    "../lib/workbench/browse/browse-markdown-runtime",
  ];
  for (const modulePath of modulePaths) {
    delete require.cache[require.resolve(modulePath)];
  }
  return loadBrowseControllerModule();
}

async function waitForBrowseControllerReload() {
  while (browseControllerReloadPromise) {
    await browseControllerReloadPromise.catch(() => undefined);
  }
}

async function runAfterBrowseControllerReload<TValue>(task: () => TValue | Promise<TValue>) {
  await waitForBrowseControllerReload();
  return await task();
}

async function reloadBrowseController() {
  if (browseControllerReloadPromise) {
    await browseControllerReloadPromise;
    return;
  }
  const currentController = browseController;
  const reloadPromise = (async () => {
    if (!currentController) {
      reloadBrowseControllerModule();
      browseRuntime = createBrowseRuntime();
      await browseRuntime.initialize();
      log("browse-controller", "reloaded lazy Browse controller modules");
      return;
    }
    currentController.beginDrain();
    try {
      await withTimeout(
        currentController.waitForIdle(),
        BROWSE_CONTROLLER_RELOAD_DRAIN_TIMEOUT_MS,
        "Browse controller reload timed out waiting for active work to drain; retry after the current Browse command settles.",
      );
      reloadBrowseControllerModule();
      browseRuntime = createBrowseRuntime();
      await browseRuntime.initialize();
      browseController = createBrowseController();
      log("browse-controller", "reloaded Browse controller without restarting browser sessions or bridge processes");
    } catch (error) {
      currentController.resume();
      throw error;
    }
  })();
  browseControllerReloadPromise = reloadPromise;
  try {
    await reloadPromise;
  } finally {
    if (browseControllerReloadPromise === reloadPromise) {
      browseControllerReloadPromise = null;
    }
  }
}

function createCodexBridge() {
  return new CodexStdioBridge({
    appServer: codexAppServer,
    bridgeUrl: CODEX_BRIDGE_URL,
    onNotification: (notification) => {
      broadcastToClients("codex", notification);
    },
    resolveProjectFromCwd: resolveProjectFromCurrentCatalog,
    sendToClient: (client, message) => {
      sendJsonToClient(client, message);
    },
    storageRoot: PROJECT_ROOT,
    subagentStore,
  });
}

function createOpenCodeBridge(initialState?: Awaited<ReturnType<OpenCodeBridge["detachForReload"]>>) {
  return new OpenCodeBridge({
    getReloadableModules: () => reloadableModules,
    initialState,
    onNotification: (notification) => {
      broadcastToClients("opencode", notification);
    },
    projectRoot: PROJECT_ROOT,
  });
}

async function reloadCodexBridge() {
  if (codexReadyPromise) {
    try {
      await withTimeout(
        codexReadyPromise.catch(() => undefined),
        CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS,
        "Codex bridge reload timed out waiting for app-server readiness.",
      );
    } catch (error) {
      codexRecoverySupervisor.requestRecovery("Codex bridge reload could not reach the app-server readiness boundary.");
      throw error;
    }
  }
  codexReadyPromise = null;

  try {
    await codexBridgeTransitionController.runTransition(async ({ messagesBeforeTransition }) => {
      await withTimeout(
        messagesBeforeTransition,
        CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS,
        "Codex bridge reload timed out waiting for the upstream message queue to drain; retry after current bridge activity settles.",
      );
      const state = await codexBridge.detachForReload({
        idleTimeoutMs: CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS,
      });
      const { default: ReloadedCodexStdioBridge } = reloadCodexBridgeModule();
      codexBridge = new ReloadedCodexStdioBridge({
        appServer: codexAppServer,
        bridgeUrl: CODEX_BRIDGE_URL,
        initialState: state,
        onNotification: (notification) => {
          broadcastToClients("codex", notification);
        },
        resolveProjectFromCwd: resolveProjectFromCurrentCatalog,
        sendToClient: (client, message) => {
          sendJsonToClient(client, message);
        },
        storageRoot: PROJECT_ROOT,
        subagentStore,
      });
      log("codex-bridge", "reloaded bridge code without restarting app-server");
    }, { drain: false });
  } catch (error) {
    codexAcceptsUpstreamMessages = false;
    codexBridge.beginStopping();
    codexRecoverySupervisor.requestRecovery("Codex bridge reload transition failed.");
    throw error;
  }

  codexAcceptsUpstreamMessages = true;
  try {
    await ensureCodexReady();
  } catch (error) {
    codexAcceptsUpstreamMessages = false;
    codexBridge.beginStopping();
    codexRecoverySupervisor.requestRecovery("Codex bridge reload could not restore app-server readiness.");
    throw error;
  }
}

function closeBridgeClients(code: number, reason: string) {
  for (const client of bridgeConnections) {
    client.close(code, reason);
  }
  bridgeConnections.clear();
}

async function recoverCodexBridge(reason: string) {
  const candidates = turnRecoveryController.capture(["codex"]);
  codexAcceptsUpstreamMessages = false;
  closeBridgeClients(1012, "Codex app-server is recovering; reconnect shortly.");
  await codexBridgeTransitionController.runTransition(async () => {
    await withTimeout(
      codexBridge.disposeImmediately(),
      CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS,
      "Codex recovery timed out disposing the failed bridge.",
    );
    codexAppServer.stop();
    const { default: ReloadedCodexStdioBridge } = reloadCodexBridgeModule();
    codexBridge = new ReloadedCodexStdioBridge({
      appServer: codexAppServer,
      bridgeUrl: CODEX_BRIDGE_URL,
      onNotification: (notification) => {
        broadcastToClients("codex", notification);
      },
      resolveProjectFromCwd: resolveProjectFromCurrentCatalog,
      sendToClient: (client, message) => {
        sendJsonToClient(client, message);
      },
      storageRoot: PROJECT_ROOT,
      subagentStore,
    });
    codexReadyPromise = null;
  }, { drain: false, invalidateGeneration: true });

  codexAcceptsUpstreamMessages = true;
  try {
    await withTimeout(
      ensureCodexReady(),
      CODEX_HEALTH_REQUEST_TIMEOUT_MS,
      "Codex app-server recovery readiness timed out.",
    );
  } catch (error) {
    codexAcceptsUpstreamMessages = false;
    codexBridge.beginStopping();
    throw error;
  }
  await turnRecoveryController.recover(candidates, recoverTurnCandidate);
  await recoverPersistedHandoff();
  log("codex-bridge", `restored bridge and app-server readiness after: ${reason}`);
}

function readThreadResult(response: JsonRpcResponse) {
  if (response.error) throw new Error(response.error.message);
  const result = asRecord(response.result);
  const thread = result?.thread;
  return thread && typeof thread === "object" ? thread as ThreadReadResponse["thread"] : null;
}

function containsRecoveryMarker(thread: ThreadReadResponse["thread"], recoveryId: string) {
  return thread.turns.some((turn) => turn.items.some((item) => (
    item.type === "userMessage"
    && (item.clientId === recoveryId || item.id === `opencode:user:${recoveryId}`)
    && isWorkbenchThreadRecoveryUserMessage(item)
  )));
}

async function readRecoveryThread(candidate: WorkbenchTurnRecoveryHandoffCandidate) {
  const response = await requestLiveCodexWithDeadline({
    id: `recovery-read:${candidate.recoveryId}`,
    method: "thread/read",
    params: {
      includeTurns: true,
      ...asRecord(candidate.request.params),
      threadId: candidate.threadId,
    },
    workbenchThreadHydration: { mode: "latest" },
  });
  const thread = readThreadResult(response);
  if (!thread) throw new Error(`Recovery could not read ${candidate.harness} thread ${candidate.threadId}.`);
  return thread;
}

async function recoverTurnCandidate(candidate: WorkbenchTurnRecoveryHandoffCandidate) {
  if (candidate.harness === "opencode") {
    return await runAfterOpenCodeBridgeReload(() => opencodeBridge.recoverInterruptedTurn(candidate));
  }
  let thread = await readRecoveryThread(candidate);
  if (containsRecoveryMarker(thread, candidate.recoveryId)) return "completed" as const;
  const originalTurn = candidate.turnId
    ? thread.turns.find((turn) => turn.id === candidate.turnId) ?? null
    : null;
  if (originalTurn?.status === "completed") return "completed" as const;

  const currentTurn = getCurrentTurn(thread);
  if (currentTurn?.status === "inProgress") {
    const interruptResponse = await requestLiveCodexWithDeadline({
      id: `recovery-interrupt:${candidate.recoveryId}`,
      method: "turn/interrupt",
      params: { threadId: candidate.threadId, turnId: currentTurn.id },
    });
    if (interruptResponse.error) throw new Error(interruptResponse.error.message);
    thread = await readRecoveryThread(candidate);
    if (getCurrentTurn(thread)?.status === "inProgress") {
      throw new Error(`Interrupted Codex turn ${currentTurn.id} did not reach a terminal state.`);
    }
  }
  if (containsRecoveryMarker(thread, candidate.recoveryId)) return "completed" as const;

  const request = structuredClone(candidate.request);
  request.id = `recovery-start:${candidate.recoveryId}`;
  request.params = {
    ...asRecord(request.params),
    clientUserMessageId: candidate.recoveryId,
    input: createWorkbenchThreadRecoveryInput(),
    threadId: candidate.threadId,
  };
  const response = await requestLiveCodexWithDeadline(request);
  if (response.error) throw new Error(response.error.message);
  return "recovered" as const;
}

async function waitForOpenCodeBridgeReload() {
  while (opencodeBridgeReloadPromise) {
    await opencodeBridgeReloadPromise.catch(() => undefined);
  }
}

async function runAfterOpenCodeBridgeReload<TValue>(task: () => TValue | Promise<TValue>) {
  await waitForOpenCodeBridgeReload();
  return await task();
}

async function reloadOpenCodeBridge({ restartManagedServer = false }: { restartManagedServer?: boolean } = {}) {
  if (opencodeBridgeReloadPromise) {
    await opencodeBridgeReloadPromise;
    return;
  }

  const reloadPromise = (async () => {
    const state = await opencodeBridge.detachForReload({ restartManagedServer });
    const { OpenCodeBridge: ReloadedOpenCodeBridge } = reloadOpenCodeBridgeModule();
    opencodeBridge = new ReloadedOpenCodeBridge({
      getReloadableModules: () => reloadableModules,
      initialState: state,
      onNotification: (notification) => {
        broadcastToClients("opencode", notification);
      },
      projectRoot: PROJECT_ROOT,
    });
    log(
      "opencode-bridge",
      restartManagedServer
        ? "reloaded bridge code and restarted managed OpenCode server"
        : "reloaded bridge code without restarting OpenCode server",
    );
  })();

  opencodeBridgeReloadPromise = reloadPromise;
  try {
    await reloadPromise;
  } finally {
    if (opencodeBridgeReloadPromise === reloadPromise) {
      opencodeBridgeReloadPromise = null;
    }
  }
}

function queueReload(scopes: OrchestratorReloadScope[]) {
  const startedAt = lastReloadResponse.startedAt;
  setImmediate(() => {
    void (async () => {
      try {
        const shouldRestartOpenCodeServer = scopes.includes("opencode-server");
        if (scopes.includes("orchestrator-logic") || shouldRestartOpenCodeServer) {
          reloadOrchestratorLogic();
        }

        if (scopes.includes("orchestrator-logic") || scopes.includes("browse-controller") || scopes.includes("codex-bridge") || scopes.includes("opencode-bridge") || shouldRestartOpenCodeServer) {
          await ensureWorkbenchPromptFiles();
        }

        if (scopes.includes("codex-bridge")) {
          await reloadCodexBridge();
        }

        if (scopes.includes("browse-controller")) {
          await reloadBrowseController();
        }

        if (scopes.includes("opencode-bridge") || shouldRestartOpenCodeServer) {
          await reloadOpenCodeBridge({ restartManagedServer: shouldRestartOpenCodeServer });
        }

        if (scopes.includes("next-dev")) {
          const nextSpec = findProcessSpec("next-dev");
          if (!nextSpec) {
            throw new Error("Next.js dev process is not registered with the orchestrator.");
          }

          restartChild(nextSpec);
          log("orchestrator", "queued Next.js dev restart");
        }
        finalizeReloadResponse(startedAt, {
          completedAt: Date.now(),
          error: null,
          state: "succeeded",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finalizeReloadResponse(startedAt, {
          completedAt: Date.now(),
          error: message,
          state: "failed",
        });
        logError("orchestrator", error instanceof Error ? error.stack ?? error.message : message);
      }
    })();
  });
}

async function recoverPersistedHandoff() {
  const handoff = await turnRecoveryHandoffStore.load();
  if (!handoff) return;
  turnRecoveryController.loadCandidates(handoff.candidates);
  await turnRecoveryController.recover(handoff.candidates, recoverTurnCandidate, handoff);
  log("turn-recovery", `settled controlled-restart handoff ${handoff.id}`);
}

async function handleControlledOrchestratorRestart(response: http.ServerResponse) {
  if (process.env.WORKBENCH_ORCHESTRATOR_LOOP !== "1") {
    sendHttpJson(response, 409, { error: "Full orchestrator restart requires run-orchestrator-loop.sh to own relaunch." });
    return;
  }

  controlledRestartPending = true;
  closeBridgeClients(1012, "The orchestrator is restarting; reconnect shortly.");
  try {
    await turnRecoveryController.persistControlledRestart();
  } catch (error) {
    controlledRestartPending = false;
    sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Unable to persist restart recovery state." });
    return;
  }

  const startedAt = Date.now();
  lastReloadResponse = {
    appliedScopes: [],
    completedAt: startedAt,
    error: null,
    ok: true,
    queuedScopes: ["orchestrator-server"],
    requestedScopes: ["orchestrator-server"],
    startedAt,
    state: "succeeded",
  };

  let acknowledged = false;
  response.once("finish", () => {
    acknowledged = true;
    setImmediate(() => shutdownAndExit(0));
  });
  response.once("close", () => {
    if (acknowledged || response.writableFinished) return;
    controlledRestartPending = false;
    void turnRecoveryHandoffStore.remove().catch((error) => {
      logError("turn-recovery", `failed to cancel unacknowledged restart handoff: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  sendHttpJson(response, 202, lastReloadResponse);
}

async function handleReloadHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  let payload: OrchestratorReloadRequest | null = null;
  try {
    const rawBody = await readRequestBody(request);
    const parsedBody = rawBody.trim() ? JSON.parse(rawBody) as unknown : {};
    const record = asRecord(parsedBody);
    payload = {
      scopes: normalizeOrchestratorReloadScopes(record?.scopes),
    };
  } catch (error) {
    sendHttpJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid reload request body.",
    });
    return;
  }

  if (!payload.scopes.length) {
    sendHttpJson(response, 400, {
      error: "At least one supported reload scope is required.",
    });
    return;
  }

  const combinationError = validateOrchestratorReloadScopeCombination(payload.scopes);
  if (combinationError) {
    sendHttpJson(response, 400, { error: combinationError });
    return;
  }
  if (payload.scopes[0] === "orchestrator-server") {
    await handleControlledOrchestratorRestart(response);
    return;
  }

  lastReloadResponse = createReloadResponse(payload.scopes);
  sendHttpJson(response, 202, lastReloadResponse);
  queueReload(payload.scopes);
}

function scheduleRestart(spec: ProcessSpec) {
  if (shuttingDown) {
    return;
  }

  const existing = processes.get(spec.name);
  if (existing?.restartTimer) {
    return;
  }

  const restartTimer = setTimeout(() => {
    const latest = processes.get(spec.name);
    if (latest) {
      latest.restartTimer = null;
    }
    startChild(spec);
  }, RESTART_DELAY_MS);

  processes.set(spec.name, {
    ...(existing ?? { child: null }),
    restartTimer,
  });
}

function startChild(spec: ProcessSpec) {
  const spawnDescriptor = getSpawnDescriptor(spec);
  const child = spawn(spawnDescriptor.command, spawnDescriptor.args, {
    ...createSpawnOptions(WEBAPP_ROOT, {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      ...spec.env,
    }, false),
    stdio: ["ignore", "pipe", "pipe"],
  });

  processes.set(spec.name, {
    child,
    restartTimer: null,
  });

  pipeChildStream(spec.name, child.stdout, (chunk) => process.stdout.write(chunk));
  pipeChildStream(spec.name, child.stderr, (chunk) => process.stderr.write(chunk));

  child.once("error", (error) => {
    logError(spec.name, `failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });

  child.once("exit", (code, signal) => {
    log(spec.name, `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);

    const existing = processes.get(spec.name);
    processes.set(spec.name, {
      child: null,
      restartTimer: existing?.restartTimer ?? null,
    });

    if (!shuttingDown) {
      scheduleRestart(spec);
    }
  });
}

async function handleClientMessage(client: BridgeClient, data: Buffer) {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(data.toString()) as JsonRpcRequest;
  } catch {
    client.close(1003, "Invalid JSON.");
    return;
  }

  if (controlledRestartPending) {
    if ("id" in message) {
      sendJsonToClient(client, {
        id: message.id,
        error: { code: -32000, message: "The orchestrator is restarting; reconnect shortly." },
      });
    }
    return;
  }

  if (message.method === "initialize" && "id" in message) {
    try {
      await runAfterCodexBridgeReload(async () => {
        await ensureCodexReady();
        sendJsonToClient(client, {
          id: message.id,
          result: codexBridge.getInitializeResult(),
        });
      });
    } catch (error) {
      sendJsonToClient(client, {
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex app-server initialize failed.",
        },
      });
    }
    return;
  }

  if (message.method === "initialized" && !("id" in message)) {
    return;
  }

  const harness = readHarness(message);
  const strippedMessage = stripHarnessField(message);
  if ((harness === "codex" || harness === "opencode") && "id" in strippedMessage) {
    turnRecoveryController.observeRequest(harness, strippedMessage);
  }

  if (harness === "copilot") {
    if (!("id" in message)) {
      return;
    }

    const response = await copilotBridge.handleRequest(stripHarnessField(message));
    sendJsonToClient(client, response);
    return;
  }

  if (harness === "opencode") {
    if (!("id" in message)) {
      return;
    }

    const response = await runAfterOpenCodeBridgeReload(() => opencodeBridge.handleRequest(strippedMessage));
    sendJsonToClient(client, response);
    return;
  }

  if ("id" in message) {
    try {
      const bridgeResponse = await runAfterCodexBridgeReload(() => codexBridge.handleBridgeRequest(strippedMessage));
      if (bridgeResponse) {
        sendJsonToClient(client, bridgeResponse);
        return;
      }

      await runAfterCodexBridgeReload(() => codexBridge.forwardRequest(strippedMessage, client, message.id as number | string));
    } catch (error) {
      sendJsonToClient(client, {
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex bridge request failed.",
        },
      });
    }
    return;
  }

  await runAfterCodexBridgeReload(() => codexBridge.forwardNotification(stripHarnessField(message))).catch((error) => {
    logError("codex-bridge", error instanceof Error ? error.message : String(error));
  });
}

function startBridgeServer() {
  const { host, port } = codexBridge.getListenDescriptor();
  bridgeWebSocketServer = new WebSocketServer({ noServer: true });
  bridgeServer = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
    if (requestPath === ORCHESTRATOR_AGENT_COMMAND_PATH && request.method === "POST") {
      void workbenchAgentCommandController.handleHttpRequest(request, response);
      return;
    }
    if (requestPath === ORCHESTRATOR_BRIDGE_REQUEST_PATH && request.method === "POST") {
      void bridgeRequestController.handleHttpRequest(request, response).catch((error) => {
        if (!response.headersSent) sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Bridge request failed." });
      });
      return;
    }
    if (requestPath === ORCHESTRATOR_LEGACY_MIGRATION_SOURCE_PATH) {
      void legacyMigrationSourceController.handleHttpRequest(request, response).catch((error) => {
        if (!response.headersSent) sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Legacy migration source failed." });
      });
      return;
    }
    if (requestPath === ORCHESTRATOR_PROJECTS_PATH && request.method === "GET") {
      void projectCatalogController.handleHttpRequest(request, response).catch((error) => {
        if (!response.headersSent) sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Project discovery failed." });
      });
      return;
    }

    if (requestPath === ORCHESTRATOR_TREE_PATH && (request.method === "GET" || request.method === "POST")) {
      void projectSnapshotController.handleTreeHttpRequest(request, response).catch((error) => {
        if (!response.headersSent) sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Project tree request failed." });
      });
      return;
    }

    if (requestPath === ORCHESTRATOR_BROWSE_PATH && request.method === "POST") {
      void runAfterBrowseControllerReload(() => getBrowseController().handleBrowseHttpRequest(request, response)).catch((error) => {
        if (!response.headersSent) {
          sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Browse request failed." });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
      return;
    }

    if (requestPath === ORCHESTRATOR_BROWSE_SESSIONS_PATH && (request.method === "GET" || request.method === "POST")) {
      void runAfterBrowseControllerReload(() => getBrowseController().handleSessionsHttpRequest(request, response)).catch((error) => {
        if (!response.headersSent) {
          sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Browse session request failed." });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
      return;
    }

    if (request.url === ORCHESTRATOR_RELOAD_PATH && request.method === "GET") {
      sendHttpJson(response, 200, lastReloadResponse);
      return;
    }

    if (request.url === ORCHESTRATOR_RELOAD_PATH && request.method === "POST") {
      void handleReloadHttpRequest(request, response);
      return;
    }

    if (request.url === "/readyz" || request.url === "/healthz") {
      sendHttpJson(response, 200, {});
      return;
    }

    sendHttpJson(response, 404, { error: "Not found" });
  });

  bridgeServer.on("upgrade", (request, socket, head) => {
    bridgeWebSocketServer?.handleUpgrade(request, socket, head, (client) => {
      bridgeWebSocketServer?.emit("connection", client, request);
    });
  });

  bridgeWebSocketServer.on("connection", (client) => {
    const bridgeClient = client as unknown as BridgeClient;
    bridgeConnections.add(bridgeClient);
    log("codex-bridge", `client connected (${bridgeConnections.size} active)`);

    bridgeClient.on("message", (payload) => {
      void handleClientMessage(bridgeClient, payload).catch((error) => {
        logError("codex-bridge", error instanceof Error ? error.message : String(error));
      });
    });

    bridgeClient.once("close", () => {
      bridgeConnections.delete(bridgeClient);
      log("codex-bridge", `client disconnected (${bridgeConnections.size} active)`);
    });

    bridgeClient.once("error", (error) => {
      logError("codex-bridge", error instanceof Error ? error.message : String(error));
    });
  });

  bridgeServer.once("error", (error) => {
    shutdownAndExit(1, error);
  });

  bridgeServer.listen(port, host, () => {
    log("codex-bridge", `listening on ${CODEX_BRIDGE_URL}; upstream transport is codex app-server stdio, Copilot SDK, or OpenCode SDK`);
  });
}

function shutdownAndExit(exitCode: number, error?: unknown) {
  if (shuttingDown) {
    if (error) {
      logError("orchestrator", error instanceof Error ? error.stack ?? error.message : String(error));
    }
    process.exit(exitCode);
    return;
  }

  shuttingDown = true;
  if (error) {
    logError("orchestrator", error instanceof Error ? error.stack ?? error.message : String(error));
  }

  void stopAllChildren().finally(() => copilotBridge.stop()).finally(() => opencodeBridge.stop()).finally(() => subagentStore.waitForIdle()).finally(() => {
    process.exit(exitCode);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdownAndExit(0));
}

process.on("uncaughtException", (error) => shutdownAndExit(1, error));
process.on("unhandledRejection", (reason) => shutdownAndExit(1, reason));
process.on("exit", () => {
  shuttingDown = true;
});

async function startOrchestrator() {
  log("orchestrator", `starting bridge at ${CODEX_BRIDGE_URL} and Next.js on port ${NEXT_PORT}`);
  await subagentStore.initialize();
  await getBrowseRuntime().initialize();
  await workbenchAgentCliEnvironment.install();
  await ensureWorkbenchPromptFiles();
  startBridgeServer();
  void ensureCodexReady()
    .then(() => {
      codexHealthMonitor.start({ armed: true });
      void recoverPersistedHandoff().catch((error) => {
        logError("turn-recovery", `startup handoff recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    })
    .catch((error) => {
      codexAcceptsUpstreamMessages = false;
      codexBridge.beginStopping();
      codexRecoverySupervisor.requestRecovery(
        `Codex app-server startup readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  browseSessionCleanupSupervisor.start();
  for (const spec of specs) {
    startChild(spec);
  }
  nextDevHealthSupervisor.start();
}

void startOrchestrator().catch((error) => {
  shutdownAndExit(1, error);
});
