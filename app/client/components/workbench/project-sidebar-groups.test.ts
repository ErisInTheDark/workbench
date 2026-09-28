/* No production exports. Tests protect selection membership and incremental display tiers. */
import assert from "node:assert/strict";
import test from "node:test";

import { groupProjectSelection, resolveSelectedProjectIds } from "./project-sidebar-groups";

const entries = ["selected", "unsettled", "settled", "archived"].map(id => ({
  activityAt: null, project: { id }, summary: null,
}));

test("dynamic selection includes settled but unarchived projects", () => {
  const unarchived = new Set(["selected", "unsettled", "settled"]);
  assert.deepEqual(resolveSelectedProjectIds(entries.map(item => item.project.id), null, unarchived), [
    "selected", "unsettled", "settled",
  ]);
  assert.deepEqual(resolveSelectedProjectIds(entries.map(item => item.project.id), [], unarchived), []);
});

test("incremental tiers partition app pools around the opening selection", () => {
  const tiers = groupProjectSelection(entries, ["selected"], new Set(["unsettled"]),
    new Set(["selected", "unsettled", "settled"]));
  assert.deepEqual(tiers.selected.map(item => item.project.id), ["selected"]);
  assert.deepEqual(tiers.unsettled.map(item => item.project.id), ["unsettled"]);
  assert.deepEqual(tiers.unarchived.map(item => item.project.id), ["settled"]);
  assert.deepEqual(tiers.all.map(item => item.project.id), ["archived"]);
});
