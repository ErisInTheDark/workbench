/*
 * No exports. Tests protect per-layer exclusivity, cascading closes, and the safe-area chain across nested triggers and layers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchTooltipLayers } from "./workbench-tooltip-layers.ts";

function harness() {
  const layers = new WorkbenchTooltipLayers();
  const closed: string[] = [];
  const open = (name: string, node: { layer?: number; owner?: symbol | null; parent?: symbol | null }, safeX?: number) => {
    const id = Symbol(name);
    layers.open(
      { id, layer: node.layer ?? 0, owner: node.owner ?? null, parent: node.parent ?? null },
      { close: () => closed.push(name), isPointerLocallySafe: (x) => x === safeX },
    );
    return id;
  };
  return { closed, layers, open };
}

test("a new root closes other roots on its layer only", () => {
  const { closed, layers, open } = harness();
  const row = open("row", {});
  const inside = open("inside", { layer: 1, owner: row });
  const other = open("other", {});
  assert.deepEqual(closed, ["inside", "row"]);
  assert.equal(layers.isOpen(other), true);
  const innerRoot = open("inner-root", { layer: 1, owner: other });
  open("inner-sibling", { layer: 1, owner: other });
  assert.deepEqual(closed, ["inside", "row", "inner-root"]);
  assert.equal(layers.isOpen(inside), false);
  assert.equal(layers.isOpen(other), true);
});

test("nested triggers join their parent without closing it", () => {
  const { closed, layers, open } = harness();
  const row = open("row", {});
  const time = open("time", { parent: row });
  assert.deepEqual(closed, []);
  assert.equal(layers.isOpen(time), true);
  layers.close(row);
  assert.deepEqual(closed, ["time", "row"]);
});

test("a tooltip stays safe while the pointer rests on anything it holds open", () => {
  const { layers, open } = harness();
  const row = open("row", {}, 1);
  const time = open("time", { parent: row }, 2);
  const deeper = open("deeper", { layer: 1, owner: time }, 3);
  assert.equal(layers.isPointerSafe(row, 3, 0), true);
  assert.equal(layers.isPointerSafe(time, 1, 0), false);
  assert.equal(layers.isPointerSafe(row, 9, 0), false);
  layers.close(deeper);
  assert.equal(layers.isPointerSafe(row, 3, 0), false);
});
