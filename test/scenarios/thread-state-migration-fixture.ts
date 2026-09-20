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
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import WorkbenchThreadStateIntegrity from "../../daemon/server/database/thread-state/WorkbenchThreadStateIntegrity";
import migrateWorkbenchDatabase from "../../shared/database/workbench-database-migration";
import { tableForeignKeys } from "../../shared/database/schema/schema-definition";
import databaseReleases from "../../shared/workbench/database/schema/releases";
import WorkbenchProjectIdentityMigration from "../../daemon/server/database/project/WorkbenchProjectIdentityMigration";

export async function captureThreadStateMigrationSource(sourceDatabasePath: string, privateRoot: string) {
  const directory = await fs.mkdtemp(path.join(privateRoot, "thread-state-source-"));
  const databasePath = path.join(directory, "workbench.sqlite3");
  const database = new Database(sourceDatabasePath, {
    readonly: true, fileMustExist: true,
  });
  try {
    const version = database.pragma("user_version", { simple: true }) as number;
    assert.ok(version >= 33, "Scenario source must be a current migrated database");
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
    const columns = new Map(retained.map(table => {
      const existing = new Set(
        (database.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string }>)
          .map(column => column.name),
      );
      return [table.name, Object.keys(table.columns).filter(column => existing.has(column))];
    }));
    type Row = Record<string, string | number | bigint | Buffer | null>;
    const rows = (table: typeof retained[number]) => database.prepare(
      `SELECT ${columns.get(table.name)!.map(column => `"${column}"`).join(", ")} FROM "${table.name}"`,
    ).all() as Row[];
    const before = retained.map(rows);
    const version = database.pragma("user_version", { simple: true }) as number;
    if (version < databaseReleases.stableProjectPreparation.version) {
      await migrateWorkbenchDatabase(database, workbenchDatabaseSchema, { targetVersion: databaseReleases.stableProjectPreparation.version });
    }
    await new WorkbenchProjectIdentityMigration(database).run();
    await migrateWorkbenchDatabase(database, workbenchDatabaseSchema);
    new WorkbenchThreadStateIntegrity(database).verify();
    const aliases = new Map((database.prepare("SELECT alias, project_id FROM workbench_project_aliases").all() as Array<{
      alias: string; project_id: string;
    }>).map(row => [row.alias, row.project_id]));
    const owner = (value: Row[string]) => typeof value === "string" ? aliases.get(value) ?? value : value;
    for (const [index, table] of retained.entries()) {
      const references = tableForeignKeys(table).filter(key => key.target.table === "workbench_projects")
        .flatMap(key => key.columns);
      const expected = before[index]!.map(original => {
        const row = { ...original };
        for (const column of references) row[column] = owner(row[column]!);
        if (table.name === "workbench_projects") row.id = owner(row.id!);
        if (table.name === "workbench_search_documents" && row.project_id !== original.project_id) {
          if (row.kind === "project") {
            row.document_key = `project:${row.project_id}`;
            row.target = row.project_id!;
            row.search_text = `${row.title} ${row.project_id} ${row.detail}`;
          } else if (row.kind === "file") {
            row.document_key = `file:${row.project_id}:${row.target}`;
            row.detail = row.project_id!;
          }
        }
        return row;
      });
      const after = rows(table);
      if (table.name === "workbench_project_aliases") {
        const previousAliases = new Set(expected.map(row => row.alias));
        assert.deepEqual(new Set(after.filter(row => previousAliases.has(row.alias))), new Set(expected),
          "retained aliases must still resolve to their original owners");
      } else {
        assert.deepEqual(new Set(after), new Set(expected), `${table.name} must retain every current relational fact`);
        assert.equal(after.length, expected.length, `${table.name} must retain its row count`);
      }
    }
    await new WorkbenchProjectIdentityMigration(database).run();
    await migrateWorkbenchDatabase(database, workbenchDatabaseSchema);
    new WorkbenchThreadStateIntegrity(database).verify();
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    console.log(`real current database upgraded and read back: ${retained.length} retained relational tables`);
  } finally { database.close(); }
}

export async function installThreadStateMigrationSource(
  source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>,
  target: string,
  privateRoot: string,
) {
  await fs.mkdir(path.dirname(target), { recursive: true });
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
