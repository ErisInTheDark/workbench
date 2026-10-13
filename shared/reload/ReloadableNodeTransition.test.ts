/*
 * No exports. Controlled deadlines prove force-drain and phase fencing without wall-clock timers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ReloadableNodeTransition from "./ReloadableNodeTransition";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("failed lifecycle steps log phase and nested cause without changing the thrown error", async () => {
  const logs: string[] = [];
  const deadline = signal();
  const transition = new ReloadableNodeTransition(
    { cancel() {}, expired: deadline.promise }, 30_000, () => "", message => logs.push(message),
  );
  const failure = new Error("service failed", { cause: new Error("spawn denied") });
  try {
    await assert.rejects(transition.step("harness:fixture: resume", () => { throw failure; }), error => error === failure);
    assert.equal(logs.length, 1);
    for (const detail of ["harness:fixture", "resume", "service failed", "spawn denied"]) {
      assert.ok(logs[0]!.includes(detail));
    }
  } finally { transition.finish(); }
});

test("one grace budget forces every remaining wait without cancelling the transition", async () => {
  const deadline = signal();
  const pending = signal();
  const entered = signal();
  const forced: string[] = [];
  const transition = new ReloadableNodeTransition(
    { cancel: () => undefined, expired: deadline.promise }, 30_000, () => "pending read", () => undefined,
  );
  const first = transition.drain("first drain", async () => { entered.resolve(); await pending.promise; }, () => { forced.push("first"); });
  await entered.promise;
  deadline.resolve();
  await first;
  await transition.drain("second drain", async () => { assert.fail("an expired grace must not start another wait"); }, () => { forced.push("second"); });
  assert.deepEqual(forced, ["first", "second"]);
  assert.equal(await transition.step("candidate", () => "ready"), "ready");
  pending.resolve();
  transition.finish();
});

test("failed diagnostics cannot prevent forced retirement", async () => {
  const deadline = signal();
  const pending = signal();
  let forced = false;
  const transition = new ReloadableNodeTransition(
    { cancel: () => undefined, expired: deadline.promise }, 30_000,
    () => { throw new Error("diagnostic owner failed"); }, () => undefined,
  );
  const draining = transition.drain("drain", () => pending.promise, () => { forced = true; });
  deadline.resolve();
  await draining;
  assert.equal(forced, true);
  pending.resolve();
  transition.finish();
});

test("a finished phase reporter cannot replace the current blocked operation", async () => {
  const deadline = signal();
  const pending = signal();
  const logs: string[] = [];
  let retiredReport!: (phase: string) => void;
  const transition = new ReloadableNodeTransition(
    { cancel: () => undefined, expired: deadline.promise }, 30_000, () => "", (message) => { logs.push(message); },
  );
  await transition.step("previous", (report) => { retiredReport = report; });
  const starting = transition.step("current", async (report) => {
    report("database readiness");
    retiredReport("retired dependency");
    await pending.promise;
  });
  deadline.resolve();
  await deadline.promise;
  assert.ok(logs.some((message) => message.includes("database readiness")));
  assert.ok(logs.every((message) => !message.includes("retired dependency")));
  pending.resolve();
  await starting;
  transition.finish();
});
