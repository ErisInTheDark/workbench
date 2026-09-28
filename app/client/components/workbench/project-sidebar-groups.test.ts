/* No production exports. Tests protect selection membership and incremental display tiers. */
import assert from "node:assert/strict";
import test from "node:test";

import { groupProjectSelection, nextProjectSelectionTier, resolveSelectedProjectIds } from "./project-sidebar-groups";

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
  assert.equal(nextProjectSelectionTier(0, tiers, 0), 1);
  assert.equal(nextProjectSelectionTier(1, tiers, 0), 2);
  assert.equal(nextProjectSelectionTier(2, tiers, 0), 3);
  assert.equal(nextProjectSelectionTier(3, tiers, 0), null);
});

test("reveal skips empty groups and stops when no projects remain", () => {
  const selected = ["selected"];
  const remaining = (ids: readonly string[]) => entries.filter(entry => selected.includes(entry.project.id)
    || ids.includes(entry.project.id));
  const onlyUnarchived = groupProjectSelection(remaining(["settled"]), selected, new Set<string>(),
    new Set(["settled"]));
  assert.equal(nextProjectSelectionTier(0, onlyUnarchived, 0), 2);

  const onlyArchived = groupProjectSelection(remaining(["archived"]), selected, new Set<string>(),
    new Set<string>());
  assert.equal(nextProjectSelectionTier(0, onlyArchived, 0), 3);
  assert.equal(nextProjectSelectionTier(1, onlyArchived, 0), 3);
  assert.equal(nextProjectSelectionTier(0, onlyArchived, 1), 3);
  assert.equal(nextProjectSelectionTier(3, onlyArchived, 1), null);

  const noRemaining = groupProjectSelection(remaining([]), selected, new Set<string>(), new Set<string>());
  assert.equal(nextProjectSelectionTier(0, noRemaining, 0), null);
  assert.equal(nextProjectSelectionTier(0, noRemaining, 1), 3);
});
