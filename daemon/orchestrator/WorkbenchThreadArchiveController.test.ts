/*
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("expiry derives its next wake from current records and cancels it on pin or disposal", async () => {
  let now = 1;
  let record = settled();
  let wake: (() => Promise<void>) | null = null;
  let delay = 0;
  let expires = 0;
  let scheduled = deferred<void>();
  const controller = new WorkbenchThreadArchiveController({
    now: () => now, readNextActivity: async () => record.entryKind === "thread" && !record.metadata.pinned ? record.activityAt : null,
    expire: async () => { expires++; record = settled(true); },
    onError: error => { throw error; },
    schedule: (callback, delayMs) => {
      wake = callback; delay = delayMs;
      scheduled.resolve();
      return () => { wake = null; };
    },
  });
  controller.reschedule();
  await scheduled.promise;
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
  scheduled = deferred<void>();
  controller.reschedule();
  await scheduled.promise;
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
    const scheduled = deferred<void>();
    const controller = new WorkbenchThreadArchiveController({
      now: () => Number.MAX_SAFE_INTEGER, readNextActivity: async () => 1,
      expire: () => { if (synchronous) throw failure; return Promise.reject(failure); },
      onError: error => { failures.push(error); },
      schedule: callback => { wake = callback; scheduled.resolve(); return () => { wake = null; }; },
    });
    controller.reschedule();
    await scheduled.promise;
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
  let scheduled = deferred<void>();
  const controller = new WorkbenchThreadArchiveController({
    now: () => now, readNextActivity: async () => record.activityAt, expire: async () => {},
    onError: error => { throw error; },
    schedule: (_callback, delayMs) => { delay = delayMs; scheduled.resolve(); return () => {}; },
  });
  try {
    assert.equal(controller.isDue(record), true);
    assert.equal(controller.isDue({ ...record, settledAt: null }), true);
    controller.reschedule();
    await scheduled.promise;
    assert.equal(delay, 0);
    record = { ...record, activityAt: now, settledAt: 1 };
    assert.equal(controller.isDue(record), false);
    scheduled = deferred<void>();
    controller.reschedule();
    await scheduled.promise;
    assert.equal(delay, age);
  } finally { await controller.dispose(); }
});

test("a superseded deadline cannot install a wake and disposal drains its read", async () => {
  const first = deferred<number | null>();
  const entered = deferred<void>();
  const scheduled = deferred<void>();
  let reads = 0;
  let delay = -1;
  let cancelled = false;
  const age = 14 * 24 * 60 * 60 * 1_000;
  const controller = new WorkbenchThreadArchiveController({
    now: () => age, expire: async () => {},
    readNextActivity: () => {
      reads++;
      if (reads === 1) { entered.resolve(); return first.promise; }
      return Promise.resolve(100);
    },
    onError: error => { throw error; },
    schedule: (_callback, delayMs) => {
      delay = delayMs;
      scheduled.resolve();
      return () => { cancelled = true; };
    },
  });
  controller.reschedule();
  await entered.promise;
  controller.reschedule();
  first.resolve(0);
  await scheduled.promise;
  assert.equal(delay, 100);
  assert.equal(reads, 2);
  await controller.dispose();
  assert.equal(cancelled, true);

  const held = deferred<number | null>();
  const admitted = deferred<void>();
  const draining = new WorkbenchThreadArchiveController({
    now: () => age, expire: async () => {},
    readNextActivity: () => { admitted.resolve(); return held.promise; },
    onError: error => { throw error; },
    schedule: () => { assert.fail("disposed query installed a wake"); },
  });
  draining.reschedule();
  await admitted.promise;
  let disposed = false;
  const disposal = draining.dispose().then(() => { disposed = true; });
  assert.equal(disposed, false);
  held.resolve(0);
  await disposal;
  assert.equal(disposed, true);
});
