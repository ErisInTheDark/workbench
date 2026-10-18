/* No production exports. Protect the usable mark tag list recovered from stored or edited data. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MARK_TAG_LIMIT, MarkTag } from "./mark-tags.ts";

test("lists keep the first of each name, tidy names, repair colours and stop at the keybind limit", () => {
  assert.deepEqual(MarkTag.normalizeList([
    { color: "green", name: "  good\u0007  job " },
    { color: "red", name: "good job" },
    { color: "neon", name: "loud" },
    { color: "blue", name: "   " },
    "stray",
  ]), [{ color: "green", name: "good job" }, { color: "red", name: "loud" }]);

  const many = Array.from({ length: MARK_TAG_LIMIT + 3 }, (_, index) => ({ color: "teal", name: `tag ${index}` }));
  assert.equal(MarkTag.normalizeList(many).length, MARK_TAG_LIMIT);
  assert.deepEqual(MarkTag.normalizeList(null), []);
});
