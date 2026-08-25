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
import { getCurrentTurn } from "../lib/codex/thread-state";
import type {
    OrchestratorReloadResponse,
    OrchestratorReloadScope,
    WorkbenchBrowseResultEntry,
    WorkbenchHarness,
} from "../lib/types";
import type { WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";
import {
    expandOrchestratorReloadScopes,
    normalizeOrchestratorReloadScopes,
    validateOrchestratorReloadScopeCombination,
} from "../lib/workbench/orchestrator-reload";
import {
    createWorkbenchThreadRecoveryInput,
    isWorkbenchThreadRecoveryUserMessage,
} from "../lib/workbench/thread/thread-recovery-message";
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
import OrchestratorFeatureHost from "./OrchestratorFeatureHost";
import { createOrchestratorFeatureModuleLoader } from "./orchestrator-feature-loader";
import type { OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification } from "./orchestrator-feature-registry";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";
import WorkbenchCodexMcpGenerationController from "./WorkbenchCodexMcpGenerationController";
import type { WorkbenchHardReloadNotification } from "./WorkbenchOrchestratorReloadController";
import ReloadableWorkbenchOrchestratorReloadController from "./ReloadableWorkbenchOrchestratorReloadController";
import type { WorkbenchHarnessRuntimePort } from "./WorkbenchHarnessController";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
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
const CODEX_BRIDGE_RELOAD_DRAIN_TIMEOUT_MS = 10000;
const CODEX_RECOVERY_INITIAL_RETRY_DELAY_MS = 4000;
const CODEX_RECOVERY_MAX_RETRY_DELAY_MS = 60000;
const CODEX_HEALTH_INTERVAL_MS = 60000;
const CODEX_HEALTH_REQUEST_TIMEOUT_MS = 10000;
const CODEX_HEALTH_FAILURE_THRESHOLD = 10;
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
let codexReloadRecoveryCandidates: WorkbenchTurnRecoveryHandoffCandidate[] = [];
const turnRecoveryHandoffStore = new WorkbenchTurnRecoveryHandoffStore(PROJECT_ROOT);
const codexMcpGenerationController = new WorkbenchCodexMcpGenerationController();
const turnRecoveryController = new WorkbenchTurnRecoveryController(
  turnRecoveryHandoffStore,
  (message) => log("turn-recovery", message),
  async (candidate) => {
    const params = asRecord(candidate.request.params);
    const cwd = typeof params?.cwd === "string" ? params.cwd.trim() : "";
    if (!cwd) {
      logError("turn-recovery", `Recovery failure for ${candidate.harness}:${candidate.threadId} has no cwd for lifecycle publication.`);
      return;
    }
    const project = await featureHost.run("projectCatalog", (controller) => controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench turn recovery" }), "project catalog: turn recovery cwd");
    await featureHost.run("threadState", (feature) => feature.controller.reportRecoveryFailed(project.project.id, candidate.harness, candidate.threadId), "thread state: report recovery failure");
  },
);
const threadTransitionCoordinator = new WorkbenchThreadTransitionCoordinator();
const orchestratorReloadController = new ReloadableWorkbenchOrchestratorReloadController({
  executeScopes: executeReloadScopes,
  hardReload: {
    exitProcess: () => process.exit(0),
    logError: (message) => logError("hard-reload", message),
    notifications: () => createHardReloadNotifications(),
    timeoutMs: 5_000,
  },
  listClaims: async (cwd) => await featureHost.run("gitArc", (feature) => feature.listReloadScopeClaims(cwd), "git arc: reload-scope claim read"),
});
const featureHost = new OrchestratorFeatureHost<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>(
  createOrchestratorFeatureContext(),
  createOrchestratorFeatureModuleLoader(),
  {
    logError: (message) => logError("runtime-drain", message),
    onSwap: (nodeIds) => {
      log("orchestrator", `reloaded orchestrator feature nodes: ${nodeIds.join(", ")}`);
      if (nodeIds.includes("workbench-core")) {
        for (const client of bridgeConnections) sendJsonToClient(client, { method: "workbench/thread-state/reset", params: {} });
      }
    },
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
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(message));
  }
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
  orchestratorReloadController.dispose();
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

function createOrchestratorFeatureContext(): OrchestratorFeatureContext {
  return {
    advanceMcpGeneration: () => {
      const generation = codexMcpGenerationController.bump();
      log("orchestrator", `advanced wb MCP generation to ${generation}`);
    },
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
        return runtime.isAvailable() && !runtime.isTransitioning() && !orchestratorReloadController.isHardReloadPending();
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
      prepareTurnStart: prepareCodexTurnStart,
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
    installSubagentRelationship: async (record) => await featureHost.run(
      "threadState",
      (feature) => feature.installSubagentRelationship(record),
      `thread state: install subagent ${record.harness}:${record.threadId}`,
    ),
    harnessPorts: createHarnessPorts(),
    legacyMigrationProjectRoot: PROJECT_ROOT,
    localOrchestratorOrigin: LOCAL_ORCHESTRATOR_ORIGIN,
    localWorkbenchOrigin: LOCAL_WORKBENCH_ORIGIN,
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
      orchestratorReloadController.notifyEligibilityChanged();
    },
    notifyReloadEligibilityChanged: () => orchestratorReloadController.notifyEligibilityChanged(),
    onCodexFatalExit: (reason, bridge) => {
      if (shuttingDown) return;
      bridge?.beginStopping();
      closeBridgeClients(1011, reason);
      codexRecoverySupervisor.requestRecovery(reason);
    },
    onCodexBridgeActivated: async (restartedAppServer) => {
      if (!restartedAppServer) return;
      const candidates = codexReloadRecoveryCandidates;
      codexReloadRecoveryCandidates = [];
      await turnRecoveryController.recover(candidates, recoverTurnCandidate);
      await recoverPersistedManualResume();
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
      codexReloadRecoveryCandidates = turnRecoveryController.capture(["codex"]);
      closeBridgeClients(1012, "Codex app-server is reloading; reconnect shortly.");
    },
    openCodeAppServerOptions: {
      getReloadableModules: () => featureHost.get("modules"),
    },
    publishThreadState,
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
      const scopes = expandOrchestratorReloadScopes(record?.scopes);
      const invalidCombination = validateOrchestratorReloadScopeCombination(scopes);
      if (invalidCombination) throw new Error(invalidCombination);
      return Response.json(await orchestratorReloadController.request({
        cwd: cwd.trim(),
        harness,
        scopes,
        threadId: threadId.trim(),
      }, signal));
    },
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

async function requestThreadResume(harness: "codex" | "opencode", threadId: string) {
  const { candidate, handoff } = await turnRecoveryController.persistManualResume(harness, threadId);
  setImmediate(() => {
    void turnRecoveryController.recover([candidate], recoverTurnCandidate, handoff).catch((error) => {
      logError("turn-recovery", `Manual resume failed outside the recovery boundary: ${error instanceof Error ? error.message : String(error)}`);
    });
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
  if (orchestratorReloadController.isHardReloadPending()) throw new Error("The orchestrator is hard reloading; new harness work is temporarily unavailable.");
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
      observeRecoveryNotification: (notification) => turnRecoveryController.observeNotification("codex", notification),
      observeRecoveryRequest: (request) => turnRecoveryController.observeRequest("codex", request),
      readThread: async (threadId) => await runAfterCodexBridgeReload((bridge) => bridge.readThreadForBrowse(threadId)),
      request: async (request) => {
        requireHarnessAdmission();
        return await runAfterCodexBridgeReload(async (bridge) => {
          await ensureCodexReady(bridge);
          return await bridge.handleServerRequest(request);
        });
      },
      resumeThread: async (threadId) => await requestThreadResume("codex", threadId),
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
      observeRecoveryNotification: (notification) => turnRecoveryController.observeNotification("opencode", notification),
      observeRecoveryRequest: (request) => turnRecoveryController.observeRequest("opencode", request),
      readThread: async (threadId) => await readGenericBrowseThread("opencode", threadId),
      request: async (request) => {
        requireHarnessAdmission();
        return await runAfterOpenCodeBridgeReload((bridge) => bridge.handleRequest(request));
      },
      resumeThread: async (threadId) => await requestThreadResume("opencode", threadId),
      steerTurn: async (threadId, expectedTurnId, input) => await steerGenericBrowseTurn("opencode", threadId, expectedTurnId, input),
    },
  };
}

async function prepareCodexTurnStart(request: JsonRpcRequest) {
  const params = asRecord(request.params);
  const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
  if (!threadId) throw new Error("Codex turn/start requires a thread id before MCP freshness can be checked.");
  const state = await featureHost.run("threadState", (feature) => feature.getCodexMcpState(threadId), "thread state: read Codex MCP generation");
  const generation = await codexMcpGenerationController.prepare(state.generation, async () => {
    const response = await requestLiveHarness("codex", {
      id: `workbench:mcp-refresh:${codexMcpGenerationController.generation}`,
      method: "config/mcpServer/reload",
      params: null,
    });
    if (response.error) throw new Error(response.error.message);
  });
  await featureHost.run("threadState", (feature) => feature.setManagedCodexMcpGeneration(state.projectId, threadId, generation), "thread state: write Codex MCP generation");
}

async function requestLiveCodexWithDeadline(request: JsonRpcRequest, timeoutMs = CODEX_HEALTH_REQUEST_TIMEOUT_MS) {
  if (orchestratorReloadController.isHardReloadPending()) throw new Error("The orchestrator is hard reloading; new harness work is temporarily unavailable.");
  turnRecoveryController.observeRequest("codex", request);
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
    return await runAfterOpenCodeBridgeReload((bridge) => bridge.recoverInterruptedTurn(candidate));
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

async function runAfterOpenCodeBridgeReload<TValue>(task: (bridge: OpenCodeBridge) => TValue | Promise<TValue>) {
  return await featureHost.run("openCodeBridge", task, "OpenCode bridge operation");
}

async function executeReloadScopes(scopes: OrchestratorReloadScope[]) {
  if (scopes.includes("server:process")) throw new Error("Full orchestrator restart requires the operator hard-reload boundary.");
  await featureHost.reload(scopes);
}

function queueReload(scopes: OrchestratorReloadScope[]) {
  const startedAt = lastReloadResponse.startedAt;
  setImmediate(() => {
    void orchestratorReloadController.executeUnmanaged(scopes).then(() => {
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

async function recoverPersistedManualResume() {
  const handoff = await turnRecoveryHandoffStore.load();
  if (!handoff) return;
  turnRecoveryController.loadCandidates(handoff.candidates);
  await turnRecoveryController.recover(handoff.candidates, recoverTurnCandidate, handoff);
  log("turn-recovery", `settled manual-resume handoff ${handoff.id}`);
}

function handleHardOrchestratorReload(response: http.ServerResponse) {
  if (process.env.WORKBENCH_ORCHESTRATOR_LOOP !== "1") {
    sendHttpJson(response, 409, { error: "Full orchestrator restart requires run-orchestrator-loop.sh to own relaunch." });
    return;
  }

  let admission: OrchestratorReloadResponse;
  try {
    admission = orchestratorReloadController.admitHardReload();
  } catch (error) {
    sendHttpJson(response, 409, { error: error instanceof Error ? error.message : "Unable to admit hard reload." });
    return;
  }
  lastReloadResponse = admission;

  let acknowledged = false;
  response.once("finish", () => {
    acknowledged = true;
    void orchestratorReloadController.beginHardReload().catch((error) => {
      logError("hard-reload", error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
  });
  response.once("close", () => {
    if (acknowledged || response.writableFinished) return;
    orchestratorReloadController.cancelHardReloadAdmission();
  });
  sendHttpJson(response, 202, lastReloadResponse);
}

async function handleReloadHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  let requestedScopes: string[] = [];
  try {
    const rawBody = await readRequestBody(request);
    const parsedBody = rawBody.trim() ? JSON.parse(rawBody) as unknown : {};
    const record = asRecord(parsedBody);
    requestedScopes = expandOrchestratorReloadScopes(record?.scopes);
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

  const combinationError = validateOrchestratorReloadScopeCombination(requestedScopes);
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
  const scopes = requestedScopes as OrchestratorReloadScope[];
  lastReloadResponse = createReloadResponse(scopes);
  sendHttpJson(response, 202, lastReloadResponse);
  queueReload(scopes);
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

  if (orchestratorReloadController.isHardReloadPending()) {
    if ("id" in message) {
      sendJsonToClient(client, {
        id: message.id,
        error: { code: -32000, message: "The orchestrator is hard reloading; reconnect shortly." },
      });
    }
    return;
  }

  if (message.method.startsWith("workbench/thread-state/") && "id" in message) {
    const connectionId = [...bridgeClientsByConnectionId].find(([, candidate]) => candidate === client)?.[0];
    if (!connectionId) return;
    if (message.method === "workbench/thread-state/accepted") {
      const params = asRecord(message.params) ?? {};
      try {
        const harness = featureHost.get("harnesses").resolveHarness(params.harness);
        const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const turnId = typeof params.turnId === "string" ? params.turnId.trim() : "";
        if (!projectId || !threadId || !turnId) throw new Error("Invalid accepted-intent lifecycle evidence.");
        const result = await featureHost.run("threadState", (feature) => feature.controller.acceptIntent(connectionId, { harness, projectId, threadId, turnId }), "thread state: accept intent");
        sendJsonToClient(client, { id: message.id, result });
      } catch (error) {
        sendJsonToClient(client, { id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Accepted-intent publication failed." } });
      }
      return;
    }
    const result = await featureHost.run("threadState", (feature) => feature.controller.handleRequest(connectionId, { method: message.method, ...(asRecord(message.params) ?? {}) }), `thread state: ${message.method}`);
    sendJsonToClient(client, { id: message.id, ...result });
    return;
  }

  if (message.method === "initialize" && "id" in message) {
    try {
      await runAfterCodexBridgeReload(async (bridge) => {
        await ensureCodexReady(bridge);
        sendJsonToClient(client, {
          id: message.id,
          result: bridge.getInitializeResult(),
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

  const strippedMessage = stripHarnessField(message);
  await featureHost.run("harnesses", (controller) => controller.handleBrowserMessage(message[WORKBENCH_HARNESS_FIELD], strippedMessage, client), `harness browser message: ${message[WORKBENCH_HARNESS_FIELD]} ${message.method}`).catch((error) => {
    if ("id" in message) sendJsonToClient(client, { id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Harness bridge request failed." } });
    else logError("harness-bridge", error instanceof Error ? error.message : String(error));
  });
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
      void handleClientMessage(bridgeClient, payload).catch((error) => {
        logError("codex-bridge", error instanceof Error ? error.message : String(error));
      });
    });

    bridgeClient.once("close", () => {
      bridgeClientsByConnectionId.delete(connectionId);
      void featureHost.run("threadState", (feature) => feature.controller.disconnect(connectionId), "thread state: bridge disconnect");
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
      void recoverPersistedManualResume().catch((error) => {
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
