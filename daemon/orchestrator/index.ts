/*
 * Keywords: orchestrator, process, reload, health, websocket, Browse, codex, copilot, opencode.
 * No exports. Starts the bridge server and graph host, wires stable recovery ingress,
 * and provides process-owned harness, reload, and supervisor ports to reloadable nodes.
 */
import http from "node:http";
import path from "node:path";

import { WebSocketServer } from "ws";

import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { createInitializeCapabilities, createInitializeRequest } from "workbench-shared/codex/protocol";
import type {
    OrchestratorReloadResponse,
    OrchestratorReloadScope,
    WorkbenchBrowseResultEntry,
    WorkbenchHarness,
} from "workbench-shared/types";
import type { WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { BridgeClient, HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexRecoverySupervisor from "./CodexRecoverySupervisor";
import type CodexStdioBridge from "./CodexStdioBridge";
import { CopilotBridge } from "./copilot-bridge";
import type { OpenCodeBridge } from "./opencode-bridge";
import {
    log,
    logError,
} from "./process-helpers";
import { ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS, type OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { createReloadableNodeModuleLoader } from "./reloadable-node-loader";
import ReloadableNodeHost from "./ReloadableNodeHost";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";
import type { WorkbenchHardReloadNotification } from "./WorkbenchOrchestratorReloadController";
import WorkbenchOrchestratorControlIngress from "./WorkbenchOrchestratorControlIngress";
import type { WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

const ORCHESTRATOR_ROOT = __dirname;
const WEBAPP_ROOT = path.resolve(ORCHESTRATOR_ROOT, "..");
const PROJECT_ROOT = path.resolve(WEBAPP_ROOT, "..");
const DEFAULT_CODEX_BRIDGE_URL = "ws://0.0.0.0:4500";
const CODEX_BRIDGE_URL = process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_BRIDGE_URL;
const ORCHESTRATOR_RELOAD_PATH = "/orchestrator/reload";
const ORCHESTRATOR_BROWSE_PATH = "/orchestrator/browse";
const ORCHESTRATOR_BROWSE_SESSIONS_PATH = "/orchestrator/browse/sessions";
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

const LOCAL_ORCHESTRATOR_ORIGIN = `http://127.0.0.1:${parseWebSocketPort(CODEX_BRIDGE_URL)}`;
const workbenchAgentCliEnvironment = new WorkbenchAgentCliEnvironment({
  origin: LOCAL_ORCHESTRATOR_ORIGIN,
  runtimeDirectoryPath: path.join(WEBAPP_ROOT, "node_modules", ".bin"),
  shellSourcePath: path.join(WEBAPP_ROOT, "lib", "workbench", "cli", "workbench-agent-cli.sh"),
});

const bridgeConnections = new Set<BridgeClient>();
let bridgeServer: http.Server | null = null;
let bridgeWebSocketServer: WebSocketServer | null = null;
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
let shuttingDown = false;
let nextBridgeConnectionId = 0;
const bridgeClientsByConnectionId = new Map<string, BridgeClient>();
let codexRecoverySupervisor: CodexRecoverySupervisor;
const threadTransitionCoordinator = new WorkbenchThreadTransitionCoordinator();
const featureHost = new ReloadableNodeHost<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>(
  createOrchestratorFeatureContext(),
  createReloadableNodeModuleLoader(),
  {
    logError: (message) => logError("runtime-drain", message),
    onSwap: (nodeIds) => {
      log("orchestrator", `reloaded orchestrator feature nodes: ${nodeIds.join(", ")}`);
      if (nodeIds.includes("server:core")) {
        for (const client of bridgeConnections) sendJsonToClient(client, { method: "workbench/thread-state/reset", params: {} });
      }
    },
    requiredRegistrations: ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS,
    requiredScopes: ["server:topology"],
    runtimeDrainTimeoutMs: 30_000,
  },
);

const copilotBridge = new CopilotBridge({
  getReloadableModules: () => featureHost.get("modules"),
  onNotification: (notification) => {
    broadcastToClients("copilot", notification);
  },
  projectRoot: WEBAPP_ROOT,
});

codexRecoverySupervisor = createCodexRecoverySupervisor();

function sendJsonToClient(client: BridgeClient, message: unknown) {
  void featureHost.run(
    "webSocketRequests",
    (controller) => controller.sendJsonToClient(client, message),
    "browser WebSocket send",
  ).catch((error) => {
    logError("websocket", error instanceof Error ? error.message : String(error));
  });
}

function broadcastToClients(harness: HarnessKind, message: JsonRpcNotification) {
  featureHost.get("harnesses").observeNotification(harness, message);
  void featureHost.observeProviderNotification({ harness, notification: message }, `provider notification: ${harness} ${message.method}`).catch((error) => {
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

function createReloadResponse(scopes: OrchestratorReloadScope[]): OrchestratorReloadResponse {
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
  await featureHost.dispose();

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
        closeBridgeClients(1012, "The orchestrator is hard reloading; reconnect shortly.");
        bridgeWebSocketServer?.close();
        bridgeWebSocketServer = null;
        bridgeServer?.close();
        bridgeServer = null;
      },
    },
    { name: "feature graph", notify: () => featureHost.beginHardShutdown() },
    { name: "Copilot bridge", notify: async () => await copilotBridge.stop() },
  ];
}

function createOrchestratorFeatureContext(): OrchestratorProcessContext {
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
      readThread: async (harness, threadId) => await featureHost.get("harnesses").readThread(harness, threadId),
      recordResult: async (entry) => await runAfterCodexBridgeReload((bridge) => bridge.recordBrowseResultForBrowse(entry)),
      steerTurn: async (harness, threadId, expectedTurnId, input) => await featureHost.get("harnesses").steerTurn(harness, threadId, expectedTurnId, input),
    },
    codexAppServerOptions: {
      log,
      logError,
      projectRoot: WEBAPP_ROOT,
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
      onNotification: (notification) => broadcastToClients("codex", notification),
      resolveProjectFromCwd: resolveProjectFromCurrentCatalog,
      sendToClient: (client, message) => sendJsonToClient(client, message),
      storageRoot: PROJECT_ROOT,
    }),
    openCodeBridgeOptions: {
      onNotification: (notification) => broadcastToClients("opencode", notification),
      projectRoot: PROJECT_ROOT,
    },
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
    localOrchestratorOrigin: LOCAL_ORCHESTRATOR_ORIGIN,
    logTurnRecovery: (message) => log("turn-recovery", message),
    onCodexFatalExit: (reason, bridge) => {
      if (shuttingDown) return;
      bridge?.beginStopping();
      closeBridgeClients(1011, reason);
      codexRecoverySupervisor.requestRecovery(reason);
    },
    onCodexBridgeReady: async (bridge) => {
      await ensureWorkbenchPromptFiles();
      try {
        await ensureCodexReady(bridge);
      } catch (error) {
        bridge.beginStopping();
        codexRecoverySupervisor.requestRecovery("Codex bridge replacement could not restore app-server readiness.");
        throw error;
      }
    },
    onCodexBridgeUnavailable: (restartingAppServer) => {
      if (!restartingAppServer) return;
      closeBridgeClients(1012, "Codex app-server is reloading; reconnect shortly.");
    },
    openCodeAppServerOptions: {
      getReloadableModules: () => featureHost.get("modules"),
    },
    publishThreadState,
    reportTurnRecoveryFailure: async (cwd, harness, threadId) => {
      const project = await featureHost.run(
        "projectCatalog",
        (controller) => controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench turn recovery" }),
        "project catalog: turn recovery cwd",
      );
      await featureHost.run(
        "threadState",
        (feature) => feature.controller.reportRecoveryFailed(project.project.id, harness, threadId),
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
  if (featureHost.get("reloadController").isHardReloadPending()) throw new Error("The orchestrator is hard reloading; new harness work is temporarily unavailable.");
}

function readGenericBrowseThread(harness: "copilot" | "opencode", threadId: string) {
  return requestGenericBrowseHarness<ThreadReadResponse>(harness, {
    id: 0,
    method: "thread/read",
    params: { includeTurns: true, threadId },
  });
}

async function requestGenericBrowseHarness<TValue>(harness: "copilot" | "opencode", message: JsonRpcRequest): Promise<TValue> {
  requireHarnessAdmission();
  const response = harness === "copilot"
    ? await copilotBridge.handleRequest(message)
    : await runAfterOpenCodeBridgeReload((bridge) => bridge.handleRequest(message));
  if (response.error) throw new Error(response.error.message);
  return response.result as TValue;
}

async function steerGenericBrowseTurn(harness: "copilot" | "opencode", threadId: string, expectedTurnId: string, input: UserInput[]) {
  const result = await requestGenericBrowseHarness<{ turnId?: string } | { ok?: boolean }>(harness, {
    id: 0,
    method: "turn/steer",
    params: { expectedTurnId, input, threadId },
  });
  const resultRecord = asRecord(result);
  return typeof resultRecord?.turnId === "string" ? resultRecord.turnId : null;
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
      request: async (request) => {
        requireHarnessAdmission();
        return await runAfterCodexBridgeReload(async (bridge) => {
          await ensureCodexReady(bridge);
          return await bridge.handleServerRequest(request);
        });
      },
      steerTurn: async (threadId, expectedTurnId, input) => await runAfterCodexBridgeReload((bridge) => bridge.steerTurnForBrowse(threadId, expectedTurnId, input)),
    },
    copilot: {
      handleBrowserMessage: async (message, client) => {
        if (!("id" in message)) return;
        requireHarnessAdmission();
        sendJsonToClient(client, await copilotBridge.handleRequest(message));
      },
      readThread: async (threadId) => await readGenericBrowseThread("copilot", threadId),
      request: async (request) => {
        requireHarnessAdmission();
        return await copilotBridge.handleRequest(request);
      },
      steerTurn: async (threadId, expectedTurnId, input) => await steerGenericBrowseTurn("copilot", threadId, expectedTurnId, input),
    },
    opencode: {
      handleBrowserMessage: async (message, client) => {
        if (!("id" in message)) return;
        requireHarnessAdmission();
        sendJsonToClient(client, await runAfterOpenCodeBridgeReload((bridge) => bridge.handleRequest(message)));
      },
      readThread: async (threadId) => await readGenericBrowseThread("opencode", threadId),
      request: async (request) => {
        requireHarnessAdmission();
        return await runAfterOpenCodeBridgeReload((bridge) => bridge.handleRequest(request));
      },
      recoverInterruptedTurn: async (candidate) => await runAfterOpenCodeBridgeReload((bridge) => bridge.recoverInterruptedTurn(candidate)),
      steerTurn: async (threadId, expectedTurnId, input) => await steerGenericBrowseTurn("opencode", threadId, expectedTurnId, input),
    },
  };
}

async function requestLiveCodexWithDeadline(request: JsonRpcRequest, timeoutMs = CODEX_HEALTH_REQUEST_TIMEOUT_MS) {
  if (featureHost.get("reloadController").isHardReloadPending()) throw new Error("The orchestrator is hard reloading; new harness work is temporarily unavailable.");
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

async function runAfterOpenCodeBridgeReload<TValue>(task: (bridge: OpenCodeBridge) => TValue | Promise<TValue>) {
  return await featureHost.run("openCodeBridge", task, "OpenCode bridge operation");
}

async function executeReloadScopes(scopes: OrchestratorReloadScope[]) {
  if (scopes.includes("server:process")) throw new Error("Full orchestrator restart requires the operator hard-reload boundary.");
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

function queueReload(scopes: OrchestratorReloadScope[]) {
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
      logError("orchestrator", error instanceof Error ? error.stack ?? error.message : message);
    });
  });
}

