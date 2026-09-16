/* No production exports. Protect shared recovery scheduling, scoped drain and continuation policy. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";

test("shared recovery schedules provider-owned work and expires it through its owner", async () => {
  let execute!: () => Promise<void>;
  let finish!: () => void;
  const controller = new WorkbenchTurnRecoveryController(
    () => undefined,
    async (_label, task) => {
      await new Promise<void>(resolve => { finish = resolve; execute = task; });
    },
  );
  const owner = new AbortController();
  let calls = 0;
  controller.schedule("provider refresh", owner.signal, () => owner.abort(), async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(controller.listRuntimeDrainPending().length, 1);
  controller.expireRuntimeDrain();
  await execute();
  finish();
  await controller.waitForIdle();
  assert.equal(calls, 0);
  assert.equal(owner.signal.aborted, true);
  assert.throws(() => controller.schedule("late", owner.signal, () => undefined, async () => undefined), /draining/);
});

test("shared continuation policy leaves completed, blocked and pending-input ownership intact", () => {
  const controller = new WorkbenchTurnRecoveryController(() => undefined);
  assert.equal(controller.shouldContinue(null, false), false);
  assert.equal(controller.shouldContinue({ kind: "needsAttention", reason: "noActiveTurn", settled: false }, false), true);
  assert.equal(controller.shouldContinue({ kind: "needsAttention", reason: "noActiveTurn", settled: false }, true), false);
});
