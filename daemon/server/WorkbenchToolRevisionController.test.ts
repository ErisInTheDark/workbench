/*
 * No production exports. Tests preserve catalogue invalidation across replacement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchToolRevisionController from "./WorkbenchToolRevisionController";

test("catalogue replacement preserves prior revision and subsequent invalidation", () => {
  const original = new WorkbenchToolRevisionController();
  original.bump();
  const revision = original.revision;
  const replacement = new WorkbenchToolRevisionController(original.detachForReload());
  assert.equal(replacement.revision, revision);
  replacement.bump();
  assert.notEqual(replacement.revision, revision);
  assert.equal(original.revision, revision);
});
