/*
 * No production exports. Tests protect the record store's write version, which derived sidebar orders trust instead of rescanning entries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchThreadRecordStore from "./WorkbenchThreadRecordStore.ts";
import type { WorkbenchThreadStateEntry } from "./workbench-thread-state-record.ts";

test("every effective entry write moves the version, and identical writes do not", () => {
  const first = { entryKind: "thread", title: "first" } as unknown as WorkbenchThreadStateEntry;
  const second = { entryKind: "thread", title: "second" } as unknown as WorkbenchThreadStateEntry;
  const store = new WorkbenchThreadRecordStore([["a", first]]);
  const seen = new Set([store.version]);
  const expectMoved = (write: () => unknown) => {
    write();
    assert.equal(seen.has(store.version), false);
    seen.add(store.version);
  };
  const expectStill = (write: () => unknown) => {
    const before = store.version;
    write();
    assert.equal(store.version, before);
  };

  expectStill(() => store.set("a", first));
  expectMoved(() => store.set("a", second));
  expectMoved(() => store.entries.set("b", first));
  expectStill(() => store.entries.delete("missing"));
  expectMoved(() => store.delete("b"));
  expectMoved(() => store.entries.clear());
  expectStill(() => store.entries.clear());
});
