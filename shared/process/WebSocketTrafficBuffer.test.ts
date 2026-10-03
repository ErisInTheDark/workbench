/* No production exports. Protect bounded retention, newest-first search filters and exact payload reads. */
import assert from "node:assert/strict";
import test from "node:test";
import WebSocketTrafficBuffer from "./WebSocketTrafficBuffer.ts";

test("search pages newest-first through label, grep and direction filters and reads exact payloads", () => {
  const buffer = new WebSocketTrafficBuffer();
  buffer.record({ direction: "out", connection: "c1", label: "wb:workspace/delta summaries phase", payload: "{\"phase\":\"stale\"}" });
  buffer.record({ direction: "in", connection: "c1", label: "wb:workspace/observe", payload: "{\"kind\":\"catalogue\"}" });
  buffer.record({ direction: "out", connection: "c2", label: "wb:workspace/delta catalogue phase", payload: "{\"phase\":\"current\"}" });

  const deltas = buffer.query({ action: "search", label: "WB:workspace/delta", limit: 40 });
  assert.equal(deltas.action, "search");
  if (deltas.action !== "search") return;
  assert.deepEqual(deltas.entries.map(entry => entry.seq), [3, 1]);
  const older = buffer.query({ action: "search", label: "wb:workspace/delta", before: 3, limit: 40 });
  assert.deepEqual(older.action === "search" && older.entries.map(entry => entry.seq), [1]);
  const stale = buffer.query({ action: "search", grep: "STALE", direction: "out", limit: 40 });
  assert.deepEqual(stale.action === "search" && stale.entries.map(entry => entry.seq), [1]);
  const read = buffer.query({ action: "read", seq: 2 });
  assert.equal(read.action === "read" && read.entry?.payload, "{\"kind\":\"catalogue\"}");
});

test("retention evicts oldest frames past count or byte budgets and marks oversized payloads", () => {
  const buffer = new WebSocketTrafficBuffer({ maxEntries: 3, maxBytes: 25, maxPayloadChars: 10 });
  for (let index = 1; index <= 5; index++) {
    buffer.record({ direction: "out", connection: "c1", label: `frame ${index}`, payload: "x".repeat(index === 5 ? 50 : 8) });
  }
  const result = buffer.query({ action: "search", limit: 40 });
  if (result.action !== "search") return assert.fail("search result expected");
  // Count evicts frame 2 at the fifth record; bytes then evict frame 3 (8 + 8 + 10 > 25).
  assert.deepEqual(result.entries.map(entry => entry.seq), [5, 4]);
  assert.ok(result.retained.bytes <= 25);
  assert.equal(result.entries[0]!.truncated, true);
  assert.equal(result.entries[0]!.bytes, 50);
  assert.deepEqual(buffer.query({ action: "read", seq: 1 }), { action: "read", entry: null });
});
