/* No production exports. Tests protect view continuity across draft launches. */
import assert from "node:assert/strict";
import test from "node:test";

import ThreadViewKeys from "./ThreadViewKeys";

test("a launched thread keeps the view of the draft chain that started it", () => {
  const keys = new ThreadViewKeys();
  assert.equal(keys.keyFor("draft-a"), "draft-a");
  keys.carry("draft-a", "draft-b");
  keys.carry("draft-b", "thread");
  assert.equal(keys.keyFor("thread"), "draft-a");
  keys.forget("draft-b");
  assert.equal(keys.keyFor("thread"), "draft-a");
  assert.equal(keys.keyFor("draft-b"), "draft-b");
});
