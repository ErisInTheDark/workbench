/*
 * Exports:
 * - WorkbenchDatabaseMigrationOptions: target version, rollback checkpoint acknowledgement, and retention clock.
 * - preserveWorkbenchDatabaseBackup: publish a verified complete snapshot without migrating the source.
 * - restoreWorkbenchDatabaseBackup: restore a verified checkpoint after every destination connection is closed.
 * - readWorkbenchDatabaseBackups: read verified ordinary checkpoints newest-first, excluding archives and scratch files.
 * - default migrateWorkbenchDatabase: verify a pre-upgrade backup, migrate, then bound ordinary and failed-upgrade history.
 * - WorkbenchDatabaseDiagnostic: route human migration and recovery logs to an existing owner.
 * - WorkbenchDatabaseDiagnosticObserver: observe structured migration and recovery progress.
 * - reportWorkbenchDatabaseDiagnostic: emit through an injected owner or the existing console fallback.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import {
  formatWorkbenchDatabaseDiagnostic,
  WorkbenchDatabaseDiagnosticEventSchema,
  type WorkbenchDatabaseDiagnosticEvent,
} from "./workbench-database-diagnostic.ts";
import {
  applyWorkbenchDatabaseSchema, readWorkbenchDatabaseMigrationRange, type WorkbenchDatabaseSchema,
} from "./schema/schema-history.ts";

export interface WorkbenchDatabaseMigrationOptions {
  beforeMigration?(backupPath: string): Promise<void> | void;
  diagnostic?: WorkbenchDatabaseDiagnostic;
  diagnosticEvent?: WorkbenchDatabaseDiagnosticObserver;
  targetVersion?: number;
  now?: () => number;
}

export type WorkbenchDatabaseDiagnostic = (level: "info" | "warn", message: string) => void;
export type WorkbenchDatabaseDiagnosticObserver = (event: WorkbenchDatabaseDiagnosticEvent) => void;

export function reportWorkbenchDatabaseDiagnostic(
  diagnostic: WorkbenchDatabaseDiagnostic | undefined,
  event: WorkbenchDatabaseDiagnosticEvent,
  observer?: WorkbenchDatabaseDiagnosticObserver,
) {
  const boundedEvent = WorkbenchDatabaseDiagnosticEventSchema.parse(event);
  if (observer) {
    observer(boundedEvent);
    return;
  }
  const message = formatWorkbenchDatabaseDiagnostic(boundedEvent);
  if (diagnostic) diagnostic(boundedEvent.level, message);
  else if (boundedEvent.level === "warn") console.warn(message);
  else console.info(message);
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
const ordinaryBackupAgeMs = 7 * 24 * 60 * 60 * 1_000;
const failedUpgradeAgeMs = 30 * 24 * 60 * 60 * 1_000;

function boundedMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/g, " ").slice(0, 500);
}

export async function preserveWorkbenchDatabaseBackup(
  database: Database.Database,
  directory: string,
  diagnostic?: WorkbenchDatabaseDiagnostic,
  diagnosticEvent?: WorkbenchDatabaseDiagnosticObserver,
) {
  const startedAt = performance.now();
  const installedVersion = database.pragma("user_version", { simple: true }) as number;
  const id = randomUUID();
  const temporaryPath = path.join(directory, `${id}.partial`);
  const backupPath = path.join(directory, `${id}.sqlite3`);
  try {
    reportWorkbenchDatabaseDiagnostic(diagnostic, {
      source: "database", operation: "backup", phase: "pending", level: "info",
      detail: `${path.basename(database.name)}, schema: ${installedVersion}`,
      elapsedMs: null, progress: null,
    }, diagnosticEvent);
    await fs.mkdir(directory, { recursive: true });
    const reservation = await fs.open(temporaryPath, "wx", 0o600);
    await reservation.close();
    let reportedAt = startedAt;
    await database.backup(temporaryPath, {
      progress: ({ totalPages, remainingPages }) => {
        const now = performance.now();
        if (now - reportedAt >= 5_000) {
          const completed = totalPages - remainingPages;
          reportWorkbenchDatabaseDiagnostic(diagnostic, {
            source: "database", operation: "backup", phase: "progress", level: "info",
            detail: `${path.basename(database.name)}, ${Math.round(completed / totalPages * 100)}%, ${completed}/${totalPages} pages`,
            elapsedMs: now - startedAt,
            progress: { completed, total: totalPages, unit: "pages" },
          }, diagnosticEvent);
          reportedAt = now;
        }
        // Keep the driver's default page batch; this callback only observes.
        return 100;
      },
    });
    verifyBackup(
      temporaryPath,
      installedVersion,
      path.basename(database.name),
      diagnostic,
      diagnosticEvent,
    );
    const file = await fs.open(temporaryPath, "r+");
    try { await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporaryPath, backupPath);
    // Read-only WAL verification can leave empty sidecars beside the temporary copy.
    for (const suffix of ["-wal", "-shm"]) {
      try { await fs.unlink(`${temporaryPath}${suffix}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          reportWorkbenchDatabaseDiagnostic(diagnostic, {
            source: "database", operation: "backup scratch cleanup", phase: "warning", level: "warn",
            detail: `retained ${boundedMessage(temporaryPath + suffix)}: ${boundedMessage(error)}`,
            elapsedMs: null, progress: null,
          }, diagnosticEvent);
        }
      }
    }
    reportWorkbenchDatabaseDiagnostic(diagnostic, {
      source: "database", operation: "backup", phase: "completed", level: "info",
      detail: `${path.basename(database.name)}, schema: ${installedVersion}, checkpoint: ${id.slice(0, 8)}`,
      elapsedMs: performance.now() - startedAt, progress: null,
    }, diagnosticEvent);
    return backupPath;
  } catch (error) {
    throw new Error(`Database migration backup failed at ${boundedMessage(temporaryPath)}: ${boundedMessage(error)}`, { cause: error });
  }
}

function verifyBackup(
  filePath: string,
  version: number,
  databaseName = path.basename(path.dirname(filePath)),
  diagnostic?: WorkbenchDatabaseDiagnostic,
  diagnosticEvent?: WorkbenchDatabaseDiagnosticObserver,
) {
  const startedAt = performance.now();
  const detail = `${databaseName}, schema: ${version}, checkpoint: ${path.basename(filePath).slice(0, 8)}`;
  reportWorkbenchDatabaseDiagnostic(diagnostic, {
    source: "database", operation: "verify", phase: "pending", level: "info",
    detail, elapsedMs: null, progress: null,
  }, diagnosticEvent);
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
  reportWorkbenchDatabaseDiagnostic(diagnostic, {
    source: "database", operation: "verify", phase: "completed", level: "info",
    detail, elapsedMs: performance.now() - startedAt, progress: null,
  }, diagnosticEvent);
}

async function pruneBackups(
  directory: string,
  verifiedBackupPath: string,
  now: number,
  diagnostic?: WorkbenchDatabaseDiagnostic,
  diagnosticEvent?: WorkbenchDatabaseDiagnosticObserver,
) {
  const startedAt = performance.now();
  try {
    const backups = await readBackupInventory(directory);
    if (!backups.length) return;
    const verified = backups.find(backup => backup.filePath === verifiedBackupPath);
    if (!verified) throw new Error("Freshly verified checkpoint is missing from retention inventory.");
    const older = backups.filter(backup => backup.filePath !== verified.filePath);
    const second = older.find(backup => now - backup.modifiedAt <= ordinaryBackupAgeMs);
    const expired = older.filter(backup => backup !== second);
    const failedDirectory = path.join(directory, "failed-upgrades");
    const failed = await readBackupInventory(failedDirectory);
    const expiredFailed = failed.filter((backup, index) => (
      index >= 2 || now - backup.modifiedAt > failedUpgradeAgeMs
    ));
    const databaseName = path.basename(directory);
    const expiredCount = expired.length + expiredFailed.length;
    if (expiredCount) reportWorkbenchDatabaseDiagnostic(diagnostic, {
      source: "database", operation: "backup retention", phase: "pending", level: "info",
      detail: `${databaseName}, ${backups.length} checkpoints, ${failed.length} failed upgrades, ${expiredCount} expired`,
      elapsedMs: null, progress: null,
    }, diagnosticEvent);
    if (!expiredCount) return;
    // The caller just verified, synced and atomically published this checkpoint.
    // Historical schema generations have no equally fresh survivor and remain untouched.
    const survivor = await fs.lstat(verified.filePath);
    if (!survivor.isFile() || survivor.mtimeMs !== verified.modifiedAt) {
      throw new Error("Freshly verified checkpoint changed during cleanup.");
    }
    let removed = 0;
    for (const backup of [...expired, ...expiredFailed]) {
      const current = await fs.lstat(backup.filePath);
      if (!current.isFile() || current.mtimeMs !== backup.modifiedAt) continue;
      await fs.unlink(backup.filePath);
      for (const suffix of ["-wal", "-shm"]) {
        try { await fs.unlink(`${backup.filePath}${suffix}`); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      removed++;
    }
    reportWorkbenchDatabaseDiagnostic(diagnostic, {
      source: "database", operation: "backup retention", phase: "completed", level: "info",
      detail: `${databaseName}, ${backups.length} checkpoints, ${removed} removed`,
      elapsedMs: performance.now() - startedAt, progress: null,
    }, diagnosticEvent);
  } catch (error) {
    reportWorkbenchDatabaseDiagnostic(diagnostic, {
      source: "database", operation: "backup retention", phase: "warning", level: "warn",
      detail: `retained extra files in ${boundedMessage(directory)}: ${boundedMessage(error)}`,
      elapsedMs: null, progress: null,
    }, diagnosticEvent);
  }
}

export async function readWorkbenchDatabaseBackups(directory: string, diagnostic?: WorkbenchDatabaseDiagnostic) {
  const backups = await readBackupInventory(directory);
  for (const backup of backups) verifyBackup(backup.filePath, backup.version, undefined, diagnostic);
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
  let verifiedBackupPath: string | null = null;
  if (directory && installedVersion < targetVersion
    && database.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
    verifiedBackupPath = await preserveWorkbenchDatabaseBackup(
      database,
      directory,
      options.diagnostic,
      options.diagnosticEvent,
    );
    await options.beforeMigration?.(verifiedBackupPath);
  }
  const reportUpgrade = directory && installedVersion > 0 && installedVersion < targetVersion;
  const startedAt = performance.now();
  const detail = `${path.basename(database.name)}, ${installedVersion} -> ${targetVersion}`;
  if (reportUpgrade) reportWorkbenchDatabaseDiagnostic(options.diagnostic, {
    source: "database", operation: "migration", phase: "pending", level: "info",
    detail, elapsedMs: null, progress: null,
  }, options.diagnosticEvent);
  applyWorkbenchDatabaseSchema(database, schema, options);
  if (reportUpgrade) reportWorkbenchDatabaseDiagnostic(options.diagnostic, {
    source: "database", operation: "migration", phase: "completed", level: "info",
    detail, elapsedMs: performance.now() - startedAt, progress: null,
  }, options.diagnosticEvent);
  if (directory && verifiedBackupPath) {
    await pruneBackups(
      directory,
      verifiedBackupPath,
      (options.now ?? Date.now)(),
      options.diagnostic,
      options.diagnosticEvent,
    );
  }
}
