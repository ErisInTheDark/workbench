/*
 * No production exports. Node tests protect arrival-time barriers, FIFO ordering, and generation invalidation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import CodexBridgeTransitionController from "./CodexBridgeTransitionController";

test("pre-transition messages drain before replacement and during-transition messages wait", async () => {
  const controller = new CodexBridgeTransitionController();
  const events: string[] = [];
  let releaseFirst!: () => void;
  let resolveFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
  controller.enqueueUpstreamMessage(controller.currentGeneration, async () => {
    events.push("old:start");
    resolveFirstStarted();
    await firstGate;
    events.push("old:end");
  }, assert.fail);

  const transition = controller.runTransition(async () => {
    events.push("replace");
  });
  controller.enqueueUpstreamMessage(controller.currentGeneration, () => {
    events.push("new");
  }, assert.fail);
  await firstStarted;
  assert.deepEqual(events, ["old:start"]);
  releaseFirst();
  await transition;
  await controller.waitForIdle();
  assert.deepEqual(events, ["old:start", "old:end", "replace", "new"]);
});

test("hard transition invalidates queued old-generation messages", async () => {
  const controller = new CodexBridgeTransitionController();
  const events: string[] = [];
  controller.enqueueUpstreamMessage(controller.currentGeneration, () => { events.push("stale"); }, assert.fail);
  await controller.runTransition(() => { events.push("replace"); }, { drain: false, invalidateGeneration: true });
  await controller.waitForIdle();
  assert.deepEqual(events, ["replace"]);
});
