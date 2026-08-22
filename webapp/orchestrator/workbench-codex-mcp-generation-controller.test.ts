/*
 * No production exports. Node tests protect generation coalescing, failure retry, and concurrent bump admission. Keywords: MCP, generation, refresh, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchCodexMcpGenerationController from "./WorkbenchCodexMcpGenerationController";

test("stale threads share one global refresh per generation", async () => {
  const controller = new WorkbenchCodexMcpGenerationController("epoch");
  let refreshes = 0;
  const refresh = async () => { refreshes += 1; };
  assert.deepEqual(await Promise.all([
    controller.prepare(null, refresh),
    controller.prepare(null, refresh),
  ]), ["epoch:0", "epoch:0"]);
  assert.equal(refreshes, 1);
});

test("a failed refresh leaves the generation retryable", async () => {
  const controller = new WorkbenchCodexMcpGenerationController("epoch");
  await assert.rejects(controller.prepare(null, async () => { throw new Error("reload failed"); }), /reload failed/u);
  assert.equal(await controller.prepare(null, async () => undefined), "epoch:0");
});

test("a bump during refresh requires the newer generation before admission", async () => {
  const controller = new WorkbenchCodexMcpGenerationController("epoch");
  let release = () => undefined;
  const firstRefresh = new Promise<void>((resolve) => { release = resolve; });
  let refreshes = 0;
  const prepared = controller.prepare(null, async () => {
    refreshes += 1;
    if (refreshes === 1) await firstRefresh;
  });
  controller.bump();
  release();
  assert.equal(await prepared, "epoch:1");
  assert.equal(refreshes, 2);
});
