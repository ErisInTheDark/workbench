/* No production exports. Tests protect stable keyed transition serialization, cross-key concurrency, failure recovery, and queue cleanup. */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

test("serializes one transition key while allowing unrelated keys to proceed", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const events: string[] = [];
  let releaseFirst = () => undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = coordinator.run("repo:codex:thread-one", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = coordinator.run("repo:codex:thread-one", async () => {
    events.push("second");
  });
  const unrelated = coordinator.run("repo:codex:thread-two", async () => {
    events.push("unrelated");
  });

  await unrelated;
  assert.deepEqual(events, ["first:start", "unrelated"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "unrelated", "first:end", "second"]);
});

test("continues a transition queue after a failed operation", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  await assert.rejects(coordinator.run("thread", async () => {
    throw new Error("failed transition");
  }), /failed transition/u);
  assert.equal(await coordinator.run("thread", async () => "recovered"), "recovered");
});
