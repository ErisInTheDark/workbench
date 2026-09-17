/*
 * No production exports. Node tests protect the existing supervisor's coalescing, retry, and disposal ownership.
 */

import assert from "node:assert/strict";
import test from "node:test";

import CodexRecoverySupervisor from "./CodexRecoverySupervisor";

async function flushMicrotasks(count = 5) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

test("recovery supervisor coalesces in-flight requests and preserves the latest reason", async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const supervisor = new CodexRecoverySupervisor({
    initialRetryDelayMs: 10,
    isShuttingDown: () => false,
    log: () => undefined,
    logError: () => undefined,
    maxRetryDelayMs: 40,
    recover: async (reason) => {
      calls.push(reason);
      if (calls.length === 1) await firstGate;
    },
  });
  supervisor.requestRecovery("first");
  await flushMicrotasks();
  supervisor.requestRecovery("second");
  supervisor.requestRecovery("latest");
  releaseFirst();
  await flushMicrotasks();
  assert.deepEqual(calls, ["first", "latest"]);
  supervisor.dispose();
});

test("recovery supervisor retries failures and disposal cancels later retries", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const supervisor = new CodexRecoverySupervisor({
    initialRetryDelayMs: 10,
    isShuttingDown: () => false,
    log: () => undefined,
    logError: () => undefined,
    maxRetryDelayMs: 40,
    recover: async () => {
      attempts += 1;
      throw new Error("still wedged");
    },
  });
  supervisor.requestRecovery("fatal exit");
  await flushMicrotasks();
  assert.equal(attempts, 1);
  context.mock.timers.tick(10);
  await flushMicrotasks();
  assert.equal(attempts, 2);
  supervisor.dispose();
  context.mock.timers.tick(100);
  await flushMicrotasks();
  assert.equal(attempts, 2);
});

test("failed replacement resumes pending recovery without admitting work during handoff", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  const supervisor = new CodexRecoverySupervisor({
    initialRetryDelayMs: 10,
    isShuttingDown: () => false,
    log: () => undefined,
    logError: () => undefined,
    maxRetryDelayMs: 40,
    recover: async reason => {
      calls.push(reason);
      if (calls.length === 1) throw new Error("replacement failed");
    },
  });
  supervisor.requestRecovery("process exited");
  await flushMicrotasks();
  supervisor.pause();
  supervisor.requestRecovery("latest exit");
  context.mock.timers.tick(100);
  await flushMicrotasks();
  assert.deepEqual(calls, ["process exited"]);
  supervisor.resume();
  context.mock.timers.tick(10);
  await flushMicrotasks();
  assert.deepEqual(calls, ["process exited", "latest exit"]);
  supervisor.dispose();
});
