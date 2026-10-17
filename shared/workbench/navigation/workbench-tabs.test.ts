/*
 * No production exports. Protect preview replacement, pinning, closing focus and moved destinations of the tab strip.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { WorkbenchTabStrip } from "./workbench-tabs.ts";

test("plain opens replace the preview tab, durable ones keep it, and open tabs only refocus", () => {
  let strip = WorkbenchTabStrip.open(WorkbenchTabStrip.empty, "thread/one/a");
  assert.deepEqual(strip, { tabs: ["thread/one/a"], preview: 0 });
  strip = WorkbenchTabStrip.open(strip, "file/notes.md");
  assert.deepEqual(strip, { tabs: ["file/notes.md"], preview: 0 }, "the preview tab is replaced");
  strip = WorkbenchTabStrip.pin(strip, "file/notes.md");
  strip = WorkbenchTabStrip.open(strip, "settings", { focused: "file/notes.md" });
  strip = WorkbenchTabStrip.open(strip, "stats", { focused: "settings" });
  assert.deepEqual(strip, { tabs: ["file/notes.md", "stats"], preview: 1 });
  strip = WorkbenchTabStrip.open(strip, "git", { durable: true, focused: "file/notes.md" });
  assert.deepEqual(strip, { tabs: ["file/notes.md", "git", "stats"], preview: 2 }, "a kept tab shifts the preview index");
  assert.equal(WorkbenchTabStrip.open(strip, "git"), strip);
  assert.deepEqual(WorkbenchTabStrip.open(strip, "stats", { durable: true }), { tabs: strip.tabs, preview: null });
});

test("closing focuses the right neighbour, then the left, and keeps other focus and preview positions", () => {
  const strip = { tabs: ["a", "b", "c"], preview: 2 };
  assert.deepEqual(WorkbenchTabStrip.close(strip, "b", "b"), { strip: { tabs: ["a", "c"], preview: 1 }, focus: "c" });
  assert.deepEqual(WorkbenchTabStrip.close(strip, "c", "c"), { strip: { tabs: ["a", "b"], preview: null }, focus: "b" });
  assert.deepEqual(WorkbenchTabStrip.close(strip, "a", "c"), { strip: { tabs: ["b", "c"], preview: 1 }, focus: "c" });
  assert.deepEqual(WorkbenchTabStrip.close({ tabs: ["a"], preview: null }, "a", "a"), { strip: { tabs: [], preview: null }, focus: null });
});

test("a moved destination keeps its place and merges into an already open copy", () => {
  const strip = { tabs: ["thread/one/new", "file/a.svg"], preview: 0 };
  assert.deepEqual(WorkbenchTabStrip.replace(strip, "thread/one/new", "thread/one/new/draft-1"),
    { tabs: ["thread/one/new/draft-1", "file/a.svg"], preview: 0 });
  assert.deepEqual(WorkbenchTabStrip.replace(strip, "thread/one/new", "file/a.svg"), { tabs: ["file/a.svg"], preview: null });
});
