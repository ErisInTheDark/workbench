/*
 * No production exports. Tests protect health arming, failure thresholds, deadlines and independent dispatch.
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

test("a retired probe cannot affect resumed monitoring", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectProbe!: (error: Error) => void;
  const probe = new Promise<void>((_resolve, reject) => { rejectProbe = reject; });
  const recoveries: string[] = [];
  let probes = 0;
  let rejectCurrent!: (error: Error) => void;
  const current = new Promise<void>((_resolve, reject) => { rejectCurrent = reject; });
  const monitor = new CodexHealthMonitor({
    failureThreshold: 1,
    intervalMs: 10,
    isProbeAllowed: () => true,
    isShuttingDown: () => false,
    log: () => undefined,
    logError: () => undefined,
    probe: () => ++probes === 1 ? probe : current,
    requestRecovery: reason => recoveries.push(reason),
  });
  monitor.start({ armed: true });
  context.mock.timers.tick(1);
  monitor.dispose();
  monitor.start({ armed: true });
  context.mock.timers.tick(1);
  rejectProbe(new Error("old process failed"));
  await Promise.resolve();
  assert.deepEqual(recoveries, []);
  assert.equal(probes, 2);
  rejectCurrent(new Error("current process failed"));
  await Promise.resolve();
  assert.equal(recoveries.length, 1);
  monitor.dispose();
});

test("health requests use their deadline without waiting behind another internal response", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-health-deadline-"));
  const sentRequests: JsonRpcRequest[] = [];
  const bridge = new CodexStdioBridge({
    appServer: { send: (message: unknown) => sentRequests.push(message as JsonRpcRequest) } as unknown as CodexAppServer,
    handleWorkbenchRequest: async (request) => ({ id: request.id ?? null, error: { code: -32000, message: "Unexpected Workbench request." } }),
    onNotification: () => undefined,
    resolveProjectFromCwd: async () => { throw new Error("Project resolution is not expected in this test."); },
  });
  const deadline = assert.rejects(
    bridge.handleServerRequest({ id: "health", method: "account/read", params: {} }, { timeoutMs: 20 }),
    /timed out after 20ms/u,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(20);
  await deadline;
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
