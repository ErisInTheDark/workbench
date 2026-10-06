/* Exports: none. Protect FIFO admission, successful rollover release, failed holds, and drain. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";

test("messages queued after a hold release in FIFO order", async () => {
  const owner = new WorkbenchThreadAdmissionController();
  const hold = owner.hold("thread");
  const calls: string[] = [];
  const first = owner.run("thread", async () => { calls.push("first"); return 1; });
  const second = owner.run("thread", async () => { calls.push("second"); return 2; });
  await Promise.resolve();
  assert.deepEqual(calls, []);
  hold.release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(calls, ["first", "second"]);
  await owner.dispose();
});

test("failed holds reject every already-queued admission without poisoning later input", async () => {
  const owner = new WorkbenchThreadAdmissionController();
  const hold = owner.hold("thread");
  const calls: string[] = [];
  const first = owner.run("thread", async () => { calls.push("first"); });
  const second = owner.run("thread", async () => { calls.push("second"); });
  hold.fail(new Error("rollover failed"));
  await assert.rejects(first, /rollover failed/u);
  await assert.rejects(second, /rollover failed/u);
  await owner.run("thread", async () => { calls.push("later"); });
  assert.deepEqual(calls, ["later"]);
  await owner.dispose();
});

test("one thread hold does not block another thread", async () => {
  const owner = new WorkbenchThreadAdmissionController();
  owner.hold("held");
  assert.equal(await owner.run("free", async () => "admitted"), "admitted");
  owner.beginRuntimeDrain();
  await owner.dispose();
});
