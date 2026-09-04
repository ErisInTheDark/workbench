/*
 * No production exports. Tests protect foreground/background stats loading and request freshness. Keywords: stats, lifecycle, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsLoadController from "./WorkbenchStatsLoadController.ts";

const request = { model: null, projectId: null, provider: null, range: "7d" as const };
const response = { version: 2 } as WorkbenchStatsResponse;

test("background refresh keeps visible stats and settles a superseded foreground load", async () => {
  const resolvers: Array<(value: WorkbenchStatsResponse) => void> = [];
  const controller = new WorkbenchStatsLoadController(async () => await new Promise((resolve) => resolvers.push(resolve)));
  const foreground = controller.load(request);
  assert.equal(controller.getSnapshot().loading, true);
  const background = controller.refresh(request);
  resolvers.shift()!(response);
  await foreground;
  assert.equal(controller.getSnapshot().loading, true);
  resolvers.shift()!(response);
  await background;
  assert.deepEqual(controller.getSnapshot(), { error: "", loading: false, stats: response });
});

test("background failures preserve the last visible response", async () => {
  let fails = false;
  const controller = new WorkbenchStatsLoadController(async () => {
    if (fails) throw new Error("broken");
    return response;
  });
  await controller.load(request);
  fails = true;
  await controller.refresh(request);
  assert.equal(controller.getSnapshot().stats, response);
  assert.equal(controller.getSnapshot().error, "broken");
  assert.equal(controller.getSnapshot().loading, false);
});