function handleHardOrchestratorReload(response: http.ServerResponse) {
  if (process.env.WORKBENCH_ORCHESTRATOR_LOOP !== "1") {
    sendHttpJson(response, 409, { error: "Full orchestrator restart requires the orchestrator runner to own relaunch." });
    return;
  }

  let admission: OrchestratorReloadResponse;
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
  let requestedScopes: OrchestratorReloadScope[] = [];
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
    handleHardOrchestratorReload(response);
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

const controlIngress = new WorkbenchOrchestratorControlIngress({
  getReloadController: () => featureHost.get("reloadController"),
  log: (message) => log("orchestrator", message),
  logError: (message) => logError("orchestrator-control", message),
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
    if (requestPath === ORCHESTRATOR_BROWSE_PATH && request.method === "POST") {
      void featureHost.run("browseExecution", (execution) => execution.handleBrowseHttpRequest(request, response), "Browse HTTP request").catch((error) => {
        if (!response.headersSent) {
          sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Browse request failed." });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
      return;
    }

    if (requestPath === ORCHESTRATOR_BROWSE_SESSIONS_PATH && (request.method === "GET" || request.method === "POST")) {
      void featureHost.run("browseExecution", (execution) => execution.handleSessionsHttpRequest(request, response), "Browse session HTTP request").catch((error) => {
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

    void featureHost.run("orchestratorHttp", (router) => router.handleHttpRequest(request, response), `orchestrator HTTP: ${request.method ?? "UNKNOWN"} ${new URL(request.url ?? "/", "http://localhost").pathname}`).catch((error) => {
      if (!response.headersSent) {
        sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Orchestrator feature request failed." });
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
      void featureHost.run("webSocketRequests", (controller) => controller.disconnect(bridgeClient, connectionId), "browser WebSocket disconnect");
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

  void stopAllChildren().finally(() => copilotBridge.stop()).finally(() => {
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
  log("orchestrator", `starting bridge at ${CODEX_BRIDGE_URL}`);
  await workbenchAgentCliEnvironment.install();
  await ensureWorkbenchPromptFiles();
  await featureHost.start();
  startBridgeServer();
  const startupBridge = featureHost.get("codexBridge");
  const codexReadiness = ensureCodexReady(startupBridge);
  void codexReadiness
    .then(() => {
      void Promise.all([
        featureHost.run("harnesses", (harnesses) => harnesses.recoverAvailable("codex"), "Codex persisted turn recovery"),
        featureHost.run("harnesses", (harnesses) => harnesses.recoverAvailable("opencode"), "OpenCode persisted turn recovery"),
      ]).catch((error) => {
        logError("turn-recovery", `startup manual-resume recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    })
    .catch((error) => {
      startupBridge.beginStopping();
      codexRecoverySupervisor.requestRecovery(
        `Codex app-server startup readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

void startOrchestrator().catch((error) => {
  shutdownAndExit(1, error);
});
