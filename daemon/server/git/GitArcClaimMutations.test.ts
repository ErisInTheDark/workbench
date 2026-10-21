/* No production exports. Wards that claim waits retry only after a claim mutation, never miss one that races an attempt, and stop on abort. */
import assert from "node:assert/strict";
import test from "node:test";

import GitArcClaimMutations from "./GitArcClaimMutations.ts";

type Attempt = { kind: "blocked" } | { kind: "done"; attempts: number };

function attempts(results: Array<(count: number) => Attempt>) {
  let count = 0;
  let notifyAttempted: () => void = () => undefined;
  let attempted = new Promise<void>(resolve => { notifyAttempted = resolve; });
  return {
    get count() { return count; },
    nextAttempt: () => attempted,
    run: async (): Promise<Attempt> => {
      count += 1;
      const result = results[Math.min(count, results.length) - 1]!(count);
      const finished = notifyAttempted;
      attempted = new Promise<void>(resolve => { notifyAttempted = resolve; });
      finished();
      return result;
    },
  };
}

test("a blocked attempt waits for the next claim mutation before retrying", async () => {
  const mutations = new GitArcClaimMutations();
  const sequence = attempts([() => ({ kind: "blocked" }), count => ({ attempts: count, kind: "done" })]);
  const firstAttempt = sequence.nextAttempt();
  const waiting = mutations.waitUntil(sequence.run, new AbortController().signal);
  await firstAttempt;
  await Promise.resolve();
  assert.equal(sequence.count, 1, "no retry without a mutation");
  mutations.notify();
  assert.deepEqual(await waiting, { attempts: 2, kind: "done" });
});

test("a mutation that lands during a blocked attempt retries immediately", async () => {
  const mutations = new GitArcClaimMutations();
  const sequence = attempts([() => {
    mutations.notify();
    return { kind: "blocked" };
  }, count => ({ attempts: count, kind: "done" })]);
  assert.deepEqual(await mutations.waitUntil(sequence.run, new AbortController().signal), { attempts: 2, kind: "done" });
});

test("aborting a waiting caller rejects with the abort reason", async () => {
  const mutations = new GitArcClaimMutations();
  const controller = new AbortController();
  const sequence = attempts([() => ({ kind: "blocked" })]);
  const firstAttempt = sequence.nextAttempt();
  const waiting = mutations.waitUntil(sequence.run, controller.signal);
  await firstAttempt;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(waiting, /caller cancelled/u);
  assert.equal(sequence.count, 1);
});
