/* No production exports. Tests protect context-menu placement locking while entry state remains live. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeContextMenuPlacementEntries,
  resolveContextMenuPlacementSnapshot,
  type ContextMenuPlacementSnapshot,
} from "./context-menu-placement";

test("one menu generation freezes placement until close and a new generation captures fresh placement", () => {
  let snapshot: ContextMenuPlacementSnapshot<string[]> | null = null;

  let resolved = resolveContextMenuPlacementSnapshot(1, ["first"], snapshot);
  snapshot = resolved.snapshot;
  assert.deepEqual(resolved.value, ["first"]);

  resolved = resolveContextMenuPlacementSnapshot(1, ["second"], snapshot);
  snapshot = resolved.snapshot;
  assert.deepEqual(resolved.value, ["first"]);

  resolved = resolveContextMenuPlacementSnapshot(null, ["second"], snapshot);
  snapshot = resolved.snapshot;
  assert.deepEqual(resolved.value, ["second"]);
  assert.equal(snapshot, null);

  resolved = resolveContextMenuPlacementSnapshot(2, ["third"], snapshot);
  assert.deepEqual(resolved.value, ["third"]);
});

test("frozen placement receives live entries without admitting additions or collapsing removals", () => {
  const frozen = [
    { id: "first", status: "working" },
    { id: "removed", status: "completed" },
  ];
  const live = [
    { id: "first", status: "completed" },
    { id: "added", status: "working" },
  ];

  assert.deepEqual(
    mergeContextMenuPlacementEntries(frozen, live, entry => entry.id),
    [
      { id: "first", status: "completed" },
      { id: "removed", status: "completed" },
    ],
  );
});
