/*
 * No production exports. Tests protect search-dialog debounce, freshness, selection, activation, and disposal. Keywords: search, controller, lifecycle, stale.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchSearchController from "./WorkbenchSearchController";
import type { WorkbenchSearchResponse } from "workbench-shared/workbench/search/workbench-search";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("typing resets selection and stale responses cannot replace the newest query", async () => {
  const requests: Array<ReturnType<typeof deferred<WorkbenchSearchResponse>>> = [];
  const scheduled: Array<() => void> = [];
  const controller = new WorkbenchSearchController({
    clearTimeout: () => undefined,
    request: () => {
      const request = deferred<WorkbenchSearchResponse>();
      requests.push(request);
      return request.promise;
    },
    setTimeout: (callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
  controller.open();
  controller.setQuery("first");
  scheduled.shift()?.();
  controller.setQuery("second");
  scheduled.shift()?.();
  assert.equal(requests.length, 2);

  requests[1].resolve({ results: [{ actionId: "home", detail: "Ctrl+H", id: "action:home", kind: "action", title: "Home" }] });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().results[0]?.title, "Home");
  controller.moveSelection(1);
  controller.setQuery("third");
  assert.equal(controller.getSnapshot().selectedIndex, 0);

  requests[0].resolve({ results: [{ actionId: "settings", detail: "Ctrl+O", id: "action:settings", kind: "action", title: "Settings" }] });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().results[0]?.title, "Home");
  controller.dispose();
});

test("selection clamps, activation closes first, and project changes refresh an open dialog", async () => {
  const activated: string[] = [];
  const scheduled: Array<() => void> = [];
  const controller = new WorkbenchSearchController({
    activate: (result) => activated.push(`${controller.getSnapshot().isOpen}:${result.id}`),
    clearTimeout: () => undefined,
    request: async () => ({
      results: [
        { actionId: "home", detail: "", id: "a", kind: "action" as const, title: "A" },
        { actionId: "settings", detail: "", id: "b", kind: "action" as const, title: "B" },
      ],
    }),
    setTimeout: (callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
  controller.open();
  scheduled.shift()?.();
  await Promise.resolve();
  controller.moveSelection(5);
  assert.equal(controller.getSnapshot().selectedIndex, 1);
  controller.activateSelected();
  assert.deepEqual(activated, ["false:b"]);

  controller.open();
  controller.setProjectId("project");
  assert.equal(scheduled.length, 1);
  controller.dispose();
});
