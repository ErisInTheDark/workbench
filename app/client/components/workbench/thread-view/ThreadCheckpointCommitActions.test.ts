/* No production exports. Regression wards cover ordered commit-all, failure stops, readiness gating, and unmounted cards. */

import assert from "node:assert/strict";
import test from "node:test";

import ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(next => { resolve = next; });
  return { promise, resolve };
}

test("commit all waits for each proposal before starting the next", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const first = deferred();
  const started: string[] = [];
  actions.register("one", { commit: () => { started.push("one"); return first.promise; }, ready: true });
  actions.register("two", { commit: async () => { started.push("two"); return true; }, ready: true });

  const run = actions.commitAll(["one", "two"]);
  await Promise.resolve();
  assert.deepEqual(started, ["one"]);
  first.resolve(true);
  assert.equal(await run, true);
  assert.deepEqual(started, ["one", "two"]);
});

test("commit all stops at the first failed proposal", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const started: string[] = [];
  actions.register("one", { commit: async () => { started.push("one"); return false; }, ready: true });
  actions.register("two", { commit: async () => { started.push("two"); return true; }, ready: true });

  assert.equal(await actions.commitAll(["one", "two"]), false);
  assert.deepEqual(started, ["one"]);
});

test("commit all starts only when every proposal is ready", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const started: string[] = [];
  actions.register("one", { commit: async () => { started.push("one"); return true; }, ready: true });
  actions.register("two", { commit: async () => { started.push("two"); return true; }, ready: false });

  assert.equal(actions.isReady(["one", "two"]), false);
  assert.equal(await actions.commitAll(["one", "two"]), false);
  assert.deepEqual(started, []);
});

test("commit all stops when a later proposal unmounts mid-run", async () => {
  const actions = new ThreadCheckpointCommitActions();
  const started: string[] = [];
  let unregisterTwo = () => {};
  actions.register("one", {
    commit: async () => { started.push("one"); unregisterTwo(); return true; },
    ready: true,
  });
  unregisterTwo = actions.register("two", { commit: async () => { started.push("two"); return true; }, ready: true });

  assert.equal(await actions.commitAll(["one", "two"]), false);
  assert.deepEqual(started, ["one"]);
});

test("a replaced registration survives the stale cleanup", () => {
  const actions = new ThreadCheckpointCommitActions();
  const stale = actions.register("one", { commit: async () => true, ready: false });
  actions.register("one", { commit: async () => true, ready: true });
  stale();
  assert.equal(actions.isReady(["one"]), true);
});
