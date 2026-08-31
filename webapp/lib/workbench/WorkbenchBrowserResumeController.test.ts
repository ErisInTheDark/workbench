/*
 * No production exports. Tests protect hidden-to-visible reconnect ownership, serialization, failure reporting, and disposal.
 */

import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchBrowserResumeController from "./WorkbenchBrowserResumeController.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function visibility(initiallyHidden = false) {
  let hidden = initiallyHidden;
  let listener = () => {};
  return {
    boundary: {
      hidden: () => hidden,
      subscribe: (nextListener: () => void) => {
        listener = nextListener;
        return () => { listener = () => {}; };
      },
    },
    setHidden(nextHidden: boolean) {
      hidden = nextHidden;
      listener();
    },
  };
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("only a hidden-to-visible transition requests a reconnect", async () => {
  const page = visibility();
  let reconnects = 0;
  const controller = new WorkbenchBrowserResumeController({
    reconnect: () => { reconnects += 1; },
    visibility: page.boundary,
  });
  controller.start();

  page.setHidden(false);
  assert.equal(reconnects, 0);
  page.setHidden(true);
  page.setHidden(false);
  await flushTasks();
  assert.equal(reconnects, 1);
  page.setHidden(false);
  assert.equal(reconnects, 1);

  controller.dispose();
  page.setHidden(true);
  page.setHidden(false);
  assert.equal(reconnects, 1);
});

test("resume requests serialize and failures remain recoverable", async () => {
  const page = visibility();
  const first = deferred();
  const failures: unknown[] = [];
  let reconnects = 0;
  const controller = new WorkbenchBrowserResumeController({
    onError: (error) => failures.push(error),
    reconnect: () => {
      reconnects += 1;
      if (reconnects === 1) return first.promise;
      if (reconnects === 2) throw new Error("replacement unavailable");
    },
    visibility: page.boundary,
  });
  controller.start();

  page.setHidden(true);
  page.setHidden(false);
  page.setHidden(true);
  page.setHidden(false);
  assert.equal(reconnects, 1);

  first.resolve();
  await flushTasks();
  assert.equal(reconnects, 2);
  assert.equal((failures[0] as Error).message, "replacement unavailable");

  page.setHidden(true);
  page.setHidden(false);
  await flushTasks();
  assert.equal(reconnects, 3);
  controller.dispose();
});
