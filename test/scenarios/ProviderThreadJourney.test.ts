/*
 * No exports. Protect shared reopen cancellation while participants are in flight.
 */
import assert from "node:assert/strict";
import test from "node:test";
import IsolatedWorkbench from "./IsolatedWorkbench";
import { SharedRuntimeCheckpoints } from "./ProviderThreadJourney";

test("both providers share one cold reopen at each checkpoint", async () => {
  let stops = 0;
  let starts = 0;
  const runtime = {
    stop: async () => { stops++; },
    start: async () => { starts++; },
  } as unknown as IsolatedWorkbench;
  const checkpoints = new SharedRuntimeCheckpoints(runtime, [], "proof", 2);
  for (const phase of [0, 1]) {
    const first = checkpoints.reopen(phase);
    assert.equal(stops, phase, "One provider must not stop the other provider's active turn");
    await Promise.all([first, checkpoints.reopen(phase)]);
    assert.equal(stops, phase + 1);
    assert.equal(starts, phase + 1);
  }
});

test("failure rejects both providers even while a shared reopen is stopping", async () => {
  const stopping = Promise.withResolvers<void>();
  let starts = 0;
  const runtime = {
    stop: () => stopping.promise,
    start: async () => { starts++; },
  } as unknown as IsolatedWorkbench;
  const checkpoints = new SharedRuntimeCheckpoints(runtime, [], "proof", 2);
  const outcomes: string[] = [];
  const first = checkpoints.reopen(0).then(
    () => { outcomes.push("resolved"); },
    () => { outcomes.push("rejected"); },
  );
  const second = checkpoints.reopen(0).then(
    () => { outcomes.push("resolved"); },
    () => { outcomes.push("rejected"); },
  );
  try {
    checkpoints.fail(new Error("provider failed"));
    assert.deepEqual(outcomes, [], "Reopen owns the runtime until its stop settles");
  } finally {
    stopping.resolve();
    await Promise.all([first, second]);
  }
  assert.deepEqual(outcomes.sort(), ["rejected", "rejected"]);
  assert.equal(starts, 0, "A failed checkpoint must not restart the shared clone");
});
