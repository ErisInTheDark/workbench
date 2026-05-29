import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

import { WebSocketServer } from "next/dist/compiled/ws";

import { createInitializeCapabilities, createInitializeRequest } from "../lib/codex/protocol";
import type {
  OrchestratorReloadRequest,
  OrchestratorReloadResponse,
  OrchestratorReloadScope,
} from "../lib/types";
import type { BridgeClient, HarnessKind, JsonRpcNotification, JsonRpcRequest } from "./bridge-types";
import CodexAppServer from "./CodexAppServer";
import CodexStdioBridge from "./CodexStdioBridge";
import { CopilotBridge } from "./copilot-bridge";
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

const ORCHESTRATOR_ROOT = __dirname;
const WEBAPP_ROOT = path.resolve(ORCHESTRATOR_ROOT, "..");
const PROJECT_ROOT = path.resolve(WEBAPP_ROOT, "..");
const DEFAULT_CODEX_BRIDGE_URL = "ws://0.0.0.0:4500";
const CODEX_BRIDGE_URL = process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_BRIDGE_URL;
const NEXT_PORT = process.env.PORT ?? "3002";
const RESTART_DELAY_MS = 1000;
const ORCHESTRATOR_RELOAD_PATH = "/orchestrator/reload";
const ORCHESTRATOR_RELOAD_SCOPE_VALUES = new Set<OrchestratorReloadScope>([
  "codex-bridge",
  "next-dev",
  "orchestrator-logic",
]);
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
let shuttingDown = false;
let codexBridge: CodexStdioBridge;
let upstreamMessageQueue: Promise<void> = Promise.resolve();
let codexBridgeReloadPromise: Promise<void> | null = null;
let codexFatalExitInProgress = false;

const copilotBridge = new CopilotBridge({
  getReloadableModules: () => reloadableModules,
  onNotification: (notification) => {
    broadcastToClients("copilot", notification);
  },
  projectRoot: WEBAPP_ROOT,
});

const codexAppServer = new CodexAppServer({
  onFatalExit: (reason) => {
    if (codexFatalExitInProgress) {
      return;
    }
    codexFatalExitInProgress = true;
    codexBridge.beginStopping();
    for (const client of bridgeConnections) {
      client.close(1011, reason);
    }

    const pendingUpstreamMessages = upstreamMessageQueue;
    void pendingUpstreamMessages
      .catch(() => undefined)
      .then(() => codexBridge.stopAfterFlushingTranscripts())
      .finally(() => {
        codexReadyPromise = null;
      });
  },
  onMessage: (message) => {
    if (codexFatalExitInProgress) {
      log("codex-bridge", "ignored upstream message after fatal app-server exit");
      return;
    }

    upstreamMessageQueue = upstreamMessageQueue
      .catch(() => undefined)
      .then(() => waitForCodexBridgeReload())
      .then(() => codexBridge.handleUpstreamMessage(message))
      .catch((error) => {
        logError("codex-bridge", `failed to handle upstream message: ${error instanceof Error ? error.message : String(error)}`);
      });
  },
  projectRoot: WEBAPP_ROOT,
});

codexBridge = createCodexBridge();

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
  for (const client of bridgeConnections) {
    sendJsonToClient(client, {
      ...message,
      workbenchHarness: harness,
    });
  }
}

function readHarness(message: JsonRpcRequest): HarnessKind {
  return message[WORKBENCH_HARNESS_FIELD] === "copilot" ? "copilot" : "codex";
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

  codexReadyPromise = codexBridge.ensureInitialized(getBridgeInitializeMessage())
    .catch((error) => {
      codexReadyPromise = null;
      throw error;
    });

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

function normalizeReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value.filter((scope): scope is OrchestratorReloadScope => (
      typeof scope === "string" && ORCHESTRATOR_RELOAD_SCOPE_VALUES.has(scope as OrchestratorReloadScope)
    )),
  ));
}

function createReloadResponse(scopes: OrchestratorReloadScope[]): OrchestratorReloadResponse {
  return {
    appliedScopes: scopes.filter((scope) => scope !== "next-dev"),
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: scopes.filter((scope) => scope === "next-dev"),
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
  reloadableModules = reloadOrchestratorReloadableModules();
  log("orchestrator", "reloaded orchestrator helper modules");
}

async function waitForCodexBridgeReload() {
  while (codexBridgeReloadPromise) {
    await codexBridgeReloadPromise.catch(() => undefined);
  }
}

async function runAfterCodexBridgeReload<TValue>(task: () => TValue | Promise<TValue>) {
  await waitForCodexBridgeReload();
  return await task();
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

function createCodexBridge() {
  return new CodexStdioBridge({
    appServer: codexAppServer,
    bridgeUrl: CODEX_BRIDGE_URL,
    onNotification: (notification) => {
      broadcastToClients("codex", notification);
    },
    sendToClient: (client, message) => {
      sendJsonToClient(client, message);
    },
    storageRoot: PROJECT_ROOT,
  });
}

async function reloadCodexBridge() {
  if (codexBridgeReloadPromise) {
    await codexBridgeReloadPromise;
    return;
  }

  if (codexReadyPromise) {
    await codexReadyPromise.catch(() => undefined);
  }
  codexReadyPromise = null;

  const upstreamQueueBeforeReload = upstreamMessageQueue;
  const reloadPromise = (async () => {
    await upstreamQueueBeforeReload.catch(() => undefined);
    const state = await codexBridge.detachForReload();
    const { default: ReloadedCodexStdioBridge } = reloadCodexBridgeModule();
    codexBridge = new ReloadedCodexStdioBridge({
      appServer: codexAppServer,
      bridgeUrl: CODEX_BRIDGE_URL,
      initialState: state,
      onNotification: (notification) => {
        broadcastToClients("codex", notification);
      },
      sendToClient: (client, message) => {
        sendJsonToClient(client, message);
      },
      storageRoot: PROJECT_ROOT,
    });
    codexFatalExitInProgress = false;
    log("codex-bridge", "reloaded bridge code without restarting app-server");
  })();

  codexBridgeReloadPromise = reloadPromise;
  try {
    await reloadPromise;
  } finally {
    if (codexBridgeReloadPromise === reloadPromise) {
      codexBridgeReloadPromise = null;
    }
  }
}

function queueReload(scopes: OrchestratorReloadScope[]) {
  const startedAt = lastReloadResponse.startedAt;
  setImmediate(() => {
    void (async () => {
      try {
        if (scopes.includes("orchestrator-logic")) {
          reloadOrchestratorLogic();
        }

        if (scopes.includes("codex-bridge")) {
          await reloadCodexBridge();
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

async function handleReloadHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  let payload: OrchestratorReloadRequest | null = null;
  try {
    const rawBody = await readRequestBody(request);
    const parsedBody = rawBody.trim() ? JSON.parse(rawBody) as unknown : {};
    const record = asRecord(parsedBody);
    payload = {
      scopes: normalizeReloadScopes(record?.scopes),
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

  if (harness === "copilot") {
    if (!("id" in message)) {
      return;
    }

    const response = await copilotBridge.handleRequest(stripHarnessField(message));
    sendJsonToClient(client, response);
    return;
  }

  if ("id" in message) {
    const strippedMessage = stripHarnessField(message);
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
    log("codex-bridge", `listening on ${CODEX_BRIDGE_URL}; upstream transport is codex app-server stdio or Copilot SDK`);
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

log("orchestrator", `starting bridge at ${CODEX_BRIDGE_URL} and Next.js on port ${NEXT_PORT}`);
startBridgeServer();
for (const spec of specs) {
  startChild(spec);
}
