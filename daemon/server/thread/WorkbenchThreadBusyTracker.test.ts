/*
 * No exports. Thread busy tests protect which thread states hold the busy reason and seed-versus-event ordering.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchThreadBusyTracker from "./WorkbenchThreadBusyTracker";

function fixture(seed: readonly string[] | Promise<readonly string[]> = []) {
  const held: Array<string | null> = [];
  let emit!: (threadId: string, working: boolean) => void;
  const tracker = new WorkbenchThreadBusyTracker({
    readWorkingThreadIds: async () => await seed,
    subscribe: listener => { emit = listener; return () => { emit = () => {}; }; },
    hold: reason => { held.push(reason); },
    warn: () => {},
  });
  return { tracker, held, emit: (threadId: string, working: boolean) => emit(threadId, working) };
}

test("seeded working threads hold until every one leaves working", async () => {
  const f = fixture(["a", "b"]);
  await f.tracker.start();
  assert.equal(f.held.at(-1), "2 threads working");
  // Questionnaires, completion and stop all leave the working lifecycle.
  f.emit("a", false);
  assert.equal(f.held.at(-1), "1 thread working");
  f.emit("b", false);
  assert.equal(f.held.at(-1), null);
});

test("compacting a non-working thread holds on its own", async () => {
  const f = fixture();
  await f.tracker.start();
  assert.equal(f.held.at(-1), null);
  f.tracker.setCompacting("a", true);
  assert.equal(f.held.at(-1), "1 thread compacting");
  f.emit("b", true);
  assert.equal(f.held.at(-1), "1 thread working, 1 thread compacting");
  f.tracker.setCompacting("a", false);
  f.emit("b", false);
  assert.equal(f.held.at(-1), null);
});

test("a lifecycle change during the seed read wins over the stale seed", async () => {
  const seed = Promise.withResolvers<readonly string[]>();
  const f = fixture(seed.promise);
  const started = f.tracker.start();
  f.emit("a", false);
  seed.resolve(["a"]);
  await started;
  assert.equal(f.held.at(-1), null);
});

test("a disposed generation leaves its reason for the next one to replace", async () => {
  const f = fixture(["a"]);
  await f.tracker.start();
  f.tracker.dispose();
  f.emit("a", false);
  f.tracker.setCompacting("a", true);
  assert.deepEqual(f.held, ["1 thread working"]);
});
