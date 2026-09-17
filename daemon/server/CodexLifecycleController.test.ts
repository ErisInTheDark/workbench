/*
 * No production exports. Protect native readiness failure and retired-owner recovery fencing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import CodexLifecycleController from "./CodexLifecycleController";

test("failed readiness stops its bridge and requests recovery without hiding the failure", async () => {
  const order: string[] = [];
  const failure = new Error("initialization failed");
  const controller = new CodexLifecycleController({
    isShuttingDown: () => false,
    log: () => undefined,
    logError: () => undefined,
    recover: async () => { order.push("recover"); },
  });
  try {
    await assert.rejects(controller.ready({
      ensureInitialized: async () => { throw failure; },
      beginStopping: () => { order.push("stop"); },
    }), error => error === failure);
    assert.deepEqual(order, ["stop", "recover"]);
  } finally {
    controller.dispose();
  }
});

test("retired readiness propagates failure without restarting a newer provider", async () => {
  let retired = false;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const effects: string[] = [];
  const controller = new CodexLifecycleController({
    isShuttingDown: () => retired,
    log: () => undefined,
    logError: () => undefined,
    recover: async () => { effects.push("recover"); },
  });
  const readiness = controller.ready({
    ensureInitialized: () => pending,
    beginStopping: () => { effects.push("stop"); },
  });
  const failure = new Error("retired native process");
  const rejected = assert.rejects(readiness, error => error === failure);
  retired = true;
  controller.dispose();
  fail(failure);
  await rejected;
  assert.deepEqual(effects, []);
});
