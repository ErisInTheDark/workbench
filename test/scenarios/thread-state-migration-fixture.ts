/*
 * Exports:
 * - captureThreadStateMigrationSource: capture a consistent database directly into its private runtime location.
 * - verifyThreadStateMigrationSource: upgrade a real copy and verify retained relational facts.
 * - isolateThreadStateMigrationSource: rewrite the verified capture's filesystem addresses in place.
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

type CopyOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: Database.BackupMetadata) => void;
};

export async function captureThreadStateMigrationSource(sourceDatabasePath: string, databasePath: string, options: CopyOptions = {}) {
  options.signal?.throwIfAborted();
  const database = new Database(sourceDatabasePath, {
    readonly: true, fileMustExist: true,
  });
  try {
    // Keep one source snapshot across incremental backup steps. Without it,
    // writes from the live daemon can restart every batch indefinitely.
    database.exec("BEGIN");
    const version = database.pragma("user_version", { simple: true }) as number;
    assert.ok(version >= 33, "Scenario source must be a current migrated database");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    options.signal?.throwIfAborted();
    // Reserve exclusively: cleanup may delete only the destination we created.
    const reservation = await fs.open(databasePath, "wx");
    await reservation.close();
    try {
      await database.backup(databasePath, {
        progress: progress => {
          options.signal?.throwIfAborted();
          options.onProgress?.(progress);
          options.signal?.throwIfAborted();
          return 100;
        },
      });
      options.signal?.throwIfAborted();
    } catch (error) {
      try { await fs.unlink(databasePath); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Database capture and partial-file cleanup failed");
      }
      throw error;
    }
  } finally { database.close(); }
  return { databasePath };
}

export async function verifyThreadStateMigrationSource(source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>) {
  const database = new Database(source.databasePath, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    // Read-only mappings avoid copying every scanned page into SQLite's cache.
    // Keep migrations unmapped so Windows can still truncate database files.
    database.pragma("mmap_size = 2147483648");
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
    database.pragma("mmap_size = 0");
    if (version < databaseReleases.stableProjectPreparation.version) {
      await migrateWorkbenchDatabase(database, workbenchDatabaseSchema, { targetVersion: databaseReleases.stableProjectPreparation.version });
    }
    await new WorkbenchProjectIdentityMigration(database).run();
    await migrateWorkbenchDatabase(database, workbenchDatabaseSchema);
    database.pragma("mmap_size = 2147483648");
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
    database.pragma("mmap_size = 0");
    await new WorkbenchProjectIdentityMigration(database).run();
    await migrateWorkbenchDatabase(database, workbenchDatabaseSchema);
    database.pragma("mmap_size = 2147483648");
    new WorkbenchThreadStateIntegrity(database).verify();
    assert.equal(database.pragma("user_version", { simple: true }), workbenchDatabaseSchema.currentVersion);
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    console.log(`database schema ${version} -> ${workbenchDatabaseSchema.currentVersion}${version === workbenchDatabaseSchema.currentVersion ? " (no pending migration)" : ""}; ${retained.length} relational tables verified`);
  } finally { database.close(); }
}

export async function isolateThreadStateMigrationSource(
  source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>,
  privateRoot: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const database = new Database(source.databasePath, { fileMustExist: true });
  try {
    database.pragma("mmap_size = 2147483648");
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
