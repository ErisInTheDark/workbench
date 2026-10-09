/* No exports. Tests protect that models shown together get stable, distinguishable colours. */
import assert from "node:assert/strict";
import test from "node:test";
import { statsModelHues } from "./stats-model-colours.ts";

const separation = (left: number, right: number) => Math.min(Math.abs(left - right), 360 - Math.abs(left - right));

test("models shown together stay visibly apart", () => {
  const keys = Array.from({ length: 8 }, (_, index) => `gpt-${index}`);
  const hues = [...statsModelHues(keys).values()];
  for (const [index, hue] of hues.entries()) {
    for (const other of hues.slice(index + 1)) assert.ok(separation(hue, other) >= 28, `${hue} and ${other} are too close`);
  }
});

test("a model keeps its colour regardless of order or duplicates", () => {
  const keys = ["claude-opus-5-5", "gpt-6-sol", "opencode/mimo"];
  assert.deepEqual(statsModelHues(keys), statsModelHues([...keys].reverse().concat(keys)));
});
