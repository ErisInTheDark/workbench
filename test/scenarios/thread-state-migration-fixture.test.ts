/* No exports. Protects consistent fixture capture and cancellation of SQLite copies. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { captureThreadStateMigrationSource } from "./thread-state-migration-fixture";

async function source(context: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scenario-capture-"));
  const databasePath = path.join(root, "source.sqlite3");
  const writer = new Database(databasePath);
  writer.pragma("journal_mode = WAL");
  writer.pragma("user_version = 33");
  writer.exec("CREATE TABLE facts (id INTEGER PRIMARY KEY, value INTEGER, padding BLOB)");
  const insert = writer.prepare("INSERT INTO facts VALUES (?, 0, zeroblob(4096))");
  writer.transaction(() => {
    for (let id = 0; id < 400; id++) insert.run(id);
  })();
  context.after(async () => {
    writer.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, databasePath, writer, target: path.join(root, "isolated", "workbench.sqlite3") };
}

test("capture finishes one consistent snapshot while another connection keeps writing", async context => {
  const fixture = await source(context);
  const cancellation = new AbortController();
  let batches = 0;
  const captured = await captureThreadStateMigrationSource(fixture.databasePath, fixture.target, {
    signal: cancellation.signal,
    onProgress: () => {
      fixture.writer.prepare("UPDATE facts SET value = value + 1").run();
      // A restarting backup must fail deterministically, not hang the regression.
      if (++batches === 20) cancellation.abort(new Error("Backup keeps restarting"));
    },
  });
  assert.equal(captured.databasePath, fixture.target, "Capture directly into the eventual runtime database");
  assert.ok(batches > 1, "Exercise writes between multiple backup batches");
  assert.ok(batches < 20, "Concurrent writes must not restart a pinned capture");
  const copy = new Database(captured.databasePath, { readonly: true });
  try {
    assert.deepEqual(copy.prepare("SELECT DISTINCT value FROM facts").pluck().all(), [0]);
    assert.equal(copy.prepare("SELECT count(*) FROM facts").pluck().get(), 400);
    assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  } finally { copy.close(); }
  assert.ok(Number(fixture.writer.prepare("SELECT value FROM facts LIMIT 1").pluck().get()) > 0);
});

for (const timing of ["before", "during"] as const) {
  test(`capture cancellation ${timing} copying releases database resources`, async context => {
    const fixture = await source(context);
    const cancellation = new AbortController();
    const reason = new Error("Caller cancelled copying");
    if (timing === "before") cancellation.abort(reason);
    let batches = 0;
    const options = {
      signal: cancellation.signal,
      onProgress: ({ totalPages, remainingPages }: Database.BackupMetadata) => {
        if (remainingPages === totalPages) return;
        batches++;
        cancellation.abort(reason);
      },
    };
    await assert.rejects(captureThreadStateMigrationSource(fixture.databasePath, fixture.target, options),
      error => error === reason);
    assert.equal(batches, timing === "before" ? 0 : 1);
    assert.deepEqual(fixture.writer.pragma("wal_checkpoint(TRUNCATE)"), [{ busy: 0, log: 0, checkpointed: 0 }]);
    // No incomplete destination survives cancellation.
    const entries = await fs.readdir(fixture.root, { recursive: true });
    assert.ok(!entries.some(entry => entry.endsWith("workbench.sqlite3")));
  });
}

test("capture refuses to overwrite an existing destination", async context => {
  const fixture = await source(context);
  await fs.mkdir(path.dirname(fixture.target), { recursive: true });
  await fs.writeFile(fixture.target, "existing data");
  await assert.rejects(captureThreadStateMigrationSource(fixture.databasePath, fixture.target), { code: "EEXIST" });
  assert.equal(await fs.readFile(fixture.target, "utf8"), "existing data");
});

test("failed partial-copy cleanup preserves both the copy error and cleanup error", async context => {
  const fixture = await source(context);
  const copyError = new Error("Copy failed");
  const cleanupError = new Error("Partial file could not be removed");
  context.mock.method(fs, "unlink", async () => { throw cleanupError; });
  await assert.rejects(captureThreadStateMigrationSource(fixture.databasePath, fixture.target, {
    onProgress: () => { throw copyError; },
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [copyError, cleanupError]);
    return true;
  });
});
