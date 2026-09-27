/* No production exports. Protect initial app-source recovery and disposal without real timers. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppSourcesController from "./WorkbenchAppSourcesController";

async function flush() {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

test("failed initial reads recover independently and stop scheduling once both sources exist", async () => {
  let networkReady = false;
  let presentationReady = false;
  let networkReads = 0;
  let presentationReads = 0;
  const scheduled: Array<() => void> = [];
  const controller = new WorkbenchAppSourcesController({
    network: {
      snapshot: () => ({ snapshot: networkReady ? {} : null }),
      start: async () => { networkReads++; if (networkReads > 1) networkReady = true; },
    },
    presentation: {
      snapshot: () => ({ data: presentationReady ? {} : null }),
      refresh: async () => {
        presentationReads++;
        if (presentationReads > 2) presentationReady = true;
        else throw new Error("presentation unavailable");
        return {};
      },
    },
    schedule: callback => { scheduled.push(callback); return scheduled.length; },
    cancel: () => {},
  });
  controller.start();
  await flush();
  assert.equal(networkReads, 1);
  assert.equal(presentationReads, 1);
  assert.equal(scheduled.length, 1);
  scheduled.shift()!();
  await flush();
  assert.equal(networkReads, 2);
  assert.equal(presentationReads, 2);
  scheduled.shift()!();
  await flush();
  assert.equal(networkReads, 2);
  assert.equal(presentationReads, 3);
  assert.equal(scheduled.length, 0);
  controller.dispose();
});

test("disposal cancels a pending source retry", async () => {
  let cancelled = false;
  let reads = 0;
  const controller = new WorkbenchAppSourcesController({
    network: {
      snapshot: () => ({ snapshot: null }),
      start: async () => { reads++; },
    },
    presentation: {
      snapshot: () => ({ data: null }),
      refresh: async () => { throw new Error("unavailable"); },
    },
    schedule: () => 1,
    cancel: () => { cancelled = true; },
  });
  controller.start();
  await flush();
  controller.dispose();
  assert.equal(cancelled, true);
  assert.equal(reads, 1);
});

test("a read settling after disposal cannot schedule another attempt", async () => {
  const pending = Promise.withResolvers<void>();
  let scheduled = 0;
  const controller = new WorkbenchAppSourcesController({
    network: {
      snapshot: () => ({ snapshot: null }),
      start: async () => await pending.promise,
    },
    presentation: {
      snapshot: () => ({ data: {} }),
      refresh: async () => ({}),
    },
    schedule: () => { scheduled++; return 1; },
  });
  controller.start();
  controller.dispose();
  pending.resolve();
  await flush();
  assert.equal(scheduled, 0);
});
