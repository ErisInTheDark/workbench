/*
 * Keywords: archive, deadline, pin, fake scheduler, failure, disposal.
 * Exports: none. Protects record-derived expiry and the single wake lifecycle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchThreadArchiveController from "./WorkbenchThreadArchiveController";
import { parseWorkbenchThreadStateEntry, type WorkbenchThreadStateRecord } from "./workbench-thread-state-record";

function settled(pinned = false): WorkbenchThreadStateRecord {
  const entry = parseWorkbenchThreadStateEntry({
    entryKind: "thread", identity: { harness: "codex", threadId: "thread" }, activityAt: 1, title: "Thread",
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned, snoozed: false }, settledAt: 1,
  });
  assert.ok(entry.entryKind !== "draft");
  return entry;
}

test("expiry derives its next wake from current records and cancels it on pin or disposal", async () => {
  let now = 1;
  let record = settled();
  let wake: (() => Promise<void>) | null = null;
  let delay = 0;
  let expires = 0;
  const controller = new WorkbenchThreadArchiveController({
    now: () => now, records: () => [record],
    expire: async () => { expires++; record = settled(true); },
    onError: error => { throw error; },
    schedule: (callback, delayMs) => {
      wake = callback; delay = delayMs;
      return () => { wake = null; };
    },
  });
  controller.reschedule();
  assert.ok(wake);
  now += delay - 1;
  assert.equal(controller.isDue(record), false);
  now++;
  assert.equal(controller.isDue(record), true);
  record = settled(true);
  controller.reschedule();
  assert.equal(wake, null);
  assert.equal(controller.isDue(record), false);
  record = settled();
  controller.reschedule();
  assert.equal(delay, 0);
  const fire = wake as (() => Promise<void>) | null;
  assert.ok(fire);
  wake = null;
  await fire();
  assert.equal(expires, 1);
  assert.equal(wake, null);
  record = settled();
  controller.reschedule();
  await controller.dispose();
  assert.equal(wake, null);
  controller.reschedule();
  assert.equal(wake, null);
});

test("expiry reports failures without retrying an unchanged overdue record", async () => {
  for (const synchronous of [false, true]) {
    let wake: (() => Promise<void>) | null = null;
    const failures: unknown[] = [];
    const failure = new Error("storage failed");
    const controller = new WorkbenchThreadArchiveController({
      now: () => Number.MAX_SAFE_INTEGER, records: () => [settled()],
      expire: () => { if (synchronous) throw failure; return Promise.reject(failure); },
      onError: error => { failures.push(error); },
      schedule: callback => { wake = callback; return () => { wake = null; }; },
    });
    controller.reschedule();
    const fire = wake as (() => Promise<void>) | null;
    assert.ok(fire);
    wake = null;
    await fire();
    assert.deepEqual(failures, [failure]);
    assert.equal(wake, null);
    await controller.dispose();
  }
});

test("archival follows activity rather than settlement and reschedules for newer activity", async () => {
  const age = 14 * 24 * 60 * 60 * 1_000;
  const now = age + 100;
  let record = { ...settled(), activityAt: 100, settledAt: now };
  let delay = -1;
  const controller = new WorkbenchThreadArchiveController({
    now: () => now, records: () => [record], expire: async () => {},
    onError: error => { throw error; },
    schedule: (_callback, delayMs) => { delay = delayMs; return () => {}; },
  });
  try {
    assert.equal(controller.isDue(record), true);
    assert.equal(controller.isDue({ ...record, settledAt: null }), true);
    controller.reschedule();
    assert.equal(delay, 0);
    record = { ...record, activityAt: now, settledAt: 1 };
    assert.equal(controller.isDue(record), false);
    controller.reschedule();
    assert.equal(delay, age);
  } finally { await controller.dispose(); }
});
