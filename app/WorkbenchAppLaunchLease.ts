/*
 * Exports:
 * - WorkbenchAppLaunchLeaseOptions: machine-scoped SQLite lease configuration. Keywords: app, singleton, SQLite, lifecycle.
 * - default WorkbenchAppLaunchLease: hold one OS-released exclusive app process lease. Keywords: app, process, lease, controller.
 */
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import resolveWorkbenchLibraryRoot from "./workbench-library-root.ts";

export interface WorkbenchAppLaunchLeaseOptions {
  databasePath?: string;
  workbenchLibraryRoot?: string;
}

function isLockContention(error: unknown) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function throwFailures(message: string, failures: unknown[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export default class WorkbenchAppLaunchLease {
  private database: Database.Database | null;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static async acquire(options: WorkbenchAppLaunchLeaseOptions = {}) {
    const workbenchLibraryRoot = resolveWorkbenchLibraryRoot(options.workbenchLibraryRoot);
    const databasePath = path.resolve(
      options.databasePath ?? path.join(workbenchLibraryRoot, "runtime", "app-launch.sqlite3"),
    );
    await fs.mkdir(path.dirname(databasePath), { recursive: true });

    const database = new Database(databasePath);
    database.pragma("busy_timeout = 0");
    try {
      database.exec("BEGIN EXCLUSIVE");
      return new WorkbenchAppLaunchLease(database);
    } catch (error) {
      database.close();
      if (isLockContention(error)) return null;
      throw error;
    }
  }

  async dispose() {
    const database = this.database;
    this.database = null;
    if (!database) return;

    const failures: unknown[] = [];
    try {
      database.exec("ROLLBACK");
    } catch (error) {
      failures.push(error);
    }
    try {
      database.close();
    } catch (error) {
      failures.push(error);
    }
    throwFailures("Workbench app lease release failed.", failures);
  }
}
