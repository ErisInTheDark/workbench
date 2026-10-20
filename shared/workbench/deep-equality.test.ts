/*
 * No production exports. Protects structural equality and the difference path that explains a failed comparison.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { areDeeplyEqual, firstDeepDifference } from "./deep-equality";

test("structural equality ignores key order but not missing, extra, or undefined-valued keys", () => {
  assert.equal(areDeeplyEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(areDeeplyEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(areDeeplyEqual([1, 2], [1, 2, 3]), false);
  assert.equal(areDeeplyEqual(new Date(0), new Date(0)), false);
});

test("the first difference names where two graphs diverge", () => {
  assert.equal(firstDeepDifference({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), null);
  assert.equal(firstDeepDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }), "$.a.b[1]");
  assert.equal(firstDeepDifference({ a: 1 }, { a: 1, extra: undefined }), "$.extra");
  assert.equal(firstDeepDifference({ list: [1] }, { list: [1, 2] }), "$.list.length");
});
