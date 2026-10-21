/*
 * Exports: none. Tests protect durable order clone ownership.
 */

import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchThreadDisplayController from "./WorkbenchThreadDisplayController";

test("display owner clone can replace order without changing its source", () => {
  const relation = { above: [], below: [] };
  const owner = new WorkbenchThreadDisplayController({ pinned: { "draft:key": relation } });
  const clone = owner.clone();
  clone.displayOrder = { snoozed: { "draft:key": relation } };
  assert.deepEqual(owner.displayOrder, { pinned: { "draft:key": relation } });
  assert.deepEqual(clone.displayOrder, { snoozed: { "draft:key": relation } });
});
