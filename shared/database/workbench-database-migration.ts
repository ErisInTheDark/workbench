/*
 * Exports:
 * - WorkbenchDatabaseMigrationOptions: target version, rollback checkpoint acknowledgement, and retention clock.
 * - preserveWorkbenchDatabaseBackup: publish a verified complete snapshot without migrating the source.
 * - restoreWorkbenchDatabaseBackup: restore a verified checkpoint after every destination connection is closed.
 * - readWorkbenchDatabaseBackups: read verified ordinary checkpoints newest-first, excluding archives and scratch files.
 * - default migrateWorkbenchDatabase: verify a complete pre-upgrade backup, run migrations, then prune expired backups.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { formatDatabaseLog } from "./database-log-format.ts";
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
  const startedAt = performance.now();
  const installedVersion = database.pragma("user_version", { simple: true }) as number;
  const id = randomUUID();
  const temporaryPath = path.join(directory, `${id}.partial`);
  const backupPath = path.join(directory, `${id}.sqlite3`);
  try {
    console.info(formatDatabaseLog("backup", "pending", `${path.basename(database.name)}, schema: ${installedVersion}`));
    await fs.mkdir(directory, { recursive: true });
    const reservation = await fs.open(temporaryPath, "wx", 0o600);
    await reservation.close();
    let reportedAt = startedAt;
    await database.backup(temporaryPath, {
      progress: ({ totalPages, remainingPages }) => {
        const now = performance.now();
        if (now - reportedAt >= 5_000) {
          console.info(formatDatabaseLog("backup", "copying",
            `${path.basename(database.name)}, ${Math.round((totalPages - remainingPages) / totalPages * 100)}%, ${totalPages - remainingPages}/${totalPages} pages`,
            now - startedAt));
          reportedAt = now;
        }
        // Keep the driver's default page batch; this callback only observes.
        return 100;
      },
    });
    verifyBackup(temporaryPath, installedVersion, path.basename(database.name));
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
    console.info(formatDatabaseLog("backup", "ok",
      `${path.basename(database.name)}, schema: ${installedVersion}, checkpoint: ${id.slice(0, 8)}`, performance.now() - startedAt));
    return backupPath;
  } catch (error) {
    throw new Error(`Database migration backup failed at ${boundedMessage(temporaryPath)}: ${boundedMessage(error)}`, { cause: error });
  }
}

function verifyBackup(filePath: string, version: number, databaseName = path.basename(path.dirname(filePath))) {
  const startedAt = performance.now();
  const detail = `${databaseName}, schema: ${version}, checkpoint: ${path.basename(filePath).slice(0, 8)}`;
  console.info(formatDatabaseLog("verify", "pending", detail));
  const backup = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("quick_check") as { quick_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new Error("Checkpoint integrity verification failed.");
    }
    if (backup.pragma("user_version", { simple: true }) !== version) {
      throw new Error("Checkpoint schema changed since inventory.");
    }
  } catch (error) {
    throw new Error(`Database checkpoint verification failed at ${boundedMessage(filePath)}: ${boundedMessage(error)}`, { cause: error });
  } finally { backup.close(); }
  console.info(formatDatabaseLog("verify", "ok", detail, performance.now() - startedAt));
}

async function pruneBackups(directory: string, now: number) {
  const startedAt = performance.now();
  try {
    const backups = await readBackupInventory(directory);
    if (!backups.length) return;
    const retainedVersions = new Map<number, typeof backups[number]>();
    const expired = backups.filter((backup, index) => {
      const firstForVersion = !retainedVersions.has(backup.version);
      if (firstForVersion) retainedVersions.set(backup.version, backup);
      return index >= 5 && !firstForVersion && now - backup.modifiedAt > retentionAgeMs;
    });
    const databaseName = path.basename(directory);
    if (expired.length) console.info(formatDatabaseLog("retention", "pending",
      `${databaseName}, ${backups.length} checkpoints, ${expired.length} expired duplicates`));
    // Only a checkpoint replacing deleted history needs content verification.
    // Validate every replacement before the first deletion, failing closed.
    for (const version of new Set(expired.map(backup => backup.version))) {
      const retained = retainedVersions.get(version)!;
      verifyBackup(retained.filePath, retained.version);
    }
    let removed = 0;
    for (const backup of expired) {
      const retained = retainedVersions.get(backup.version)!;
      const survivor = await fs.lstat(retained.filePath);
      if (!survivor.isFile() || survivor.mtimeMs !== retained.modifiedAt) throw new Error("Retained checkpoint changed during cleanup.");
      const current = await fs.lstat(backup.filePath);
      if (!current.isFile() || current.mtimeMs !== backup.modifiedAt) continue;
      await fs.unlink(backup.filePath);
      removed++;
    }
    console.info(formatDatabaseLog("retention", "ok",
      `${databaseName}, ${backups.length} checkpoints, ${removed} removed`, performance.now() - startedAt));
  } catch (error) {
    console.warn(`[database] migration backup cleanup retained extra files in ${boundedMessage(directory)}: ${boundedMessage(error)}`);
  }
}

export async function readWorkbenchDatabaseBackups(directory: string) {
  const backups = await readBackupInventory(directory);
  for (const backup of backups) verifyBackup(backup.filePath, backup.version);
  return backups;
}

async function readBackupInventory(directory: string) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const backups: { filePath: string; modifiedAt: number; version: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !completedBackupName.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) continue;
    let backup: Database.Database | undefined;
    try {
      backup = new Database(filePath, { readonly: true, fileMustExist: true });
      const version = backup.pragma("user_version", { simple: true }) as number;
      backups.push({ filePath, modifiedAt: stat.mtimeMs, version });
    } catch (error) {
      throw new Error(`Database checkpoint verification failed at ${boundedMessage(filePath)}: ${boundedMessage(error)}`, { cause: error });
    } finally { backup?.close(); }
  }
  return backups.sort((a, b) => b.modifiedAt - a.modifiedAt || a.filePath.localeCompare(b.filePath));
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
  const reportUpgrade = directory && installedVersion > 0 && installedVersion < targetVersion;
  const startedAt = performance.now();
  const detail = `${path.basename(database.name)}, ${installedVersion} -> ${targetVersion}`;
  if (reportUpgrade) console.info(formatDatabaseLog("migrate", "pending", detail));
  applyWorkbenchDatabaseSchema(database, schema, options);
  if (reportUpgrade) console.info(formatDatabaseLog("migrate", "ok", detail, performance.now() - startedAt));
  if (directory && installedVersion < targetVersion) await pruneBackups(directory, (options.now ?? Date.now)());
}
