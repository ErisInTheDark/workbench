/*
 * Keywords: SQLite, migration, backup, retention.
 * Exports:
 * - WorkbenchDatabaseMigrationOptions: target version, rollback checkpoint acknowledgement, and retention clock.
 * - preserveWorkbenchDatabaseBackup: publish a verified complete snapshot without migrating the source.
 * - restoreWorkbenchDatabaseBackup: restore a verified checkpoint after every destination connection is closed.
 * - default migrateWorkbenchDatabase: verify a complete pre-upgrade backup, run migrations, then prune expired backups.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  applyWorkbenchDatabaseSchema, readWorkbenchDatabaseMigrationRange, type WorkbenchDatabaseSchema,
} from "./schema/schema-history.ts";

export interface WorkbenchDatabaseMigrationOptions {
  beforeMigration?(backupPath: string): Promise<void> | void;
  targetVersion?: number;
  now?: () => number;
}

export async function restoreWorkbenchDatabaseBackup(backupPath: string, databasePath: string) {
  if (path.resolve(backupPath) === path.resolve(databasePath)) {
    throw new Error("Database rollback checkpoint cannot be its own destination.");
  }
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  let version: number;
  try {
    const integrity = backup.pragma("quick_check") as { quick_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new Error("Database rollback checkpoint integrity verification failed.");
    }
    version = backup.pragma("user_version", { simple: true }) as number;
    await backup.backup(databasePath);
  } finally {
    backup.close();
  }
  const restored = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = restored.pragma("quick_check") as { quick_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok"
      || restored.pragma("user_version", { simple: true }) !== version) {
      throw new Error("Restored database differs from its verified rollback checkpoint.");
    }
  } finally {
    restored.close();
  }
}

const completedBackupName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite3$/i;
const retentionAgeMs = 3 * 24 * 60 * 60 * 1_000;

function boundedMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/g, " ").slice(0, 500);
}

export async function preserveWorkbenchDatabaseBackup(database: Database.Database, directory: string) {
  const installedVersion = database.pragma("user_version", { simple: true }) as number;
  const id = randomUUID();
  const temporaryPath = path.join(directory, `${id}.partial`);
  const backupPath = path.join(directory, `${id}.sqlite3`);
  try {
    await fs.mkdir(directory, { recursive: true });
    const reservation = await fs.open(temporaryPath, "wx", 0o600);
    await reservation.close();
    await database.backup(temporaryPath);
    const backup = new Database(temporaryPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = backup.pragma("quick_check") as { quick_check: string }[];
      if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
        throw new Error("Backup integrity verification failed");
      }
      if (backup.pragma("user_version", { simple: true }) !== installedVersion) {
        throw new Error("Backup schema version differs from the pre-upgrade database");
      }
    } finally {
      backup.close();
    }
    const file = await fs.open(temporaryPath, "r+");
    try { await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporaryPath, backupPath);
    // Read-only WAL verification can leave empty sidecars beside the temporary copy.
    for (const suffix of ["-wal", "-shm"]) {
      try { await fs.unlink(`${temporaryPath}${suffix}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[database] backup scratch cleanup retained ${boundedMessage(temporaryPath + suffix)}: ${boundedMessage(error)}`);
        }
      }
    }
    console.info(`[database] preserved schema ${installedVersion} backup ${boundedMessage(backupPath)}`);
    return backupPath;
  } catch (error) {
    throw new Error(`Database migration backup failed at ${boundedMessage(temporaryPath)}: ${boundedMessage(error)}`, { cause: error });
  }
}

async function pruneBackups(directory: string, now: number) {
  try {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const backups: { filePath: string; modifiedAt: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !completedBackupName.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isFile()) backups.push({ filePath, modifiedAt: stat.mtimeMs });
    }
    backups.sort((a, b) => b.modifiedAt - a.modifiedAt || a.filePath.localeCompare(b.filePath));
    for (const backup of backups.slice(5)) {
      if (now - backup.modifiedAt <= retentionAgeMs) continue;
      const current = await fs.lstat(backup.filePath);
      if (!current.isFile() || current.mtimeMs !== backup.modifiedAt) continue;
      await fs.unlink(backup.filePath);
    }
  } catch (error) {
    console.warn(`[database] migration backup cleanup retained extra files in ${boundedMessage(directory)}: ${boundedMessage(error)}`);
  }
}

export default async function migrateWorkbenchDatabase(
  database: Database.Database,
  schema: WorkbenchDatabaseSchema,
  options: WorkbenchDatabaseMigrationOptions = {},
) {
  const { installedVersion, targetVersion } = readWorkbenchDatabaseMigrationRange(database, schema, options);
  const directory = database.memory || !database.name
    ? null
    : path.join(path.dirname(path.resolve(database.name)), "backups", path.basename(database.name));
  if (directory && installedVersion < targetVersion
    && database.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
    const backupPath = await preserveWorkbenchDatabaseBackup(database, directory);
    await options.beforeMigration?.(backupPath);
  }
  applyWorkbenchDatabaseSchema(database, schema, options);
  if (directory) await pruneBackups(directory, (options.now ?? Date.now)());
}
