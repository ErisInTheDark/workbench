import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

import { WebSocketServer } from "next/dist/compiled/ws";

import { createInitializeCapabilities, createInitializeRequest } from "../lib/codex/protocol";
import type { BridgeClient, HarnessKind, JsonRpcNotification, JsonRpcRequest } from "./bridge-types";
import { CodexStdioBridge } from "./codex-stdio-bridge";
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

const ORCHESTRATOR_ROOT = __dirname;
const WEBAPP_ROOT = path.resolve(ORCHESTRATOR_ROOT, "..");
const CODEX_BRIDGE_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const NEXT_PORT = process.env.PORT ?? "3002";
const RESTART_DELAY_MS = 1000;
const WORKBENCH_HARNESS_FIELD = "workbenchHarness";

const processes = new Map<string, RunningProcess>();
const bridgeConnections = new Set<BridgeClient>();
let bridgeServer: http.Server | null = null;
let bridgeWebSocketServer: WebSocketServer | null = null;
let codexReadyPromise: Promise<void> | null = null;
let shuttingDown = false;

const copilotBridge = new CopilotBridge({
  onNotification: (notification) => {
    broadcastToClients("copilot", notification);
  },
  projectRoot: WEBAPP_ROOT,
});

const codexBridge = new CodexStdioBridge({
  bridgeUrl: CODEX_BRIDGE_URL,
  onFatalExit: (reason) => {
    for (const client of bridgeConnections) {
      client.close(1011, reason);
    }
  },
  onNotification: (notification) => {
    broadcastToClients("codex", notification);
  },
  projectRoot: WEBAPP_ROOT,
  sendToClient: (client, message) => {
    sendJsonToClient(client, message);
  },
});

const specs: ProcessSpec[] = [
  {
    name: "next-dev",
    command: "pnpm",
    args: ["run", "dev:next"],
    env: {
      ...process.env,
      CODEX_APP_SERVER_URL: CODEX_BRIDGE_URL,
      NEXT_PUBLIC_CODEX_APP_SERVER_URL: CODEX_BRIDGE_URL,
      PORT: NEXT_PORT,
    },
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

function stopAllChildren() {
  for (const entry of processes.values()) {
    if (entry.child && !entry.child.killed) {
      killProcessTree(entry.child.pid);
    }
  }

  for (const client of bridgeConnections) {
    client.close();
  }
  bridgeConnections.clear();

  codexBridge.stop();

  if (bridgeWebSocketServer) {
    bridgeWebSocketServer.close();
    bridgeWebSocketServer = null;
  }

  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
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
      await ensureCodexReady();
      sendJsonToClient(client, {
        id: message.id,
        result: codexBridge.getInitializeResult(),
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
    codexBridge.forwardRequest(stripHarnessField(message), client, message.id as number | string);
    return;
  }

  codexBridge.forwardNotification(stripHarnessField(message));
}

function startBridgeServer() {
  const { host, port } = codexBridge.getListenDescriptor();
  bridgeWebSocketServer = new WebSocketServer({ noServer: true });
  bridgeServer = http.createServer((request, response) => {
    if (request.url === "/readyz" || request.url === "/healthz") {
      response.writeHead(200, {
        "Content-Type": "application/json",
      });
      response.end("{}");
      return;
    }

    response.writeHead(404, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ error: "Not found" }));
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
      void handleClientMessage(bridgeClient, payload);
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
    void ensureCodexReady().catch((error) => {
      logError("codex-bridge", error instanceof Error ? error.message : String(error));
    });
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

  stopAllChildren();
  void copilotBridge.stop().finally(() => {
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
  stopAllChildren();
});

log("orchestrator", `starting bridge at ${CODEX_BRIDGE_URL} and Next.js on port ${NEXT_PORT}`);
startBridgeServer();
for (const spec of specs) {
  startChild(spec);
}
