/*
 * Keywords: generic item, sleep, countdown, lifecycle, test.
 * No production exports. Protect payload matching and timestamp-derived presentation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getSleepDisplay, matchSleepItem } from "./sleep";

const active = {
  durationMs: 60_000,
  startedAt: 10_000,
  completedAt: null,
  turnStatus: "inProgress" as const,
  nowMs: 33_100,
};

test("sleep matching accepts presentation data while declining unrelated or malformed payloads", () => {
  assert.deepEqual(matchSleepItem({
    nativeType: "sleep", safeValue: { type: "sleep", durationMs: 60_000, extra: true },
  }), { kind: "sleep", durationMs: 60_000 });
  for (const safeValue of [null, [], {}, { durationMs: -1 }, { durationMs: "60000" }, { durationMs: Infinity }]) {
    assert.equal(matchSleepItem({ nativeType: "sleep", safeValue }), null);
  }
  assert.equal(matchSleepItem({ nativeType: "futureItem", safeValue: { durationMs: 60_000 } }), null);
  assert.deepEqual(matchSleepItem({ nativeType: "sleep", safeValue: { durationMs: 0 } }), {
    kind: "sleep", durationMs: 0,
  });
});

test("remaining time derives from the recorded start, including a fresh render after time passes", () => {
  assert.deepEqual(getSleepDisplay(active), { seconds: 37, completed: false, ticking: true });
  assert.equal(getSleepDisplay({ ...active, nowMs: 48_500 }).seconds, 22);
  assert.equal(getSleepDisplay({ ...active, nowMs: 1_000 }).seconds, 60);
});

test("countdown exhaustion does not invent completion or negative remaining time", () => {
  assert.deepEqual(getSleepDisplay({ ...active, nowMs: 80_000 }), {
    seconds: 0, completed: false, ticking: false,
  });
  assert.deepEqual(getSleepDisplay({ ...active, durationMs: 0 }), {
    seconds: 0, completed: false, ticking: false,
  });
});

test("item or turn completion restores requested duration, including an early wake", () => {
  assert.deepEqual(getSleepDisplay({ ...active, completedAt: 20_000 }), {
    seconds: 60, completed: true, ticking: false,
  });
  for (const turnStatus of ["completed", "interrupted", "failed"] as const) {
    assert.deepEqual(getSleepDisplay({ ...active, turnStatus }), {
      seconds: 60, completed: true, ticking: false,
    });
  }
});

test("missing start timing does not invent elapsed time or a running display clock", () => {
  assert.deepEqual(getSleepDisplay({ ...active, startedAt: null }), {
    seconds: 60, completed: false, ticking: false,
  });
});
