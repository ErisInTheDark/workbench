/*
 * No production exports. Node tests protect health arming, failure thresholds, and transition skips. Keywords: codex, health, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { JsonRpcRequest } from "./bridge-types";
import type CodexAppServer from "./CodexAppServer";
import CodexHealthMonitor from "./CodexHealthMonitor";
import CodexStdioBridge from "./CodexStdioBridge";

test("health monitor arms on success and signals only after the configured failures", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let allowed = true;
  let shouldFail = false;
  const recoveries: string[] = [];
  const monitor = new CodexHealthMonitor({
    failureThreshold: 3,
    intervalMs: 10,
    isProbeAllowed: () => allowed,
    isShuttingDown: () => false,
    log: () => undefined,
    logError: () => undefined,
    probe: async () => { if (shouldFail) throw new Error("wedged"); },
    requestRecovery: (reason) => recoveries.push(reason),
  });
  monitor.start();
  context.mock.timers.tick(1);
  await Promise.resolve();
  shouldFail = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    context.mock.timers.tick(10);
    await Promise.resolve();
  }
  assert.equal(recoveries.length, 1);
  allowed = false;
  context.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(recoveries.length, 1);
  monitor.dispose();
});

test("health requests use their deadline without waiting behind another internal response", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-health-deadline-"));
  const sentRequests: JsonRpcRequest[] = [];
  const bridge = new CodexStdioBridge({
    appServer: { send: (message: unknown) => sentRequests.push(message as JsonRpcRequest) } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:4500",
    onNotification: () => undefined,
    sendToClient: () => undefined,
    storageRoot,
  });
  await assert.rejects(
    bridge.handleServerRequest({ id: "health", method: "account/read", params: {} }, { timeoutMs: 20 }),
    /timed out after 20ms/u,
  );
  const blockingRequest = bridge.handleServerRequest({ id: "blocking", method: "account/read", params: {} });
  void blockingRequest.catch(() => undefined);
  await Promise.resolve();
  const healthRequest = bridge.handleServerRequest(
    { id: "independent-health", method: "account/read", params: {} },
    { timeoutMs: 1_000 },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sentRequests.length, 3);
  const dispatchedHealthRequest = sentRequests[2];
  assert.equal(dispatchedHealthRequest?.method, "account/read");
  await bridge.handleUpstreamMessage({ id: dispatchedHealthRequest?.id ?? -1, result: { account: null } });
  await healthRequest;
  await bridge.disposeImmediately();
  await assert.rejects(blockingRequest, /stopped before the upstream response arrived/u);
});
