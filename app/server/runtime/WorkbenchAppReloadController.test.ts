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

test("a resumed reload owner reports failed replacement and accepts another batch", async () => {
  const events: string[] = [];
  let attempts = 0;
  const controller = new WorkbenchAppReloadController({
    dirt: {
      beginReload: () => events.push("begin"),
      completeReload: () => events.push("complete"),
      failReload: () => events.push("fail"),
    } as never,
    execute: async (scopes) => {
      if (++attempts === 1) {
        controller.detachForReload();
        controller.resumeAfterFailedReload();
        throw new Error("candidate rejected");
      }
      return scopes;
    },
    schedule: (callback) => callback(),
  });
  await assert.rejects(controller.admit(["client:http"]).start(), /candidate rejected/u);
  await controller.admit(["client:http"]).start();
  assert.deepEqual(events, ["begin", "fail", "begin", "complete"]);
});

test("install admission requires the tray and persists before stopping and restarting", async () => {
  const events: string[] = [];
  const controller = new WorkbenchAppReloadController({
    dirt: {} as never, execute: async () => [],
    repositoryRootPath: "/repo",
    prepareInstall: async fromSha => { events.push(`journal:${fromSha}`); },
    repairInstall: async () => { events.push("stop"); },
    schedule: callback => callback(),
  });
  assert.throws(() => controller.admit(["client:install"]), /desktop tray/u);
  assert.throws(() => controller.admit(["client:install", "client:http"], () => {}), /by itself/u);
  const admission = controller.admit(["client:install"], () => { events.push("restart"); }, { installFromSha: "a".repeat(40) });
  assert.deepEqual(events, []);
  await admission.start();
  assert.deepEqual(events, [`journal:${"a".repeat(40)}`, "stop", "restart"]);
});

test("failed install preparation or host stop never requests native restart", async () => {
  for (const fails of ["prepare", "stop"]) {
    let restarted = false;
    const controller = new WorkbenchAppReloadController({
      dirt: {} as never, execute: async () => [], repositoryRootPath: "/repo",
      prepareInstall: async () => { if (fails === "prepare") throw new Error("journal failed"); },
      repairInstall: async () => { if (fails === "stop") throw new Error("host failed"); },
      schedule: callback => callback(),
    });
    await assert.rejects(controller.admit(["client:install"], () => { restarted = true; }).start(), /failed/u);
    assert.equal(restarted, false);
  }
});

test("install owns reload admission until asynchronous host stop completes", async () => {
  let release!: () => void;
  let stopping!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { stopping = resolve; });
  const controller = new WorkbenchAppReloadController({
    dirt: {} as never, execute: async () => [], repositoryRootPath: "/repo",
    prepareInstall: async () => {},
    repairInstall: async () => { stopping(); await stopped; },
    schedule: callback => callback(),
  });
  const completion = controller.admit(["client:install"], () => {}).start();
  await entered;
  assert.throws(() => controller.admit(["client:http"]), /already active/u);
  release();
  await completion;
});
