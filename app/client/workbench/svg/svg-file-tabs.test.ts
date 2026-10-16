/*
 * No production exports. Protect tab ordering, focus after closing, and save-as merging.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { closeFileTab, openFileTab, replaceFileTab } from "./svg-file-tabs";

const tab = (filePath: string, folderAddress: string[] | null = null) => ({ filePath, folderAddress });

test("opening focuses existing tabs, distinguishes folders, and inserts new tabs after the focused one", () => {
  let list = openFileTab({ tabs: [], index: 0 }, tab("a.svg"));
  list = openFileTab(list, tab("b.svg"));
  list = openFileTab({ ...list, index: 0 }, tab("c.svg"));
  assert.deepEqual(list.tabs.map(item => item.filePath), ["a.svg", "c.svg", "b.svg"]);
  assert.equal(list.index, 1);
  assert.equal(openFileTab(list, tab("b.svg")).index, 2);
  assert.equal(openFileTab(list, tab("b.svg", ["+wt"])).tabs.length, 4);
});

test("closing keeps focus on the same tab or moves to its neighbour, and the last close empties the list", () => {
  const list = { tabs: [tab("a.svg"), tab("b.svg"), tab("c.svg")], index: 1 };
  assert.deepEqual(closeFileTab(list, 1), { tabs: [tab("a.svg"), tab("c.svg")], index: 1 });
  assert.deepEqual(closeFileTab(list, 0), { tabs: [tab("b.svg"), tab("c.svg")], index: 0 });
  assert.deepEqual(closeFileTab({ ...list, index: 2 }, 2)?.index, 1);
  assert.equal(closeFileTab({ tabs: [tab("a.svg")], index: 0 }, 0), null);
});

test("save as replaces the tab in place, or merges into an already-open copy of the destination", () => {
  const list = { tabs: [tab("a.svg"), tab("b.svg")], index: 0 };
  assert.deepEqual(replaceFileTab(list, 0, tab("c.svg")), { tabs: [tab("c.svg"), tab("b.svg")], index: 0 });
  assert.deepEqual(replaceFileTab(list, 0, tab("b.svg")), { tabs: [tab("b.svg")], index: 0 });
});
