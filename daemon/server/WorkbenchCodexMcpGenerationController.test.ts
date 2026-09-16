/*
 * No production exports. Tests protect refresh coalescing, failure retry and catalogue/bridge replacement.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchCodexMcpGenerationController from "./WorkbenchCodexMcpGenerationController";

test("stale threads share one global refresh per generation", async () => {
  const controller = new WorkbenchCodexMcpGenerationController(() => "catalogue");
  let refreshes = 0;
  const refresh = async () => { refreshes += 1; };
  assert.deepEqual(await Promise.all([
    controller.prepare(null, refresh),
    controller.prepare(null, refresh),
  ]), [controller.generation, controller.generation]);
  assert.equal(refreshes, 1);
});

test("a failed refresh leaves the generation retryable", async () => {
  const controller = new WorkbenchCodexMcpGenerationController(() => "catalogue");
  await assert.rejects(controller.prepare(null, async () => { throw new Error("reload failed"); }), /reload failed/u);
  assert.equal(await controller.prepare(null, async () => undefined), controller.generation);
});

test("catalogue revision changes during refresh must settle before admission", async () => {
  let revision = "catalogue-a";
  const controller = new WorkbenchCodexMcpGenerationController(() => revision);
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  let refreshes = 0;
  const refresh = async () => {
    refreshes++;
    if (refreshes === 1) await first;
  };
  const admission = controller.prepare(null, refresh);
  revision = "catalogue-b";
  release();
  const generation = await admission;
  assert.equal(refreshes, 2);
  assert.equal(await controller.prepare(generation, refresh), generation);
  assert.equal(refreshes, 2);
});

test("a replacement bridge does not inherit native freshness from the old bridge", async () => {
  const revision = () => "same-catalogue";
  const old = new WorkbenchCodexMcpGenerationController(revision);
  const previous = await old.prepare(null, async () => undefined);
  const replacement = new WorkbenchCodexMcpGenerationController(revision);
  let refreshes = 0;
  await replacement.prepare(previous, async () => { refreshes++; });
  assert.equal(refreshes, 1);
});

test("concurrent admissions share the replacement refresh when the catalogue changes", async () => {
  let revision = "catalogue-a";
  const controller = new WorkbenchCodexMcpGenerationController(() => revision);
  let releaseFirst!: () => void;
  let releaseReplacement!: () => void;
  let replacementStarted!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const replacement = new Promise<void>(resolve => { releaseReplacement = resolve; });
  const started = new Promise<void>(resolve => { replacementStarted = resolve; });
  let refreshes = 0;
  const refresh = async () => {
    refreshes++;
    if (refreshes === 1) await first;
    else {
      replacementStarted();
      await replacement;
    }
  };
  const admissions = [controller.prepare(null, refresh)];
  revision = "catalogue-b";
  admissions.push(controller.prepare(null, refresh), controller.prepare(null, refresh));
  releaseFirst();
  await started;
  releaseReplacement();
  assert.deepEqual(await Promise.all(admissions), admissions.map(() => controller.generation));
  assert.equal(refreshes, 2);
});
