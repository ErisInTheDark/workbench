/* No production exports. Protect click and shift-click period selection over activity buckets. */
import assert from "node:assert/strict";
import test from "node:test";

import { nextStatsPeriod } from "./stats-period";

test("shift-clicks extend from the first clicked bucket in either direction", () => {
  const picked = nextStatsPeriod(null, 5, false);
  assert.deepEqual(picked, { anchor: 5, from: 5, to: 5 });
  const later = nextStatsPeriod(picked, 8, true);
  assert.deepEqual(later, { anchor: 5, from: 5, to: 8 });
  assert.deepEqual(nextStatsPeriod(later, 2, true), { anchor: 5, from: 2, to: 5 }, "extending past the anchor flips the range around it");
  assert.deepEqual(nextStatsPeriod(null, 3, true), { anchor: 3, from: 3, to: 3 }, "shift without a selection picks one bucket");
});

test("a plain click replaces a range, and clicking the only selected bucket clears it", () => {
  const range = { anchor: 2, from: 2, to: 6 };
  assert.deepEqual(nextStatsPeriod(range, 4, false), { anchor: 4, from: 4, to: 4 });
  assert.equal(nextStatsPeriod({ anchor: 4, from: 4, to: 4 }, 4, false), null);
});
