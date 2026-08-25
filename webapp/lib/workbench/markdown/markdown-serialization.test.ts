/*
 * No production exports. Regression wards protect explicit and derived ordered-list ordinals during rich-editor serialization. Keywords: markdown, ordered list, ordinal, serialization.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveOrderedListItemOrdinals } from "./markdown-serialization";

test("ordered-list serialization preserves every explicit ordinal", () => {
  assert.deepEqual(
    resolveOrderedListItemOrdinals(["7", "7", "9007199254740993"], null),
    ["7", "7", "9007199254740993"],
  );
});

test("ordered-list serialization derives missing values from the preceding ordinal", () => {
  assert.deepEqual(
    resolveOrderedListItemOrdinals([null, null, "0", null, "42", null], "5"),
    ["5", "6", "0", "1", "42", "43"],
  );
});

test("ordered-list serialization defaults invalid or absent starts to one", () => {
  assert.deepEqual(resolveOrderedListItemOrdinals([null, null], null), ["1", "2"]);
  assert.deepEqual(resolveOrderedListItemOrdinals([null], "nope"), ["1"]);
});
