/* No production exports. Protect even rationing of what is left now across the time left until reset, and its even-pace ideal. */
import assert from "node:assert/strict";
import test from "node:test";

import { rationParts, type RationMark, type RationShare } from "./stats-ration";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const round = (value: number) => Math.round(value * 10) / 10;

const marks = (parts: ReturnType<typeof rationParts>) => parts.filter((part): part is RationMark => part.kind === "mark");
const shares = (parts: ReturnType<typeof rationParts>) => parts.filter((part): part is RationShare => part.kind === "share");
const steps = (parts: ReturnType<typeof rationParts>) => marks(parts).filter(({ edge }) => edge === null).map(({ leftPercent }) => round(leftPercent));

test("what is left now is split across the time left, with the partial current step getting its share", () => {
  // 50% left with 3h20m to go: at 3h, 2h and 1h before the reset, 45%, 30% and 15% should remain.
  const parts = rationParts({ durationMinutes: 300, leftPercent: 50, resetsAt: 3 * hour + 20 * minute }, 0);
  assert.deepEqual(steps(parts), [15, 30, 45]);
  assert.deepEqual(parts.map(({ kind }) => kind), ["mark", "share", "mark", "share", "mark", "share", "mark", "share", "mark"]);
  assert.deepEqual(shares(parts).map(({ sharePercent }) => round(sharePercent)), [15, 15, 15, 5]);
  assert.equal(marks(parts)[0]!.edge, "reset");
  assert.equal(marks(parts).at(-1)!.edge, "now");
  assert.equal(marks(parts).at(-1)!.leftPercent, 50);
});

test("weekly windows step by day and monthly windows by 7.5 days, counted back from the reset", () => {
  assert.deepEqual(steps(rationParts({ durationMinutes: 7 * 24 * 60, leftPercent: 70, resetsAt: 3.5 * day }, 0)).map(Math.round), [20, 40, 60]);
  assert.deepEqual(steps(rationParts({ durationMinutes: 30 * 24 * 60, leftPercent: 100, resetsAt: 30 * day }, 0)), [25, 50, 75]);
});

test("a window spent at an even pace matches its ideal everywhere; one spent slowly is ahead of it everywhere", () => {
  // Half of a 5h window gone and half of it used.
  const even = rationParts({ durationMinutes: 300, leftPercent: 50, resetsAt: 150 * minute }, 0);
  for (const part of even) {
    assert.equal(round(part.kind === "mark" ? part.leftPercent : part.sharePercent), round(part.idealPercent));
  }
  const slow = rationParts({ durationMinutes: 300, leftPercent: 80, resetsAt: 150 * minute }, 0);
  assert.ok(marks(slow).filter(({ edge }) => edge !== "reset").every(({ leftPercent, idealPercent }) => leftPercent > idealPercent));
  assert.ok(shares(slow).every(({ sharePercent, idealPercent }) => sharePercent > idealPercent));
});

test("nothing is marked without a duration, a reset ahead, or anything left", () => {
  assert.deepEqual(rationParts({ durationMinutes: null, leftPercent: 50, resetsAt: hour }, 0), []);
  assert.deepEqual(rationParts({ durationMinutes: 300, leftPercent: 50, resetsAt: null }, 0), []);
  assert.deepEqual(rationParts({ durationMinutes: 300, leftPercent: 50, resetsAt: 0 }, 0), []);
  assert.deepEqual(rationParts({ durationMinutes: 300, leftPercent: 0, resetsAt: 3 * hour }, 0), []);
});
