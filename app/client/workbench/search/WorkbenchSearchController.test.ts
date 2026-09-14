/*
 * Keywords: search, single-flight, freshness, selection, failure, disposal.
 * No exports. Tests protect the client search lifecycle with controlled requests and scheduling.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchSearchController from "./WorkbenchSearchController";
import type { WorkbenchSearchResponse, WorkbenchSearchResult } from "workbench-shared/workbench/search/workbench-search";

const home: WorkbenchSearchResult = { actionId: "home", detail: "", id: "home", kind: "action", title: "Home" };
const settings: WorkbenchSearchResult = { actionId: "settings", detail: "", id: "settings", kind: "action", title: "Settings" };

function setup() {
  const scheduled = new Map<number, () => void>();
  let timerId = 0;
  const requests: Array<{
    query: string;
    projectId: string | null;
    resolve(response: WorkbenchSearchResponse): void;
    reject(error: Error): void;
  }> = [];
  const activated: string[] = [];
  const controller = new WorkbenchSearchController({
    activate: (result) => activated.push(`${controller.getSnapshot().isOpen}:${result.id}`),
    clearTimeout: (id) => { scheduled.delete(Number(id)); },
    request: (request) => new Promise<WorkbenchSearchResponse>((resolve, reject) => {
      requests.push({ ...request, resolve, reject });
    }),
    setTimeout: (callback) => { scheduled.set(++timerId, callback); return timerId; },
  });
  const runScheduled = () => {
    for (const [id, callback] of [...scheduled]) {
      scheduled.delete(id);
      callback();
    }
  };
  return { activated, controller, requests, runScheduled, scheduled };
}

test("a burst keeps one request active and runs only the latest desired query", async () => {
  const { controller, requests, runScheduled } = setup();
  controller.open();
  controller.setQuery("first");
  runScheduled();
  assert.equal(requests.length, 1);
  for (const query of ["second", "third", "asdlfkajsdlfkjasdlfkjasdf"]) {
    controller.setQuery(query);
    runScheduled();
    assert.equal(requests.length, 1);
  }
  requests[0].resolve({ results: [home] });
  await Promise.resolve();
  assert.deepEqual(controller.getSnapshot().results, []);
  runScheduled();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].query, "asdlfkajsdlfkjasdlfkjasdf");
  requests[1].resolve({ results: [] });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().isLoading, false);
  assert.deepEqual(controller.getSnapshot().results, []);
  controller.dispose();
});

test("editing retires visible rows immediately and prevents stale activation", async () => {
  const { activated, controller, requests, runScheduled } = setup();
  controller.open();
  runScheduled();
  requests[0].resolve({ results: [home, settings] });
  await Promise.resolve();
  controller.moveSelection(9);
  assert.equal(controller.getSnapshot().selectedIndex, 1);
  controller.setQuery("nothing");
  assert.equal(controller.getSnapshot().selectedIndex, 0);
  assert.equal(controller.getSnapshot().isLoading, true);
  assert.deepEqual(controller.getSnapshot().results, []);
  assert.equal(controller.activateSelected(), false);
  controller.activate(settings);
  assert.deepEqual(activated, []);
  assert.equal(controller.getSnapshot().isOpen, true);
  runScheduled();
  requests[1].resolve({ results: [home] });
  await Promise.resolve();
  assert.equal(controller.activateSelected(), true);
  assert.deepEqual(activated, ["false:home"]);
  controller.dispose();
});

test("project changes and close/reopen retain the active request until settlement", async () => {
  const { controller, requests, runScheduled } = setup();
  controller.open();
  runScheduled();
  controller.setProjectId("other");
  controller.close();
  controller.open();
  controller.setQuery("latest");
  runScheduled();
  assert.equal(requests.length, 1);
  requests[0].resolve({ results: [home] });
  await Promise.resolve();
  assert.deepEqual(controller.getSnapshot().results, []);
  runScheduled();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].projectId, "other");
  assert.equal(requests[1].query, "latest");
  requests[1].resolve({ results: [settings] });
  await Promise.resolve();
  assert.deepEqual(controller.getSnapshot().results, [settings]);
  controller.dispose();
});

test("failures release the active slot without losing newer intent or hiding current errors", async () => {
  const { controller, requests, runScheduled } = setup();
  controller.open();
  runScheduled();
  controller.setQuery("newer");
  requests[0].reject(new Error("obsolete query failed"));
  await Promise.resolve();
  assert.equal(controller.getSnapshot().error, null);
  runScheduled();
  assert.equal(requests.length, 2);
  requests[1].reject(new Error("current query failed"));
  await Promise.resolve();
  assert.equal(controller.getSnapshot().error, "current query failed");
  assert.equal(controller.getSnapshot().isLoading, false);
  controller.setQuery("retry");
  runScheduled();
  requests[2].resolve({ results: [home] });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().error, null);
  assert.deepEqual(controller.getSnapshot().results, [home]);
  controller.dispose();
});

test("close and disposal prevent late responses and queued requests from reviving the dialog", async () => {
  for (const dispose of [false, true]) {
    const { controller, requests, runScheduled, scheduled } = setup();
    controller.open();
    runScheduled();
    controller.setQuery("queued");
    if (dispose) controller.dispose();
    else controller.close();
    const retired = controller.getSnapshot();
    requests[0].resolve({ results: [home] });
    await Promise.resolve();
    runScheduled();
    assert.equal(requests.length, 1);
    assert.equal(scheduled.size, 0);
    assert.equal(controller.getSnapshot(), retired);
    controller.dispose();
  }
});
