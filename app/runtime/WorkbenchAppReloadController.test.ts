/*
 * No production exports. Tests protect response-first reload and native process-restart admission.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchAppReloadController from "./WorkbenchAppReloadController.ts";

test("starts an ordinary reload only after its admission is acknowledged", async () => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];
  const dirt = {
    beginReload: (scopes: readonly string[]) => events.push(`begin:${scopes.join(",")}`),
    completeReload: (scopes: readonly string[]) => events.push(`complete:${scopes.join(",")}`),
    failReload: () => events.push("fail"),
  };
  const controller = new WorkbenchAppReloadController({
    dirt: dirt as never,
    execute: async (scopes) => { events.push(`execute:${scopes.join(",")}`); return scopes; },
    now: () => 10,
    processScope: "client:process",
    schedule: (callback) => scheduled.push(callback),
  });
  const admission = controller.admit(["client:http"]);
  assert.equal(admission.response.state, "running");
  assert.equal(events.length, 0);
  const completion = admission.start();
  assert.equal(events.length, 0);
  scheduled.shift()?.();
  await completion;
  assert.deepEqual(events, ["begin:client:http", "execute:client:http", "complete:client:http"]);
});

test("keeps process restart exclusive and cancellable before acknowledgement", async () => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];
  const controller = new WorkbenchAppReloadController({
    dirt: {
      beginReload: () => { throw new Error("process restart must not mutate the outgoing dirt owner"); },
    } as never,
    execute: async () => { throw new Error("process restart must not enter the node reload graph"); },
    now: () => 20,
    processScope: "client:process",
    schedule: (callback) => scheduled.push(callback),
  });
  assert.throws(
    () => controller.admit(["client:process", "client:http"], () => {}),
    /must be requested by itself/u,
  );
  assert.throws(
    () => controller.admit(["client:process"]),
    /desktop tray/u,
  );

  const cancelled = controller.admit(["client:process"], () => {
    events.push("restart");
  });
  cancelled.cancel();
  await assert.rejects(cancelled.start(), /no longer active/u);
  assert.equal(events.length, 0);

  const admission = controller.admit(["client:process"], () => {
    events.push("restart");
  });
  assert.deepEqual(admission.response, {
    appliedScopes: [],
    completedAt: 20,
    error: null,
    ok: true,
    queuedScopes: ["client:process"],
    requestedScopes: ["client:process"],
    startedAt: 20,
    state: "succeeded",
  });
  const completion = admission.start();
  assert.equal(events.length, 0);
  scheduled.shift()?.();
  await completion;
  assert.deepEqual(events, ["restart"]);
});
