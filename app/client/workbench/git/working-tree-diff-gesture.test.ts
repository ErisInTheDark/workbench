/* No production exports. Protect range previews, paired replacements and pointer cancellation. */
import assert from "node:assert/strict";
import test from "node:test";
import { beginDiffGesture, finishDiffGesture, moveDiffGesture } from "./working-tree-diff-gesture";

test("reverse and shrinking ranges commit only the final visible range, including split pairs", () => {
  const groups = [["old-a", "new-a"], ["old-b"], ["new-c"]];
  let gesture = beginDiffGesture(4, groups, 2, false);
  gesture = moveDiffGesture(gesture, 4, 0);
  assert.deepEqual(finishDiffGesture(gesture, 4), { ids: groups.flat(), included: false });
  gesture = moveDiffGesture(gesture, 4, 1);
  assert.deepEqual(finishDiffGesture(gesture, 4), { ids: ["old-b", "new-c"], included: false });
});

test("cancelled and unrelated pointers cannot commit a range", () => {
  const gesture = beginDiffGesture(1, [["visible"]], 0, true);
  assert.equal(finishDiffGesture(gesture, 1, true), null);
  assert.equal(finishDiffGesture(gesture, 2), null);
  assert.equal(moveDiffGesture(gesture, 2, 5), gesture);
});

test("range selection never invents IDs for hidden whitespace or context rows", () => {
  const gesture = moveDiffGesture(beginDiffGesture(1, [["a"], ["d"]], 0, true), 1, 1);
  assert.deepEqual(finishDiffGesture(gesture, 1), { ids: ["a", "d"], included: true });
});

test("the release position wins when the final pointer move has not rendered yet", () => {
  const gesture = beginDiffGesture(1, [["a"], ["b"], ["c"]], 0, false);
  assert.deepEqual(finishDiffGesture(gesture, 1, false, 2), { ids: ["a", "b", "c"], included: false });
  assert.equal(finishDiffGesture(gesture, 1, true, 2), null);
});
