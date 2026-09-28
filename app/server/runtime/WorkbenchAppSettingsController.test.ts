/*
 * No production exports. Protect durable requested settings versus the running process's applied mode.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppSettingsController from "./WorkbenchAppSettingsController";

test("persisting requested mode does not claim the running process changed", async () => {
  let requested = false;
  const updates: boolean[] = [];
  const controller = new WorkbenchAppSettingsController({
    readAppliedReactDevelopmentMode: () => false,
    readRequestedReactDevelopmentMode: () => requested,
    writeRequestedReactDevelopmentMode: async (value) => {
      updates.push(value);
      requested = value;
    },
  });

  assert.deepEqual(controller.read(), {
    appliedReactDevelopmentMode: false,
    requestedReactDevelopmentMode: false,
  });
  assert.deepEqual(await controller.update({ reactDevelopmentMode: true }), {
    appliedReactDevelopmentMode: false,
    requestedReactDevelopmentMode: true,
  });
  assert.deepEqual(updates, [true]);
});

test("failed persistence propagates without advertising unapplied settings", async () => {
  const failure = new Error("Database write failed.");
  const controller = new WorkbenchAppSettingsController({
    readAppliedReactDevelopmentMode: () => false,
    readRequestedReactDevelopmentMode: () => false,
    writeRequestedReactDevelopmentMode: async () => {
      throw failure;
    },
  });

  await assert.rejects(controller.update({ reactDevelopmentMode: true }), error => error === failure);
  assert.equal(controller.read().requestedReactDevelopmentMode, false);
});
