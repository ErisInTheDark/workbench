/*
 * Exports:
 * - default recoverWorkbenchDatabase: recover an exact-schema checkpoint before the serving connection opens.
 */
import type { WorkbenchDatabaseSchema } from "./schema/schema-history.ts";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  preserveWorkbenchDatabaseBackup, readWorkbenchDatabaseBackups, reportWorkbenchDatabaseDiagnostic,
  restoreWorkbenchDatabaseBackup, type WorkbenchDatabaseDiagnostic,
} from "./workbench-database-migration.ts";

export default async function recoverWorkbenchDatabase(
  databasePath: string,
  schema: WorkbenchDatabaseSchema,
  beforeRestore?: (archivePath: string) => void | Promise<void>,
  diagnostic?: WorkbenchDatabaseDiagnostic,
) {
  if (databasePath === ":memory:") return;
  try { await fs.stat(databasePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // The caller owns exclusive startup/handoff admission. No serving connection
  // may remain open when the checkpoint is restored.
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let checkpoint: string;
  let archive: string;
  let installedVersion: number;
  try {
    installedVersion = database.pragma("user_version", { simple: true }) as number;
    if (installedVersion <= schema.currentVersion) return;
    const directory = path.join(path.dirname(path.resolve(databasePath)), "backups", path.basename(databasePath));
    const backups = await readWorkbenchDatabaseBackups(directory, diagnostic);
    const matching = backups.find(backup => backup.version === schema.currentVersion);
    if (!matching) {
      throw new Error(`Database schema ${installedVersion} requires a matching schema ${schema.currentVersion} rollback checkpoint; the active database was not replaced.`);
    }
    checkpoint = matching.filePath;
    archive = await preserveWorkbenchDatabaseBackup(database, path.join(directory, "failed-upgrades"), diagnostic);
    await beforeRestore?.(archive);
  } finally { database.close(); }
  await restoreWorkbenchDatabaseBackup(checkpoint, databasePath);
  const safePath = archive.replace(/[\r\n]/g, " ").slice(0, 500);
  reportWorkbenchDatabaseDiagnostic(diagnostic, "info",
    `[database] restored schema ${schema.currentVersion} from schema ${installedVersion}; failed-upgrade archive ${safePath}`);
}
