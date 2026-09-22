/*
 * No production exports. Protect repeatable correction of proven Codex timestamp scales without changing other rows.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import WorkbenchTranscriptTimestampRepair from "./WorkbenchTranscriptTimestampRepair.ts";

test("timestamp repair corrects microseconds and nanoseconds without touching valid or ambiguous turns", async () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE thread_turns (id TEXT PRIMARY KEY, harness_id TEXT NOT NULL, started_at INTEGER, ended_at INTEGER)");
    const insert = database.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?)");
    insert.run("micro", "codex", BigInt("1790114055000000"), null);
    insert.run("nano", "codex", BigInt("1790113687000000000"), BigInt("1790113848000000000"));
    insert.run("valid", "codex", BigInt("1790113687000"), BigInt("1790113848000"));
    insert.run("ambiguous", "codex", BigInt("12345678901234567"), null);
    insert.run("other", "opencode", BigInt("1790113687000000"), null);
    const repair = new WorkbenchTranscriptTimestampRepair(database);
    assert.deepEqual(await repair.run(), { repaired: 2, skipped: 1 });
    const rows = database.prepare("SELECT id, started_at, ended_at FROM thread_turns ORDER BY id").safeIntegers()
      .all() as Array<{ id: string; started_at: bigint | null; ended_at: bigint | null }>;
    assert.deepEqual(rows, [
      { id: "ambiguous", started_at: BigInt("12345678901234567"), ended_at: null },
      { id: "micro", started_at: BigInt("1790114055000"), ended_at: null },
      { id: "nano", started_at: BigInt("1790113687000"), ended_at: BigInt("1790113848000") },
      { id: "other", started_at: BigInt("1790113687000000"), ended_at: null },
      { id: "valid", started_at: BigInt("1790113687000"), ended_at: BigInt("1790113848000") },
    ]);
    assert.deepEqual(await repair.run(), { repaired: 0, skipped: 1 });
  } finally {
    database.close();
  }
});
