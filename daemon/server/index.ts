/*
 * Exports: none. Starts the bridge server and graph host, wires stable recovery ingress,
 * and provides process-owned harness, reload, and supervisor ports to reloadable nodes.
 */
import http from "node:http";
import path from "node:path";

import { WebSocketServer } from "ws";

import { createInitializeCapabilities, createInitializeRequest } from "workbench-shared/codex/protocol";
import { NativeThreadIdSchema, NativeTurnIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type {
    DaemonReloadResponse,
    DaemonReloadScope,
    WorkbenchBrowseResultEntry,
    WorkbenchHarness,
} from "workbench-shared/types";
import type { WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { BridgeClient, HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexRecoverySupervisor from "./CodexRecoverySupervisor";
import type CodexStdioBridge from "./CodexStdioBridge";
import {
    log,
    logError,
} from "./process-helpers";
import { DAEMON_PROCESS_REQUIRED_REGISTRATIONS, type DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { createReloadableNodeModuleLoader } from "./reloadable-node-loader";
import ReloadableNodeHost from "./ReloadableNodeHost";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";
import type { WorkbenchHardReloadNotification } from "./WorkbenchDaemonReloadController";
import WorkbenchDaemonControlIngress from "./WorkbenchDaemonControlIngress";
import type { WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

const DAEMON_ROOT = __dirname;
const DAEMON_PACKAGE_ROOT = path.resolve(DAEMON_ROOT, "..");
const PROJECT_ROOT = path.resolve(DAEMON_PACKAGE_ROOT, "..");
const DEFAULT_CODEX_BRIDGE_URL = "ws://0.0.0.0:4500";
const CODEX_BRIDGE_URL = process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_BRIDGE_URL;
const DAEMON_RELOAD_PATH = "/daemon/reload";
const DAEMON_BROWSE_PATH = "/daemon/browse";
const DAEMON_BROWSE_SESSIONS_PATH = "/daemon/browse/sessions";
const CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS = 10000;
const CODEX_RECOVERY_INITIAL_RETRY_DELAY_MS = 4000;
const CODEX_RECOVERY_MAX_RETRY_DELAY_MS = 60000;
const CODEX_HEALTH_INTERVAL_MS = 60000;
const CODEX_HEALTH_REQUEST_TIMEOUT_MS = 10000;
const CODEX_HEALTH_FAILURE_THRESHOLD = 10;
const BROWSE_CONTROLLER_RELOAD_DRAIN_TIMEOUT_MS = 5000;

function parseWebSocketPort(url: string) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error(`Codex bridge URL must use ws:// or wss://, received ${url}`);
  }

  return parsedUrl.port || (parsedUrl.protocol === "wss:" ? "443" : "80");
}

const LOCAL_DAEMON_ORIGIN = `http://127.0.0.1:${parseWebSocketPort(CODEX_BRIDGE_URL)}`;
const workbenchAgentCliEnvironment = new WorkbenchAgentCliEnvironment({
  origin: LOCAL_DAEMON_ORIGIN,
  runtimeDirectoryPath: path.join(DAEMON_PACKAGE_ROOT, "node_modules", ".bin"),
  shellSourcePath: path.join(DAEMON_ROOT, "lib", "workbench", "cli", "workbench-agent-cli.sh"),
});

const bridgeConnections = new Set<BridgeClient>();
let bridgeServer: http.Server | null = null;
let bridgeWebSocketServer: WebSocketServer | null = null;
let lastReloadResponse: DaemonReloadResponse = {
  appliedScopes: [],
  completedAt: null,
  error: null,
  ok: true,
  queuedScopes: [],
  requestedScopes: [],
  startedAt: null,
  state: "idle",
};
let shuttingDown = false;
let nextBridgeConnectionId = 0;
const bridgeClientsByConnectionId = new Map<string, BridgeClient>();
let codexRecoverySupervisor: CodexRecoverySupervisor;
const threadTransitionCoordinator = new WorkbenchThreadTransitionCoordinator();
const featureHost = new ReloadableNodeHost<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>(
  createDaemonFeatureContext(),
  createReloadableNodeModuleLoader(),
  {
    logError: (message) => logError("runtime-drain", message),
    onSwap: (nodeIds) => {
      log("daemon", `reloaded daemon feature nodes: ${nodeIds.join(", ")}`);
      if (nodeIds.includes("server:core")) {
        for (const client of bridgeConnections) sendJsonToClient(client, { method: "workbench/thread-state/reset", params: {} });
      }
    },
    requiredRegistrations: DAEMON_PROCESS_REQUIRED_REGISTRATIONS,
    requiredScopes: ["server:topology"],
    runtimeDrainTimeoutMs: 30_000,
  },
);

codexRecoverySupervisor = createCodexRecoverySupervisor();

function sendJsonToClient(client: BridgeClient, message: unknown) {
  void featureHost.run(
    "webSocketRequests",
    (controller) => controller.sendJsonToClient(client, message),
    "browser WebSocket send",
  ).catch((error) => {
    featureHost.get("webSocketRequests").reportSendFailure(message, error);
  });
}

function broadcastToClients(harness: HarnessKind, message: JsonRpcNotification, observation: import("workbench-shared/workbench/provider/provider-observation").WorkbenchProviderObservation, nativeNotification: JsonRpcNotification) {
  featureHost.get("harnesses").observeNotification(harness, nativeNotification);
  void featureHost.observeProviderNotification({ harness, notification: nativeNotification, observation }, `provider notification: ${harness} ${message.method}`).catch((error) => {
    logError("thread-state", `failed to observe provider notification: ${error instanceof Error ? error.message : String(error)}`);
  });
  for (const client of bridgeConnections) {
    sendJsonToClient(client, {
      ...message,
      workbenchHarness: harness,
    });
  }
}

function publishThreadState(connectionId: string, snapshot: WorkbenchThreadStateSnapshot) {
  const client = bridgeClientsByConnectionId.get(connectionId);
  if (client) sendJsonToClient(client, { method: "workbench/thread-state/updated", params: snapshot });
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

function ensureCodexReady(bridge = featureHost.get("codexBridge")) {
  return bridge.ensureInitialized(getBridgeInitializeMessage());
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

function createReloadResponse(scopes: DaemonReloadScope[]): DaemonReloadResponse {
  return {
    appliedScopes: scopes.filter((scope) => scope !== "server:process"),
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: scopes.filter((scope) => scope === "server:process"),
    requestedScopes: scopes,
    startedAt: Date.now(),
    state: "running",
  };
}

function finalizeReloadResponse(
  startedAt: number | null,
  updates: Partial<Pick<DaemonReloadResponse, "completedAt" | "error" | "state">>,
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
  const closures = [featureHost.dispose()];

  for (const client of bridgeConnections) {
    client.close();
  }
  bridgeConnections.clear();

  if (bridgeWebSocketServer) {
    bridgeWebSocketServer.close();
    bridgeWebSocketServer = null;
  }

  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
  const results = await Promise.allSettled(closures);
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "Daemon child shutdown failed.");
}

function createHardReloadNotifications(): WorkbenchHardReloadNotification[] {
  return [
    {
      name: "process lifecycle",
      notify: () => {
        shuttingDown = true;
        codexRecoverySupervisor.dispose();
      },
    },
    {
      name: "bridge ingress",
      notify: () => {
        closeBridgeClients(1012, "The daemon is hard reloading; reconnect shortly.");
        bridgeWebSocketServer?.close();
        bridgeWebSocketServer = null;
        bridgeServer?.close();
        bridgeServer = null;
      },
    },
    { name: "feature graph", notify: () => featureHost.beginHardShutdown() },
  ];
}

function createDaemonFeatureContext(): DaemonProcessContext {
  return {
    browseCleanupOptions: {
      cleanupStaleInactiveSessions: async (options) => await featureHost.run("browseExecution", (execution) => execution.cleanupStaleInactiveSessions(options), "Browse stale-session cleanup"),
      readThreadActive: readThreadActiveForBrowseCleanup,
    },
    browseProjectResolvers: {
      resolveProjectById: (projectId) => featureHost.run("projectCatalog", (controller) => controller.resolveProjectById(projectId), "project catalog: browse project id"),
      resolveProjectFromCwd: (cwd, options) => featureHost.run("projectCatalog", (controller) => controller.resolveAgentEndpointProjectFromCwd(cwd, options), "project catalog: browse cwd"),
    },
    browseResultCallbacks: {
      listHarnesses: () => featureHost.get("harnesses").listHarnesses(),
      logError: (message) => logError("browse-results", message),
      readThread: async (harness, threadId) => await featureHost.get("harnesses").readThread(harness, NativeThreadIdSchema.parse(threadId)),
      recordResult: async (entry) => await runAfterCodexBridgeReload((bridge) => bridge.recordBrowseResultForBrowse(entry)),
      steerTurn: async (harness, threadId, expectedTurnId, input) => await featureHost.get("harnesses").steerTurn(harness, NativeThreadIdSchema.parse(threadId), NativeTurnIdSchema.parse(expectedTurnId), input),
    },
    codexAppServerOptions: {
      log,
      logError,
      projectRoot: DAEMON_PACKAGE_ROOT,
    },
    codexHealthOptions: {
      failureThreshold: CODEX_HEALTH_FAILURE_THRESHOLD,
      intervalMs: CODEX_HEALTH_INTERVAL_MS,
      isProbeAllowed: () => {
        const runtime = featureHost.get("codexAppServer");
        return runtime.isAvailable() && !runtime.isTransitioning() && !featureHost.get("reloadController").isHardReloadPending();
      },
      isShuttingDown: () => shuttingDown,
      log: (message) => log("codex-health", message),
      logError: (message) => logError("codex-health", message),
      probe: async () => {
        const response = await requestLiveCodexWithDeadline({ id: "codex-health", method: "account/read", params: {} });
        if (response.error) throw new Error(response.error.message);
      },
      requestRecovery: (reason) => codexRecoverySupervisor.requestRecovery(reason),
    },
    codexBridgeUrl: CODEX_BRIDGE_URL,
    createCodexBridgeOptions: (appServer, initialState) => ({
      appServer,
      bridgeUrl: CODEX_BRIDGE_URL,
      handleWorkbenchRequest: (request) => featureHost.run("subagents", (feature) => feature.handleRequest(request), `subagents: ${request.method}`),
      initialState,
      onNotification: (notification, observation, nativeNotification) => broadcastToClients("codex", notification, observation, nativeNotification),
      resolveProjectFromCwd: resolveProjectFromCurrentCatalog,
      sendToClient: (client, message) => sendJsonToClient(client, message),
      storageRoot: PROJECT_ROOT,
    }),
    executeBrowseRequest: async (body, signal) => await featureHost.run("browseExecution", (execution) => execution.executeBrowseRequest(body, signal), "Browse command request"),
    executeBrowseSessionRequest: async (request, signal) => await featureHost.run("browseExecution", (execution) => execution.executeSessionRequest(request, signal), "Browse session request"),
    executeReloadScopes,
    getReloadScopeCatalog: () => featureHost.getReloadScopeCatalog(),
    getReloadScopesForPaths: (paths) => featureHost.getReloadScopesForPaths(paths),
    hardReload: {
      exitProcess: () => process.exit(0),
      logError: (message) => logError("hard-reload", message),
      notifications: () => createHardReloadNotifications(),
      timeoutMs: 5_000,
    },
    installSubagentRelationship: async (record) => await featureHost.run(
      "threadState",
      (feature) => feature.installSubagentRelationship(record),
      `thread state: install subagent ${record.harness}:${record.threadId}`,
    ),
    harnessPorts: createHarnessPorts(),
    legacyMigrationProjectRoot: PROJECT_ROOT,
    localDaemonOrigin: LOCAL_DAEMON_ORIGIN,
    logTurnRecovery: (message) => log("turn-recovery", message),
    onCodexFatalExit: (reason, bridge) => {
      if (shuttingDown) return;
      bridge?.beginStopping();
      closeBridgeClients(1011, reason);
      codexRecoverySupervisor.requestRecovery(reason);
    },
    onCodexBridgeReady: async (bridge) => {
      await ensureWorkbenchPromptFiles();
      await ensureCodexReady(bridge);
    },
    onCodexBridgeUnavailable: (restartingAppServer) => {
      if (!restartingAppServer) return;
      closeBridgeClients(1012, "Codex app-server is reloading; reconnect shortly.");
    },
    publishThreadState,
    reportWebSocketDelivery: (delivery) => {
      // Do not hold physical send completion behind the reload admission gate.
      void featureHost.run("webSocketRequests", (controller) => controller.completeDelivery(delivery), "WebSocket delivery receipt")
        .catch((error: unknown) => logError("websocket", `delivery receipt failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`));
    },
    reportTurnRecoveryFailure: async (cwd, harness, threadId) => {
      const project = await featureHost.run(
        "projectCatalog",
        (controller) => controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench turn recovery" }),
        "project catalog: turn recovery cwd",
      );
      const identity = await featureHost.run(
        "threadIdentity",
        (owner) => owner.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.project.id, harness }),
        "thread identity: recovery failure",
      );
      if (!identity) throw new Error("Turn recovery failure has no matching Workbench thread identity.");
      await featureHost.run(
        "threadState",
        (feature) => feature.controller.reportRecoveryFailed(project.project.id, harness, identity.threadId),
        "thread state: report recovery failure",
      );
    },
    refreshWorkbenchPromptFiles: ensureWorkbenchPromptFiles,
    runTurnRecoveryTask: async (owner, label, task) => await featureHost.run(
      "turnRecovery",
      async (currentOwner) => {
        if (currentOwner !== owner) throw new Error("The turn-recovery generation changed before scheduled work began.");
        await task();
      },
      label,
    ),
    threadTransitions: threadTransitionCoordinator,
  };
}

async function readThreadActiveForBrowseCleanup(threadId: string) {
  const harnesses = featureHost.get("harnesses");
  for (const harness of harnesses.listHarnesses()) {
    try {
      const response = await harnesses.request(harness, {
        id: 0,
        method: "thread/read",
        params: { includeTurns: false, threadId },
      });
      if (response.error) throw new Error(response.error.message);
      const result = response.result as { thread?: { status?: string } };
      const status = result.thread?.status ?? "";
      return status === "active" || status.startsWith("active:");
    } catch {
      // Try the next harness; preserve sessions if no harness can read the thread.
    }
  }

  return null;
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

function resolveProjectFromCurrentCatalog(
  cwd: string | null | undefined,
  options: { endpointName?: string } = {},
) {
  return featureHost.run("projectCatalog", (controller) => controller.resolveAgentEndpointProjectFromCwd(cwd, options), `project catalog: ${options.endpointName ?? "cwd resolution"}`);
}

async function requestLiveHarness(harness: HarnessKind, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  return await featureHost.run("harnesses", (controller) => controller.request(harness, request), `harnesses: ${harness} ${request.method}`);
}

function requireHarnessAdmission() {
  if (featureHost.get("reloadController").isHardReloadPending()) throw new Error("The daemon is hard reloading; new harness work is temporarily unavailable.");
}

function createHarnessPorts(): Record<WorkbenchHarness, WorkbenchHarnessRuntimePort> {
  return {
    codex: {
      handleBrowserMessage: async (message, client) => {
        if (message.method === "initialize" && "id" in message) {
          try {
            await runAfterCodexBridgeReload(async (bridge) => {
              await ensureCodexReady(bridge);
              sendJsonToClient(client, { id: message.id, result: bridge.getInitializeResult() });
            });
          } catch (error) {
            sendJsonToClient(client, { id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Codex app-server initialize failed." } });
          }
          return;
        }
        if (message.method === "initialized" && !("id" in message)) return;
        if ("id" in message) {
          try {
            const bridgeResponse = await runAfterCodexBridgeReload((bridge) => bridge.handleBridgeRequest(message));
            if (bridgeResponse) {
              sendJsonToClient(client, bridgeResponse);
              return;
            }
            await runAfterCodexBridgeReload((bridge) => bridge.forwardRequest(message, client, message.id as number | string));
          } catch (error) {
            sendJsonToClient(client, { id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Codex bridge request failed." } });
          }
          return;
        }
        await runAfterCodexBridgeReload((bridge) => bridge.forwardNotification(message)).catch((error) => {
          logError("codex-bridge", error instanceof Error ? error.message : String(error));
        });
      },
      readThread: async (threadId) => await runAfterCodexBridgeReload((bridge) => bridge.readThreadForBrowse(threadId)),
      request: async (request, signal) => {
        requireHarnessAdmission();
        return await runAfterCodexBridgeReload(async (bridge) => {
          signal?.throwIfAborted();
          await ensureCodexReady(bridge);
          signal?.throwIfAborted();
          return await bridge.handleServerRequest(request);
        });
      },
      steerTurn: async (threadId, expectedTurnId, input) => await runAfterCodexBridgeReload((bridge) => bridge.steerTurnForBrowse(threadId, expectedTurnId, input)),
    },
  };
}

async function requestLiveCodexWithDeadline(request: JsonRpcRequest, timeoutMs = CODEX_HEALTH_REQUEST_TIMEOUT_MS) {
  if (featureHost.get("reloadController").isHardReloadPending()) throw new Error("The daemon is hard reloading; new harness work is temporarily unavailable.");
  return await runAfterCodexBridgeReload(async (bridge) => {
    await ensureCodexReady(bridge);
    return await bridge.handleServerRequest(request, { timeoutMs });
  });
}

async function ensureWorkbenchPromptFiles() {
  await featureHost.get("modules").workbenchPromptFiles.ensureWorkbenchPromptFiles();
}

async function runAfterCodexBridgeReload<TValue>(task: (bridge: CodexStdioBridge) => TValue | Promise<TValue>) {
  return await featureHost.run("codexBridge", task, "Codex bridge operation");
}

function closeBridgeClients(code: number, reason: string) {
  for (const client of bridgeConnections) {
    client.close(code, reason);
  }
  bridgeConnections.clear();
}

async function recoverCodexBridge(reason: string) {
  await featureHost.reload(["harness:codex"]);
  log("codex-bridge", `restored bridge and app-server readiness after: ${reason}`);
}

async function executeReloadScopes(scopes: DaemonReloadScope[]) {
  if (scopes.includes("server:process")) throw new Error("Full daemon restart requires the operator hard-reload boundary.");
  const previousController = featureHost.get("reloadController");
  try {
    await featureHost.reload(scopes);
    const currentController = featureHost.get("reloadController");
    if (currentController !== previousController) currentController.completeTransferredBatchIfPresent();
  } catch (error) {
    const currentController = featureHost.get("reloadController");
    if (currentController !== previousController) currentController.failTransferredBatch(error);
    throw error;
  }
}

function queueReload(scopes: DaemonReloadScope[]) {
  const startedAt = lastReloadResponse.startedAt;
  setImmediate(() => {
    void featureHost.get("reloadController").executeUnmanaged(scopes).then(() => {
      finalizeReloadResponse(startedAt, {
        completedAt: Date.now(),
        error: null,
        state: "succeeded",
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      finalizeReloadResponse(startedAt, {
        completedAt: Date.now(),
        error: message,
        state: "failed",
      });
      logError("daemon", error instanceof Error ? error.stack ?? error.message : message);
    });
  });
}

function handleHardDaemonReload(response: http.ServerResponse) {
  if (process.env.WORKBENCH_DAEMON_LOOP !== "1") {
    sendHttpJson(response, 409, { error: "Full daemon restart requires the daemon runner to own relaunch." });
    return;
  }

  let admission: DaemonReloadResponse;
  try {
    admission = featureHost.get("reloadController").admitHardReload();
  } catch (error) {
    sendHttpJson(response, 409, { error: error instanceof Error ? error.message : "Unable to admit hard reload." });
    return;
  }
  lastReloadResponse = admission;

  let acknowledged = false;
  response.once("finish", () => {
    acknowledged = true;
    void featureHost.get("reloadController").beginHardReload().catch((error) => {
      logError("hard-reload", error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
  });
  response.once("close", () => {
    if (acknowledged || response.writableFinished) return;
    featureHost.get("reloadController").cancelHardReloadAdmission();
  });
  sendHttpJson(response, 202, lastReloadResponse);
}

async function handleReloadHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  let requestedScopes: DaemonReloadScope[] = [];
  try {
    const rawBody = await readRequestBody(request);
    const parsedBody = rawBody.trim() ? JSON.parse(rawBody) as unknown : {};
    const record = asRecord(parsedBody);
    requestedScopes = featureHost.get("reloadController").resolveSelections(
      { all: record?.all === true, scopes: record?.scopes },
      "operator",
    );
  } catch (error) {
    sendHttpJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid reload request body.",
    });
    return;
  }

  if (!requestedScopes.length) {
    sendHttpJson(response, 400, {
      error: "At least one supported reload scope is required.",
    });
    return;
  }

  const combinationError = featureHost.get("reloadController").validateCombination(requestedScopes);
  if (combinationError) {
    sendHttpJson(response, 400, { error: combinationError });
    return;
  }
  if (requestedScopes[0] === "server:process") {
    handleHardDaemonReload(response);
    return;
  }

  try {
    featureHost.validateReloadScopes(requestedScopes);
  } catch (error) {
    sendHttpJson(response, 400, { error: error instanceof Error ? error.message : "Invalid harness reload scope." });
    return;
  }
  lastReloadResponse = createReloadResponse(requestedScopes);
  sendHttpJson(response, 202, lastReloadResponse);
  queueReload(requestedScopes);
}

const controlIngress = new WorkbenchDaemonControlIngress({
  getReloadController: () => featureHost.get("reloadController"),
  log: (message) => log("daemon", message),
  logError: (message) => logError("daemon-control", message),
  dispatch: async (client, connectionId, data) => await featureHost.run(
    "webSocketRequests",
    (controller) => controller.handleMessage(client, connectionId, data, featureHost.get("reloadController").isHardReloadPending()),
    "browser WebSocket message",
  ),
});

function startBridgeServer() {
  const { host, port } = featureHost.get("codexBridge").getListenDescriptor();
  bridgeWebSocketServer = new WebSocketServer({ noServer: true });
  bridgeServer = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
    if (requestPath === DAEMON_BROWSE_PATH && request.method === "POST") {
      void featureHost.run("browseExecution", (execution) => execution.handleBrowseHttpRequest(request, response), "Browse HTTP request").catch((error) => {
        if (!response.headersSent) {
          sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Browse request failed." });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
      return;
    }

    if (requestPath === DAEMON_BROWSE_SESSIONS_PATH && (request.method === "GET" || request.method === "POST")) {
      void featureHost.run("browseExecution", (execution) => execution.handleSessionsHttpRequest(request, response), "Browse session HTTP request").catch((error) => {
        if (!response.headersSent) {
          sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Browse session request failed." });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
      return;
    }

    if (request.url === DAEMON_RELOAD_PATH && request.method === "GET") {
      sendHttpJson(response, 200, lastReloadResponse);
      return;
    }

    if (request.url === DAEMON_RELOAD_PATH && request.method === "POST") {
      void handleReloadHttpRequest(request, response);
      return;
    }

    if (request.url === "/readyz" || request.url === "/healthz") {
      sendHttpJson(response, 200, {});
      return;
    }

    void featureHost.run("daemonHttp", (router) => router.handleHttpRequest(request, response), `daemon HTTP: ${request.method ?? "UNKNOWN"} ${new URL(request.url ?? "/", "http://localhost").pathname}`).catch((error) => {
      if (!response.headersSent) {
        sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Daemon feature request failed." });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  bridgeServer.on("upgrade", (request, socket, head) => {
    bridgeWebSocketServer?.handleUpgrade(request, socket, head, (client) => {
      bridgeWebSocketServer?.emit("connection", client, request);
    });
  });

  bridgeWebSocketServer.on("connection", (client) => {
    const bridgeClient = client as unknown as BridgeClient;
    const connectionId = `connection-${++nextBridgeConnectionId}`;
    bridgeClientsByConnectionId.set(connectionId, bridgeClient);
    bridgeConnections.add(bridgeClient);
    log("codex-bridge", `client connected (${bridgeConnections.size} active)`);

    bridgeClient.on("message", (payload) => {
      void controlIngress.handle(bridgeClient, connectionId, payload).catch((error) => {
        logError("codex-bridge", error instanceof Error ? error.message : String(error));
      });
    });

    bridgeClient.once("close", () => {
      bridgeClientsByConnectionId.delete(connectionId);
      if (!shuttingDown) {
        void featureHost.run("webSocketRequests", (controller) => controller.disconnect(bridgeClient, connectionId), "browser WebSocket disconnect")
          .catch(error => logError("codex-bridge", `disconnect failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`));
      }
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
    log("codex-bridge", `listening on ${CODEX_BRIDGE_URL}; upstream transport is codex app-server stdio`);
  });
}

function shutdownAndExit(exitCode: number, error?: unknown) {
  if (shuttingDown) {
    if (error) {
      logError("daemon", error instanceof Error ? error.stack ?? error.message : String(error));
    }
    return;
  }

  shuttingDown = true;
  if (error) {
    logError("daemon", error instanceof Error ? error.stack ?? error.message : String(error));
  }

  void stopAllChildren().then(
    () => process.exit(exitCode),
    (failure: unknown) => {
      logError("daemon", `shutdown failed: ${(failure instanceof Error ? failure.stack ?? failure.message : String(failure)).slice(0, 4000)}`);
      process.exit(1);
    },
  );
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdownAndExit(0));
}

process.on("uncaughtException", (error) => shutdownAndExit(1, error));
process.on("unhandledRejection", (reason) => shutdownAndExit(1, reason));
process.on("exit", () => {
  shuttingDown = true;
});

async function startDaemon() {
  log("daemon", `starting bridge at ${CODEX_BRIDGE_URL}`);
  await workbenchAgentCliEnvironment.install();
  await ensureWorkbenchPromptFiles();
  await featureHost.start();
  startBridgeServer();
  const startupBridge = featureHost.get("codexBridge");
  const codexReadiness = ensureCodexReady(startupBridge);
  void codexReadiness
    .catch((error) => {
      startupBridge.beginStopping();
      codexRecoverySupervisor.requestRecovery(
        `Codex app-server startup readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

void startDaemon().catch((error) => {
  shutdownAndExit(1, error);
});
