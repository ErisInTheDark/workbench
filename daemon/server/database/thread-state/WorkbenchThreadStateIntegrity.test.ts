/* No production exports. Protect startup rejection of broken durable references. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchThreadStateIntegrity from "./WorkbenchThreadStateIntegrity.ts";

test("integrity accepts empty current storage and rejects orphaned canonical state", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database);
    const integrity = new WorkbenchThreadStateIntegrity(database);
    assert.doesNotThrow(() => integrity.verify());
    database.pragma("foreign_keys = OFF");
    database.exec(`INSERT INTO workbench_thread_states(thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
      VALUES ('missing', 'topLevel', 'codex', 'retained title', 1, 1)`);
    assert.throws(() => integrity.verify(), /foreign-key/);
  } finally { database.close(); }
});
