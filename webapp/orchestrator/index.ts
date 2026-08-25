/*
 * Exports:
 * - startOrchestrator side effect: starts the Workbench bridge server, managed Next.js dev server, Browse cleanup supervisor, and bridge integrations. Keywords: orchestrator, next-dev, codex, copilot, opencode.
 *
 * Helpers:
 * - HTTP reload helpers: parse, proxy, queue, and report orchestrator reload scopes. Keywords: reload, next-dev, bridge.
 * - Reloadable feature handoff: label leased operations, enforce runtime-drain deadlines, and keep stable reload, health, and Browse ingress process-owned. Keywords: orchestrator, http, router, reload, feature, drain.
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
import type {
    OrchestratorReloadResponse,
    OrchestratorReloadScope,
    WorkbenchBrowseResultEntry,
    WorkbenchHarness,
} from "../lib/types";
import type { WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import type { BridgeClient, HarnessKind, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexRecoverySupervisor from "./CodexRecoverySupervisor";
import type CodexStdioBridge from "./CodexStdioBridge";
import { CopilotBridge } from "./copilot-bridge";
import type { OpenCodeBridge } from "./opencode-bridge";
import {
    createSpawnOptions,
    getSpawnDescriptor,
    killProcessTree,
    killProcessTreeAsync,
    log,
    logError,
    pipeChildStream,
    type ProcessSpec,
    type RunningProcess,
} from "./process-helpers";
import { ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS, type OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { createReloadableNodeModuleLoader } from "./reloadable-node-loader";
import ReloadableNodeHost from "./ReloadableNodeHost";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";
import type { WorkbenchHardReloadNotification } from "./WorkbenchOrchestratorReloadController";
import type { WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

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
const CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS = 10000;
const CODEX_RECOVERY_INITIAL_RETRY_DELAY_MS = 4000;
const CODEX_RECOVERY_MAX_RETRY_DELAY_MS = 60000;
const CODEX_HEALTH_INTERVAL_MS = 60000;
const CODEX_HEALTH_REQUEST_TIMEOUT_MS = 10000;
const CODEX_HEALTH_FAILURE_THRESHOLD = 10;
const BROWSE_CONTROLLER_RELOAD_DRAIN_TIMEOUT_MS = 5000;

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

const specs: ProcessSpec[] = [
  {
    name: "next-dev",
    command: "pnpm",
    args: ["run", "dev:next"],
    env: nextDevEnv,
  },
];

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
    appliedScopes: scopes.filter((scope) => scope !== "client:all" && scope !== "server:process"),
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: scopes.filter((scope) => scope === "client:all" || scope === "server:process"),
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

  for (const entry of processes.values()) {
    if (entry.child && !entry.child.killed) {
      killProcessTree(entry.child.pid);
    }
  }

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
  const activeChildPids = Array.from(processes.values(), ({ child }) => child && !child.killed ? child.pid : undefined)
    .filter((pid): pid is number => typeof pid === "number");
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
    {
      name: "managed child processes",
      notify: async () => {
        await Promise.all(activeChildPids.map(async (pid) => await killProcessTreeAsync(pid)));
      },
    },
  ];
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
    localWorkbenchOrigin: LOCAL_WORKBENCH_ORIGIN,
    logTurnRecovery: (message) => log("turn-recovery", message),
    nextDevHealthOptions: {
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
    },
    notifyThreadLifecycle: () => {
      featureHost.get("reloadController").notifyEligibilityChanged();
    },
    notifyReloadEligibilityChanged: () => featureHost.get("reloadController").notifyEligibilityChanged(),
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
    reloadClient: async () => {
      const nextSpec = findProcessSpec("next-dev");
      if (!nextSpec) throw new Error("Next.js dev process is not registered with the orchestrator.");
      restartChild(nextSpec);
      log("orchestrator", "queued Next.js dev restart");
    },
    requestOrchestratorReload: async (body, signal) => {
      const record = asRecord(body);
      const harness = record?.callerHarness;
      const threadId = record?.callerThreadId;
      const cwd = record?.cwd;
      if (typeof threadId !== "string" || !threadId.trim()) {
        throw new Error("A managed thread identity is required.");
      }
      if (typeof cwd !== "string" || !cwd.trim()) {
        throw new Error("A valid working directory is required.");
      }
      if (harness !== "codex" && harness !== "copilot" && harness !== "opencode") {
        throw new Error("A supported managed harness is required.");
      }
      const reloadController = featureHost.get("reloadController");
      const scopes = reloadController.resolveSelections({ all: record?.all === true, scopes: record?.scopes }, "agent");
      const invalidCombination = reloadController.validateCombination(scopes);
      if (invalidCombination) throw new Error(invalidCombination);
      return Response.json(await featureHost.get("reloadController").request({
        cwd: cwd.trim(),
        harness,
        scopes,
        threadId: threadId.trim(),
      }, signal));
    },
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
    sendHttpJson(response, 409, { error: "Full orchestrator restart requires run-orchestrator-loop.sh to own relaunch." });
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

async function handleClientMessage(client: BridgeClient, connectionId: string, data: Buffer) {
  await featureHost.run(
    "webSocketRequests",
    (controller) => controller.handleMessage(client, connectionId, data, featureHost.get("reloadController").isHardReloadPending()),
    "browser WebSocket message",
  );
}

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
      void handleClientMessage(bridgeClient, connectionId, payload).catch((error) => {
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
  log("orchestrator", `starting bridge at ${CODEX_BRIDGE_URL} and Next.js on port ${NEXT_PORT}`);
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
  for (const spec of specs) {
    startChild(spec);
  }
}

void startOrchestrator().catch((error) => {
  shutdownAndExit(1, error);
});
