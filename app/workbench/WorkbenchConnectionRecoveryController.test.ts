/*
 * No production exports. Tests protect browser resume detection, continuity priority, recovery serialization, failure reporting, and disposal.
 */

import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchConnectionRecoveryController, {
  type WorkbenchConnectionContinuity,
} from "./WorkbenchConnectionRecoveryController.ts";

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
  await Promise.resolve();
}

test("only a hidden-to-visible transition requests preserved-continuity recovery", async () => {
  const page = visibility();
  const recoveries: WorkbenchConnectionContinuity[] = [];
  const controller = new WorkbenchConnectionRecoveryController({
    recover: (continuity) => { recoveries.push(continuity); },
    visibility: page.boundary,
  });
  controller.start();

  page.setHidden(false);
  assert.deepEqual(recoveries, []);
  page.setHidden(true);
  page.setHidden(false);
  await flushTasks();
  assert.deepEqual(recoveries, ["preserved"]);
  page.setHidden(false);
  assert.deepEqual(recoveries, ["preserved"]);

  controller.dispose();
  page.setHidden(true);
  page.setHidden(false);
  assert.deepEqual(recoveries, ["preserved"]);
});

test("recovery requests serialize and connection loss dominates queued browser resumes", async () => {
  const page = visibility();
  const first = deferred();
  const lost = deferred();
  const failures: Array<{ continuity: WorkbenchConnectionContinuity; error: unknown }> = [];
  const recoveries: WorkbenchConnectionContinuity[] = [];
  const controller = new WorkbenchConnectionRecoveryController({
    onError: (continuity, error) => failures.push({ continuity, error }),
    recover: (continuity) => {
      recoveries.push(continuity);
      if (recoveries.length === 1) return first.promise;
      if (continuity === "lost") return lost.promise;
      if (recoveries.length === 3) throw new Error("refresh unavailable");
    },
    visibility: page.boundary,
  });
  controller.start();

  page.setHidden(true);
  page.setHidden(false);
  page.setHidden(true);
  page.setHidden(false);
  controller.recoverAfterConnectionLoss();
  page.setHidden(true);
  page.setHidden(false);
  assert.deepEqual(recoveries, ["preserved"]);

  first.resolve();
  await flushTasks();
  assert.deepEqual(recoveries, ["preserved", "lost"]);
  page.setHidden(true);
  page.setHidden(false);
  assert.deepEqual(recoveries, ["preserved", "lost"]);

  lost.resolve();
  await flushTasks();
  assert.deepEqual(recoveries, ["preserved", "lost"]);

  page.setHidden(true);
  page.setHidden(false);
  await flushTasks();
  assert.deepEqual(recoveries, ["preserved", "lost", "preserved"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.continuity, "preserved");
  assert.equal((failures[0]?.error as Error).message, "refresh unavailable");

  page.setHidden(true);
  page.setHidden(false);
  await flushTasks();
  assert.deepEqual(recoveries, ["preserved", "lost", "preserved", "preserved"]);
  controller.dispose();
});
