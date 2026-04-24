const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const { WebSocketServer } = require("next/dist/compiled/ws");

const CODEX_BRIDGE_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500";
const NEXT_PORT = process.env.PORT ?? "3002";
const RESTART_DELAY_MS = 1000;

const processes = new Map();
const bridgeConnections = new Set();
const bridgePendingResponses = new Map();
let bridgeCodex = null;
let bridgeInitializeResult = null;
let bridgeNextRequestId = 1;
let bridgeServer = null;
let bridgeUpstreamInitialized = false;
let bridgeUpstreamInitializePromise = null;
let bridgeWebSocketServer = null;
let shuttingDown = false;

const specs = [
  {
    name: "next-dev",
    command: "pnpm",
    args: ["run", "dev:next"],
    env: {
      CODEX_APP_SERVER_URL: CODEX_BRIDGE_URL,
      NEXT_PUBLIC_CODEX_APP_SERVER_URL: CODEX_BRIDGE_URL,
      PORT: NEXT_PORT,
    },
  },
];

function log(name, message) {
  process.stdout.write(`[${name}] ${message}\n`);
}

function logError(name, message) {
  process.stderr.write(`[${name}] ${message}\n`);
}

function pipeChildStream(name, stream, write) {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk) => {
    write(chunk);
  });
}

function quoteWindowsCommandPart(part) {
  if (!part.length) {
    return '""';
  }

  if (!/[\s"]/u.test(part)) {
    return part;
  }

  return `"${part.replace(/"/g, '\\"')}"`;
}

function getSpawnDescriptor(spec) {
  if (process.platform !== "win32") {
    return {
      command: spec.command,
      args: spec.args,
    };
  }

  const commandLine = [spec.command, ...spec.args]
    .map((part) => quoteWindowsCommandPart(part))
    .join(" ");

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function getBridgeListenDescriptor(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error(`Codex bridge URL must use ws:// or wss://, received ${url}`);
  }

  return {
    host: parsedUrl.hostname || "127.0.0.1",
    port: Number(parsedUrl.port || (parsedUrl.protocol === "wss:" ? 443 : 80)),
  };
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
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
  bridgePendingResponses.clear();

  if (bridgeCodex && !bridgeCodex.killed) {
    killProcessTree(bridgeCodex.pid);
    bridgeCodex = null;
  }

  if (bridgeWebSocketServer) {
    bridgeWebSocketServer.close();
    bridgeWebSocketServer = null;
  }

  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
}

function scheduleRestart(spec) {
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
    ...(existing ?? {}),
    restartTimer,
  });
}

