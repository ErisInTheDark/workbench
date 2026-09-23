/*
 * Exports: none. Owns physical HTTP/WebSocket connections, process shutdown and graph hosting.
 */
import http from "node:http";
import path from "node:path";

import { WebSocketServer } from "ws";

import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type {
    DaemonReloadResponse,
    DaemonReloadScope,
    WorkbenchHarness,
} from "workbench-shared/types";
import type { WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { BridgeClient, JsonRpcNotification } from "./bridge-types";
import {
    log,
    logError,
} from "./process-helpers";
import { DAEMON_PROCESS_REQUIRED_REGISTRATIONS, type DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { createReloadableNodeModuleLoader } from "./reloadable-node-loader";
import ReloadableNodeHost from "./ReloadableNodeHost";
import type { WorkbenchHardReloadNotification } from "./WorkbenchDaemonReloadController";
import WorkbenchDaemonControlIngress from "./WorkbenchDaemonControlIngress";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import WorkbenchDaemonListener from "./WorkbenchDaemonListener";
import type { WorkbenchDaemonEndpoint } from "workbench-shared/http/workbench-daemon-endpoint";
import WorkbenchServiceLauncher from "../host/WorkbenchServiceLauncher.ts";
import { DaemonHostMessageSchema, type DaemonSleepMessage } from "workbench-shared/http/workbench-daemon-lifecycle";

const DAEMON_ROOT = __dirname;
const DAEMON_PACKAGE_ROOT = path.resolve(DAEMON_ROOT, "..");
const PROJECT_ROOT = path.resolve(DAEMON_PACKAGE_ROOT, "..");
const WORKBENCH_DATA_ROOT = resolveWorkbenchDataRoot();
const DAEMON_RELOAD_PATH = "/daemon/reload";
const DAEMON_BROWSE_PATH = "/daemon/browse";
const DAEMON_BROWSE_SESSIONS_PATH = "/daemon/browse/sessions";

const daemonListener = new WorkbenchDaemonListener({
  endpointPath: path.join(WORKBENCH_DATA_ROOT, "daemon", "runtime.json"),
  leasePath: path.join(WORKBENCH_DATA_ROOT, "daemon", "launch.sqlite3"),
});

const bridgeConnections = new Set<BridgeClient>();
const serviceAttachmentAbort = new AbortController();
const serviceLauncher = process.env.WORKBENCH_SERVICE_MANAGED === "1" ? null : new WorkbenchServiceLauncher({
  root: PROJECT_ROOT,
  warn: message => logError("daemon", message),
});
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
let hostDemand = true;
const sendSleepMessage = (message: DaemonSleepMessage) => new Promise<void>((resolve, reject) => {
  if (!process.connected || !process.send) { reject(new Error("Daemon host IPC is unavailable.")); return; }
  process.send(message, error => error ? reject(error) : resolve());
});
let nextBridgeConnectionId = 0;
const bridgeClientsByConnectionId = new Map<string, BridgeClient>();
const threadTransitionCoordinator = new WorkbenchThreadTransitionCoordinator();
let featureHost: ReloadableNodeHost<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>;
function createFeatureHost(endpoint: WorkbenchDaemonEndpoint) {
  return new ReloadableNodeHost<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>(
  createDaemonFeatureContext(endpoint),
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
}

function sendJsonToClient(client: BridgeClient, message: unknown) {
  void featureHost.run(
    "webSocketRequests",
    (controller) => controller.sendJsonToClient(client, message),
    "browser WebSocket send",
  ).catch((error) => {
    featureHost.get("webSocketRequests").reportSendFailure(message, error);
  });
}

function broadcastToClients(harness: WorkbenchHarness, message: JsonRpcNotification) {
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
  serviceAttachmentAbort.abort(new Error("Daemon is stopping."));
  const closures = featureHost ? [featureHost.dispose()] : [];
  if (serviceLauncher) closures.push(serviceLauncher.close());

  for (const client of bridgeConnections) {
    client.close();
  }
  bridgeConnections.clear();

  if (bridgeWebSocketServer) {
    bridgeWebSocketServer.close();
    bridgeWebSocketServer = null;
  }

  bridgeServer = null;
  const results = await Promise.allSettled(closures);
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  try { await daemonListener.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Daemon child shutdown failed.");
}

function createHardReloadNotifications(): WorkbenchHardReloadNotification[] {
  return [
    {
      name: "process lifecycle",
      notify: () => {
        shuttingDown = true;
      },
    },
    {
      name: "bridge ingress",
      notify: () => {
        closeBridgeClients(1012, "The daemon is hard reloading; reconnect shortly.");
        bridgeWebSocketServer?.close();
        bridgeWebSocketServer = null;
        bridgeServer = null;
        // Keep the installation lease until the graph has relinquished its resources.
        return Promise.allSettled([featureHost.beginHardShutdown()]).then(() => daemonListener.close());
      },
    },
    { name: "feature graph", notify: () => featureHost.beginHardShutdown() },
  ];
}

function createDaemonFeatureContext(endpoint: WorkbenchDaemonEndpoint): DaemonProcessContext {
  return {
    ...(process.connected ? { sleep: {
      demanded: () => hostDemand,
      connected: () => bridgeConnections.size > 0,
      idle: () => !shuttingDown && featureHost.isIdle(),
      send: sendSleepMessage,
      warn: (message: string) => logError("sleep", message),
      commit: async (id: string) => {
        shuttingDown = true;
        try {
          await sendSleepMessage({ type: "workbench-daemon-sleep-result", id, accepted: true });
          await stopAllChildren();
          process.exit(0);
        } catch (error) {
          logError("sleep", `shutdown failed: ${error instanceof Error ? error.message.slice(0, 500) : "unknown failure"}`);
          process.exit(1);
        }
      },
    } } : {}),
    dataRootPath: WORKBENCH_DATA_ROOT,
    daemonPackageRoot: DAEMON_PACKAGE_ROOT,
    isShuttingDown: () => shuttingDown,
    webSocketUrl: endpoint.origin.replace("http:", "ws:"),
    isHardReloadPending: () => featureHost.get("reloadController").isHardReloadPending(),
    broadcastProviderNotification: broadcastToClients,
    browseProjectResolvers: {
      resolveProjectById: (projectId) => featureHost.run("projectCatalog", (controller) => controller.resolveProjectById(projectId), "project catalog: browse project id"),
      resolveProjectFromCwd: (cwd, options) => featureHost.run("projectCatalog", (controller) => controller.resolveAgentEndpointProjectFromCwd(cwd, options), "project catalog: browse cwd"),
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
    legacyMigrationProjectRoot: PROJECT_ROOT,
    localDaemonOrigin: endpoint.origin,
    logTurnRecovery: (message) => log("turn-recovery", message),
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

async function ensureWorkbenchPromptFiles() {
  await featureHost.get("modules").workbenchPromptFiles.ensureWorkbenchPromptFiles();
}

function closeBridgeClients(code: number, reason: string) {
  for (const client of bridgeConnections) {
    client.close(code, reason);
  }
  bridgeConnections.clear();
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

async function startBridgeServer() {
  bridgeWebSocketServer = new WebSocketServer({ noServer: true });
  const handleRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    if (shuttingDown || !daemonListener.ready) {
      sendHttpJson(response, 503, { error: "Workbench daemon is starting or stopping." });
      return;
    }
    if (!await featureHost.get("daemonHttp").admitHttp(request, response)) return;
    if (shuttingDown) {
      sendHttpJson(response, 503, { error: "Workbench daemon is stopping." });
      return;
    }
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
      sendHttpJson(response, 200, daemonListener.current);
      return;
    }

    void featureHost.run("daemonHttp", (router) => router.handleHttpRequest(request, response), `daemon HTTP: ${request.method ?? "UNKNOWN"} ${new URL(request.url ?? "/", "http://localhost").pathname}`).catch((error) => {
      if (!response.headersSent) {
        sendHttpJson(response, 500, { error: error instanceof Error ? error.message : "Daemon feature request failed." });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };
  bridgeServer = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      logError("network", error instanceof Error ? error.message.slice(0, 300) : "Daemon ingress failed.");
      if (!response.headersSent) sendHttpJson(response, 503, { error: "Workbench ingress is unavailable." });
      else response.destroy();
    });
  });

  bridgeServer.on("upgrade", (request, socket, head) => {
    if (shuttingDown || !daemonListener.ready) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    void (async () => {
      if (!await featureHost.get("daemonHttp").admitUpgrade(request)) return;
      if (shuttingDown) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (socket.destroyed) return;
      bridgeWebSocketServer?.handleUpgrade(request, socket, head, (client) => {
        bridgeWebSocketServer?.emit("connection", client, request);
      });
    })().catch((error: unknown) => {
      logError("network", error instanceof Error ? error.message.slice(0, 300) : "WebSocket ingress failed.");
      socket.destroy();
    });
  });

  bridgeWebSocketServer.on("connection", (client) => {
    const bridgeClient = client as unknown as BridgeClient;
    const connectionId = `connection-${++nextBridgeConnectionId}`;
    bridgeClientsByConnectionId.set(connectionId, bridgeClient);
    bridgeConnections.add(bridgeClient);
    featureHost.get("daemonSleep").refresh();
    log("workbench-socket", `client connected (${bridgeConnections.size} active)`);

    bridgeClient.on("message", (payload) => {
      void controlIngress.handle(bridgeClient, connectionId, payload).catch((error) => {
        logError("workbench-socket", error instanceof Error ? error.message : String(error));
      });
    });

    bridgeClient.once("close", () => {
      bridgeClientsByConnectionId.delete(connectionId);
      if (!shuttingDown) {
        void featureHost.run("webSocketRequests", (controller) => controller.disconnect(bridgeClient, connectionId), "browser WebSocket disconnect")
          .catch(error => logError("workbench-socket", `disconnect failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`));
      }
      bridgeConnections.delete(bridgeClient);
      if (!shuttingDown) featureHost.get("daemonSleep").refresh();
      log("workbench-socket", `client disconnected (${bridgeConnections.size} active)`);
    });

    bridgeClient.once("error", (error) => {
      logError("workbench-socket", error instanceof Error ? error.message : String(error));
    });
  });

  bridgeServer.once("error", (error) => {
    shutdownAndExit(1, error);
  });

  return await daemonListener.bind(bridgeServer);
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
  log("daemon", "starting a random loopback listener");
  if (process.env.CODEX_APP_SERVER_URL) {
    log("daemon", "CODEX_APP_SERVER_URL no longer selects a local listener; the bound endpoint is published automatically.");
  }
  const endpoint = await startBridgeServer();
  if (shuttingDown) return;
  log("daemon", "loopback listener bound");
  featureHost = createFeatureHost(endpoint);
  log("daemon", "feature graph loaded");
  await ensureWorkbenchPromptFiles();
  if (shuttingDown) return;
  log("daemon", "prompt library ready");
  await featureHost.start();
  if (shuttingDown) return;
  log("daemon", "feature graph started");
  await daemonListener.publish();
  log("daemon", "runtime endpoint published");
  if (process.connected && process.send) {
    await new Promise<void>((resolve, reject) => {
      process.send!({ type: "workbench-daemon-ready", endpoint }, error => error ? reject(error) : resolve());
    });
  }
  log("workbench-socket", `listening on ${endpoint.origin.replace("http:", "ws:")}`);
  // Publication and provider startup finish before independent networking attaches.
  if (serviceLauncher) {
    void serviceLauncher.ensure(serviceAttachmentAbort.signal).catch(error => {
      if (!serviceAttachmentAbort.signal.aborted) logError("daemon", `network attachment failed: ${error instanceof Error ? error.message.slice(0, 512) : "unknown failure"}`);
    });
  }
}

process.on("message", message => {
  const parsed = DaemonHostMessageSchema.safeParse(message);
  if (!parsed.success) { logError("sleep", "Invalid daemon host lifecycle message."); return; }
  if (parsed.data.type === "workbench-daemon-demand") {
    hostDemand = parsed.data.required;
    featureHost?.get("daemonSleep").refresh();
  } else featureHost?.get("daemonSleep").receive(parsed.data);
});

void startDaemon().catch((error) => {
  shutdownAndExit(1, error);
});
