/*
 * Exports:
 * - captureThreadStateMigrationSource: copy one consistent snapshot of a live database into the scenario.
 * - isolateThreadStateMigrationSource: rewrite the capture's filesystem addresses in place, before any process opens it.
 * - readDatabaseBackups: the rollback checkpoints a database owner left beside a database, with their schema versions.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";

type CopyOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: Database.BackupMetadata) => void;
};

const ISOLATED_PATH_COLUMNS = new Set([
  "cwd", "project_root", "native_location", "root_path", "workspace_path", "repository_root", "workspace_root",
  "worktree_root", "profile_path",
]);

export async function captureThreadStateMigrationSource(sourceDatabasePath: string, databasePath: string, options: CopyOptions = {}) {
  options.signal?.throwIfAborted();
  const database = new Database(sourceDatabasePath, {
    readonly: true, fileMustExist: true,
  });
  let version: number;
  try {
    // Keep one source snapshot across incremental backup steps. Without it,
    // writes from the live daemon can restart every batch indefinitely.
    database.exec("BEGIN");
    version = database.pragma("user_version", { simple: true }) as number;
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
  return { databasePath, version };
}

/** The capture keeps its own schema version, so only the current tables and columns it actually has are rewritten. */
export async function isolateThreadStateMigrationSource(databasePath: string, privateRoot: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("mmap_size = 2147483648");
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      // Commit refuses any dangling reference without scanning every table.
      database.pragma("defer_foreign_keys = ON");
      for (const table of workbenchDatabaseSchema.currentTables) {
        const existing = new Set((database.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string }>)
          .map(column => column.name));
        for (const column of Object.keys(table.columns)) {
          if (!ISOLATED_PATH_COLUMNS.has(column) || !existing.has(column)) continue;
          const values = database.prepare(`SELECT DISTINCT "${column}" AS value FROM "${table.name}"`).all() as Array<{ value: string | null }>;
          for (const { value } of values) {
            if (!value) continue;
            const key = createHash("sha256").update(value).digest("hex");
            const isolated = path.join(privateRoot, "retained-locations", key);
            database.prepare(`UPDATE "${table.name}" SET "${column}" = ? WHERE "${column}" = ?`).run(isolated, value);
          }
        }
      }
    })();
    const counts = {
      threads: Number(database.prepare("SELECT count(*) FROM workbench_threads").pluck().get()),
      states: Number(database.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get()),
      relationships: Number(database.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get()),
    };
    console.log("isolated startup uses current source counts", counts);
    return counts;
  } finally { database.close(); }
}

export async function readDatabaseBackups(databasePath: string) {
  const directory = path.join(path.dirname(databasePath), "backups", path.basename(databasePath));
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const backups: Array<{ name: string; version: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite3")) continue;
    const checkpoint = new Database(path.join(directory, entry.name), { readonly: true, fileMustExist: true });
    try { backups.push({ name: entry.name, version: checkpoint.pragma("user_version", { simple: true }) as number }); }
    finally { checkpoint.close(); }
  }
  return backups.sort((left, right) => left.name.localeCompare(right.name));
}
