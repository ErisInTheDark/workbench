/* No production exports. Protect even rationing of what is left now across the time left until reset. */
import assert from "node:assert/strict";
import test from "node:test";

import { rationThresholds } from "./stats-ration";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

test("what is left now is split across the time left, with the partial current step getting its share", () => {
  // 50% left with 3h20m to go: at 3h, 2h and 1h before the reset, 45%, 30% and 15% should remain.
  const thresholds = rationThresholds({ durationMinutes: 300, leftPercent: 50, resetsAt: 3 * hour + 20 * minute }, 0);
  assert.deepEqual(thresholds.map((value) => Math.round(value * 10) / 10), [45, 30, 15]);
});

test("weekly windows step by day and monthly windows by 7.5 days, counted back from the reset", () => {
  assert.deepEqual(
    rationThresholds({ durationMinutes: 7 * 24 * 60, leftPercent: 70, resetsAt: 3.5 * day }, 0).map(Math.round),
    [60, 40, 20],
  );
  assert.deepEqual(rationThresholds({ durationMinutes: 30 * 24 * 60, leftPercent: 100, resetsAt: 30 * day }, 0), [75, 50, 25]);
});

test("nothing is marked without a duration, a reset ahead, or anything left", () => {
  assert.deepEqual(rationThresholds({ durationMinutes: null, leftPercent: 50, resetsAt: hour }, 0), []);
  assert.deepEqual(rationThresholds({ durationMinutes: 300, leftPercent: 50, resetsAt: null }, 0), []);
  assert.deepEqual(rationThresholds({ durationMinutes: 300, leftPercent: 50, resetsAt: 0 }, 0), []);
  assert.deepEqual(rationThresholds({ durationMinutes: 300, leftPercent: 0, resetsAt: 3 * hour }, 0), []);
});