function startChild(spec) {
  const spawnDescriptor = getSpawnDescriptor(spec);
  const child = spawn(spawnDescriptor.command, spawnDescriptor.args, {
    cwd: __dirname,
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      ...spec.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    detached: process.platform !== "win32",
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

function createStdioCodexChild() {
  const spawnDescriptor = getSpawnDescriptor({
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
  });

  return spawn(spawnDescriptor.command, spawnDescriptor.args, {
    cwd: __dirname,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

function getNextBridgeRequestId() {
  const requestId = bridgeNextRequestId;
  bridgeNextRequestId += 1;
  return requestId;
}

function sendToBridgeCodex(message) {
  if (!bridgeCodex?.stdin.writable) {
    throw new Error("Codex app-server bridge is not running.");
  }

  bridgeCodex.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendJsonToClient(client, message) {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function isJsonRpcResponse(message) {
  return message
    && typeof message === "object"
    && "id" in message
    && ("result" in message || "error" in message);
}

function isJsonRpcNotification(message) {
  return message
    && typeof message === "object"
    && "method" in message
    && "params" in message
    && !("id" in message);
}

function handleBridgeCodexMessage(message) {
  if (isJsonRpcResponse(message)) {
    const pending = bridgePendingResponses.get(message.id);
    if (!pending) {
      return;
    }

    bridgePendingResponses.delete(message.id);
    if (pending.internal) {
      pending.resolve(message);
      return;
    }

    sendJsonToClient(pending.client, {
      ...message,
      id: pending.clientRequestId,
    });
    return;
  }

  if (isJsonRpcNotification(message)) {
    for (const client of bridgeConnections) {
      sendJsonToClient(client, message);
    }
  }
}

function bridgeCodexStdoutToClients(codex) {
  let bufferedOutput = "";

  codex.stdout.on("data", (chunk) => {
    bufferedOutput += chunk.toString("utf8");
    const lines = bufferedOutput.split(/\r?\n/u);
    bufferedOutput = lines.pop() ?? "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      try {
        handleBridgeCodexMessage(JSON.parse(trimmedLine));
      } catch (error) {
        logError("codex-bridge", `invalid upstream JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

function ensureBridgeCodex() {
  if (bridgeCodex && !bridgeCodex.killed) {
    return bridgeCodex;
  }

  bridgeCodex = createStdioCodexChild();
  bridgeNextRequestId = 1;
  bridgePendingResponses.clear();
  bridgeInitializeResult = null;
  bridgeUpstreamInitialized = false;
  bridgeUpstreamInitializePromise = null;
  bridgeCodexStdoutToClients(bridgeCodex);
  pipeChildStream("codex-stdio", bridgeCodex.stderr, (chunk) => process.stderr.write(chunk));

  bridgeCodex.once("error", (error) => {
    logError("codex-stdio", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
    for (const client of bridgeConnections) {
      client.close(1011, "Codex app-server failed to start.");
    }
  });

  bridgeCodex.once("exit", (code, signal) => {
    log("codex-stdio", `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    bridgeCodex = null;
    bridgeInitializeResult = null;
    bridgePendingResponses.clear();
    bridgeUpstreamInitialized = false;
    bridgeUpstreamInitializePromise = null;
    for (const client of bridgeConnections) {
      client.close(1011, "Codex app-server exited.");
    }
  });

  log("codex-bridge", "started shared stdio app-server");
  return bridgeCodex;
}

function requestBridgeCodex(message, { client = null, clientRequestId = null, internal = false } = {}) {
  ensureBridgeCodex();
  const upstreamRequestId = getNextBridgeRequestId();
  const upstreamMessage = {
    ...message,
    id: upstreamRequestId,
  };

  if (internal) {
    const responsePromise = new Promise((resolve, reject) => {
      bridgePendingResponses.set(upstreamRequestId, {
        internal: true,
        reject,
        resolve,
      });
    });
    sendToBridgeCodex(upstreamMessage);
    return responsePromise;
  }

  bridgePendingResponses.set(upstreamRequestId, {
    client,
    clientRequestId,
    internal: false,
  });
  sendToBridgeCodex(upstreamMessage);
  return null;
}

async function ensureBridgeUpstreamInitialized(initializeMessage) {
  if (bridgeUpstreamInitialized) {
    return;
  }

  if (bridgeUpstreamInitializePromise) {
    await bridgeUpstreamInitializePromise;
    return;
  }

  bridgeUpstreamInitializePromise = (async () => {
    const response = await requestBridgeCodex(initializeMessage, { internal: true });
    if (response?.error) {
      throw new Error(response.error.message);
    }

    bridgeInitializeResult = response.result;
    sendToBridgeCodex({ method: "initialized" });
    bridgeUpstreamInitialized = true;
  })();

  try {
    await bridgeUpstreamInitializePromise;
  } finally {
    bridgeUpstreamInitializePromise = null;
  }
}

async function handleClientMessage(client, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    client.close(1003, "Invalid JSON.");
    return;
  }

  if (message?.method === "initialize" && "id" in message) {
    try {
      await ensureBridgeUpstreamInitialized(message);
      sendJsonToClient(client, {
        id: message.id,
        result: bridgeInitializeResult,
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

  if (message?.method === "initialized" && !("id" in message)) {
    return;
  }

  if ("id" in message) {
    requestBridgeCodex(message, {
      client,
      clientRequestId: message.id,
    });
    return;
  }

  sendToBridgeCodex(message);
}

function startCodexBridge() {
  const { host, port } = getBridgeListenDescriptor(CODEX_BRIDGE_URL);
  ensureBridgeCodex();
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
    bridgeWebSocketServer.handleUpgrade(request, socket, head, (client) => {
      bridgeWebSocketServer.emit("connection", client, request);
    });
  });

  bridgeWebSocketServer.on("connection", (client) => {
    bridgeConnections.add(client);
    log("codex-bridge", `client connected (${bridgeConnections.size} active)`);

    client.on("message", (data) => {
      void handleClientMessage(client, data);
    });

    client.once("close", () => {
      bridgeConnections.delete(client);
      for (const [requestId, pending] of bridgePendingResponses) {
        if (!pending.internal && pending.client === client) {
          bridgePendingResponses.delete(requestId);
        }
      }
      log("codex-bridge", `client disconnected (${bridgeConnections.size} active)`);
    });

    client.once("error", (error) => {
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

function shutdownAndExit(exitCode, error) {
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
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdownAndExit(0));
}

process.on("uncaughtException", (error) => shutdownAndExit(1, error));
process.on("unhandledRejection", (reason) => shutdownAndExit(1, reason));
process.on("exit", () => {
  shuttingDown = true;
  stopAllChildren();
});

log("orchestrator", `starting Codex stdio bridge at ${CODEX_BRIDGE_URL} and Next.js on port ${NEXT_PORT}`);
startCodexBridge();
for (const spec of specs) {
  startChild(spec);
}
