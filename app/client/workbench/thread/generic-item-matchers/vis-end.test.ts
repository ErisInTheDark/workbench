/*
 * Keywords: generic item, vis end, matcher, test.
 * No production exports. Protect matching of the stored Workbench vis end item.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { matchVisEndItem } from "./vis-end";

const sessionId = "4b6d8f0e-6a52-4d2f-9c1e-2f5a7b3c9d10";

test("vis end matching accepts the stored item and declines unrelated or malformed payloads", () => {
  assert.deepEqual(matchVisEndItem({
    nativeType: "visEnd", safeValue: { type: "visEnd", id: "item", sessionId, path: "mocks/a.tsx" },
  }), { kind: "visEnd", sessionId, path: "mocks/a.tsx" });
  for (const safeValue of [null, [], {}, { sessionId: "not-a-uuid", path: "a.tsx" }, { sessionId }, { sessionId, path: "" }, { sessionId, path: 3 }]) {
    assert.equal(matchVisEndItem({ nativeType: "visEnd", safeValue }), null);
  }
  assert.equal(matchVisEndItem({ nativeType: "sleep", safeValue: { sessionId, path: "a.tsx" } }), null);
});
