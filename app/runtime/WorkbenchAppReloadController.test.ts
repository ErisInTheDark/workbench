/*
 * No production exports. Tests protect response-first scheduling and process-scope rejection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchAppReloadController from "./WorkbenchAppReloadController.ts";

test("admits before scheduling execution and rejects stable process replacement", async () => {
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
  const response = controller.admit(["client:http"]);
  assert.equal(response.state, "running");
  assert.deepEqual(events, ["begin:client:http"]);
  scheduled.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["begin:client:http", "execute:client:http", "complete:client:http"]);
  assert.throws(() => controller.admit(["client:process"]), /full Workbench app restart/u);
});
