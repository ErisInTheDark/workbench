/*
 * No production exports. Tests protect foreground/background stats loading and request freshness. Keywords: stats, lifecycle, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsLoadController from "./WorkbenchStatsLoadController.ts";

const request = { model: null, projectId: null, provider: null, range: "7d" as const };
const response = { version: 2 } as WorkbenchStatsResponse;

test("queued filters replace obsolete selections and import refresh cannot restore an older filter", async () => {
  const calls: string[] = [];
  let finishOld: ((value: WorkbenchStatsResponse) => void) | undefined;
  let finishNew: ((value: WorkbenchStatsResponse) => void) | undefined;
  let reachedNew: (() => void) | undefined;
  const newRead = new Promise<void>((resolve) => { reachedNew = resolve; });
  const controller = new WorkbenchStatsLoadController(async (query) => {
    calls.push(query.range);
    return await new Promise((resolve) => {
      if (query.range === "7d") finishOld = resolve;
      else { finishNew = resolve; reachedNew!(); }
    });
  });
  const first = controller.load(request);
  await Promise.resolve();
  const skipped = controller.load({ ...request, range: "30d" });
  const latest = controller.load({ ...request, range: "90d" });
  const refresh = controller.refresh(request);
  finishOld!(response);
  await newRead;
  assert.equal(controller.getSnapshot().stats, null);
  finishNew!(response);
  await Promise.all([first, skipped, latest, refresh]);
  assert.deepEqual(calls, ["7d", "90d"]);
  assert.equal(controller.getSnapshot().displayedRequest?.range, "90d");
  assert.equal(controller.getSnapshot().loading, false);
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

test("filter changes and failed foreground reads keep the last successful statistics", async () => {
  let rejectRead: ((error: Error) => void) | undefined;
  const controller = new WorkbenchStatsLoadController(async (query) => {
    if (query.range === "7d") return response;
    return await new Promise((_resolve, reject) => { rejectRead = reject; });
  });
  await controller.load(request);
  const changing = controller.load({ ...request, range: "30d" });
  const retainedWhileLoading = controller.getSnapshot().stats;
  await Promise.resolve();
  rejectRead!(new Error("read failed"));
  await changing;
  assert.equal(retainedWhileLoading, response);
  assert.equal(controller.getSnapshot().stats, response);
  assert.equal(controller.getSnapshot().error, "read failed");
});

test("a refresh queued after result publication is not stranded by flight cleanup", async () => {
  let calls = 0;
  let refresh: Promise<void> | undefined;
  const controller = new WorkbenchStatsLoadController(async () => { calls += 1; return response; });
  controller.subscribe(() => {
    if (calls === 1 && !controller.getSnapshot().loading) {
      queueMicrotask(() => { refresh = controller.refresh(); });
    }
  });
  await controller.load(request);
  await refresh;
  assert.equal(calls, 2);
  assert.equal(controller.getSnapshot().loading, false);
});

test("disposal fences late reads and drops queued work", async () => {
  let finish!: (value: WorkbenchStatsResponse) => void;
  let calls = 0;
  const controller = new WorkbenchStatsLoadController(() => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  const loading = controller.load(request);
  await Promise.resolve();
  void controller.load({ ...request, range: "30d" });
  controller.dispose();
  finish(response);
  await loading;
  assert.equal(controller.getSnapshot().stats, null);
  await controller.refresh();
  assert.equal(calls, 1);
});
