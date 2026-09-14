/* No exports. Keywords: chart, transforms, scaling, gaps, regression tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { chartMaximum, chartPointerIndex, chartSegments, chartX, chartY } from "./stats-chart-geometry.ts";

test("pointer selection inverts the actual plot transform, including padded and skewed SVGs", () => {
  for (const matrix of [
    { a: 2, b: 0, c: 0, d: 2, e: 150, f: 20 },
    { a: 7, b: 0, c: 0, d: 3, e: 25, f: 100 },
    { a: 2, b: 0.2, c: 0.4, d: 3, e: 180, f: 60 },
  ]) {
    for (let index = 0; index < 9; index++) {
      const x = chartX(index, 9), y = 19;
      assert.equal(chartPointerIndex(matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f, matrix, 9), index);
    }
  }
  assert.equal(chartPointerIndex(-100, 0, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 5), 0);
  assert.equal(chartPointerIndex(500, 0, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 5), 4);
  assert.equal(chartPointerIndex(0, 0, null, 5), null);
  assert.equal(chartPointerIndex(0, 0, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 5), null);
});

test("independent scales align each peak, shared scales preserve magnitude, and missing samples stay gaps", () => {
  const small = [0, 10, null, 5], large = [0, 1_000, null, 500];
  assert.equal(chartY(10, chartMaximum(small)), chartY(1_000, chartMaximum(large)));
  assert.equal(chartY(0.02, chartMaximum([0, 0.02])), chartY(1_000, chartMaximum(large)));
  assert.ok(chartY(10, chartMaximum(large)) > chartY(1_000, chartMaximum(large)));
  assert.equal(chartSegments(small, chartMaximum(small)).length, 2);
  assert.deepEqual(chartSegments([null, null], 1), []);
  assert.ok(Number.isFinite(chartY(0, chartMaximum([0, null]))));
  assert.equal(chartX(0, 1), 50);
});
