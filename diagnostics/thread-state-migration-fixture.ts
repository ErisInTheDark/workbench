/*
 * Exports:
 * - captureThreadStateMigrationSource: capture a consistent current migrated database without providers.
 * - verifyThreadStateMigrationSource: upgrade a real copy and verify retained relational facts.
 * - installThreadStateMigrationSource: install the upgraded capture with isolated filesystem addresses.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { workbenchDatabaseSchema } from "../daemon/server/database/workbench-database-schema";
import WorkbenchThreadStateIntegrity from "../daemon/server/database/thread-state/WorkbenchThreadStateIntegrity";
import migrateWorkbenchDatabase from "../shared/database/workbench-database-migration";

export async function captureThreadStateMigrationSource(sourceRoot: string, privateRoot: string) {
  const directory = await fs.mkdtemp(path.join(privateRoot, "thread-state-source-"));
  const databasePath = path.join(directory, "workbench.sqlite3");
  const database = new Database(path.join(sourceRoot, ".workbench", "workbench.sqlite3"), {
    readonly: true, fileMustExist: true,
  });
  try {
    const version = database.pragma("user_version", { simple: true }) as number;
    assert.ok(version >= 33, "Diagnostic source must be a current migrated database");
    await database.backup(databasePath);
  } finally { database.close(); }
  return { databasePath };
}

export async function verifyThreadStateMigrationSource(source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>) {
  const database = new Database(source.databasePath, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    const retained = workbenchDatabaseSchema.currentTables.filter(table =>
      !table.name.startsWith("workbench_thread_state_")
      && !table.name.startsWith("workbench_git_arc_proposal_diff")
      && database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table.name));
    const rows = (table: typeof retained[number]) => database.prepare(
      `SELECT * FROM "${table.name}" ORDER BY ${Object.keys(table.columns).map(column => `"${column}"`).join(", ")}`,
    ).all();
    const before = retained.map(table => rows(table));
    await migrateWorkbenchDatabase(database, workbenchDatabaseSchema);
    new WorkbenchThreadStateIntegrity(database).verify();
    for (const [index, table] of retained.entries()) {
      assert.deepEqual(rows(table), before[index], `${table.name} must retain every current relational fact`);
    }
    await migrateWorkbenchDatabase(database, workbenchDatabaseSchema);
    new WorkbenchThreadStateIntegrity(database).verify();
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    console.log(`real current database upgraded and read back: ${retained.length} retained relational tables`);
  } finally { database.close(); }
}

export async function installThreadStateMigrationSource(
  source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>,
  project: string,
  privateRoot: string,
) {
  const target = path.join(project, ".workbench", "workbench.sqlite3");
  const captured = new Database(source.databasePath, { readonly: true, fileMustExist: true });
  try { await captured.backup(target); }
  finally { captured.close(); }
  const database = new Database(target, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      for (const table of workbenchDatabaseSchema.currentTables) {
        for (const column of Object.keys(table.columns)) {
          if (!["cwd", "project_root", "native_location", "root_path", "workspace_path", "repository_root", "workspace_root", "worktree_root", "profile_path"].includes(column)) continue;
          const values = database.prepare(`SELECT DISTINCT "${column}" AS value FROM "${table.name}"`).all() as Array<{ value: string | null }>;
          for (const { value } of values) {
            if (!value) continue;
            const key = createHash("sha256").update(value).digest("hex");
            const isolated = path.join(privateRoot, "retained-locations", key);
            database.prepare(`UPDATE "${table.name}" SET "${column}" = ? WHERE "${column}" = ?`).run(isolated, value);
          }
        }
      }
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    })();
    database.pragma("foreign_keys = ON");
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    const counts = {
      threads: database.prepare("SELECT count(*) FROM workbench_threads").pluck().get(),
      states: database.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get(),
      relationships: database.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get(),
    };
    console.log("isolated startup uses current source counts", counts);
    return counts;
  } finally { database.close(); }
}
