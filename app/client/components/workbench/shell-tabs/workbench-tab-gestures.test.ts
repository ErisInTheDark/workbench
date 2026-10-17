/*
 * No production exports. Protect touch double-tap pairing on shell tabs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isWorkbenchTabDoubleTap } from "./workbench-tab-gestures.ts";

test("two quick taps on one tab pair, while a slow, first or other-tab tap does not", () => {
  const first = { tab: "settings", atMs: 1000 };
  assert.equal(isWorkbenchTabDoubleTap(null, first), false);
  assert.equal(isWorkbenchTabDoubleTap(first, { tab: "settings", atMs: 1150 }), true);
  assert.equal(isWorkbenchTabDoubleTap(first, { tab: "settings", atMs: 6000 }), false);
  assert.equal(isWorkbenchTabDoubleTap(first, { tab: "git", atMs: 1100 }), false);
});
