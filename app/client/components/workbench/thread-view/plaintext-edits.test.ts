/* No production exports. Protect selection offsets across independent, length-changing edits. */
import assert from "node:assert/strict";
import test from "node:test";
import { mapPlaintextOffset } from "./plaintext-edits";

test("range mapping accumulates earlier edits and clamps endpoints inside a replacement", () => {
  const edits = [{ start: 2, end: 6, text: "x" }, { start: 10, end: 12, text: "expanded" }];
  assert.deepEqual([0, 2, 4, 6, 8, 10, 11, 12, 15].map(offset => mapPlaintextOffset(offset, edits)),
    [0, 2, 3, 3, 5, 7, 8, 15, 18]);
});
