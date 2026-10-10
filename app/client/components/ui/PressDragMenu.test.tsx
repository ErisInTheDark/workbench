/* No production exports. Tests protect saved group visibility in press-drag selection. */
import assert from "node:assert/strict";
import test from "node:test";
import { getPressDragGroupItems, type PressDragMenuGroup } from "./PressDragMenu";

test("closed groups offer no model selections while open and default groups do", () => {
  const group: PressDragMenuGroup = {
    id: "provider:codex",
    label: "Codex",
    items: [{ id: "model", content: "Model" }],
  };
  assert.deepEqual(getPressDragGroupItems({ ...group, open: false }), []);
  assert.deepEqual(getPressDragGroupItems({ ...group, open: true }).map(item => item.id), ["model"]);
  assert.deepEqual(getPressDragGroupItems(group).map(item => item.id), ["model"]);
});
