/* Exports: none. Protect that a daemon heap snapshot lands as a readable file and reports itself while it runs. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { writeDaemonHeapSnapshot } from "./daemon-heap-snapshot";

test("a heap snapshot is written in full and announces start and finish", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-heap-snapshot-");
  try {
    const lines: string[] = [];
    // A long progress interval keeps the worker's direct stdout lines out of a fast test snapshot.
    const snapshot = await writeDaemonHeapSnapshot(temporary.path, line => lines.push(line), 60_000);
    const parsed = JSON.parse(await readFile(snapshot.path, "utf8")) as { snapshot?: { node_count?: number } };
    assert.ok((parsed.snapshot?.node_count ?? 0) > 0);
    assert.equal(snapshot.bytes > 0, true);
    assert.match(lines[0] ?? "", /DBG Heap snapshot .*started/u);
    assert.match(lines.at(-1) ?? "", /DBG Heap snapshot .*finished/u);
  } finally {
    await temporary.dispose();
  }
});
