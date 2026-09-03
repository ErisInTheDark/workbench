/*
 * Keywords: tests, concurrency, SQLite, temp, lease, lifecycle.
 * Exports:
 * - default ProjectTestRunCoordinator: serialize project test processes and own the stable test temp directory lifecycle.
 * - ProjectTestRunLease/ProjectTestRunCoordinatorOptions: expose the acquired temp root and injectable wait mechanics.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_TEMPORARY_ROOT = path.join(PROJECT_ROOT, ".workbench", "tmp");
const TEST_RUN_RETRY_MS = 250;
const WINDOWS_DIRECTORY_RETRY_MS = 50;
const WINDOWS_DIRECTORY_RETRIES = 5;

export interface ProjectTestRunLease {
  dispose(): Promise<void>;
  temporaryRootPath: string;
}

export interface ProjectTestRunCoordinatorOptions {
  databasePath?: string;
  onWait?: () => void;
  temporaryRootPath?: string;
  waitForRetry?: () => Promise<void>;
}

function isLockContention(error: unknown) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function waitForRetry() {
  return new Promise<void>((resolve) => setTimeout(resolve, TEST_RUN_RETRY_MS));
}

async function createDirectory(directoryPath: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.mkdir(directoryPath, { recursive: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= WINDOWS_DIRECTORY_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_DIRECTORY_RETRY_MS));
    }
  }
}

function throwFailures(message: string, failures: unknown[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export default class ProjectTestRunCoordinator {
  private readonly databasePath: string;
  private readonly onWait: () => void;
  private readonly temporaryRootPath: string;
  private readonly waitForRetry: () => Promise<void>;

  constructor(options: ProjectTestRunCoordinatorOptions = {}) {
    this.databasePath = options.databasePath
      ?? path.join(PROJECT_ROOT, ".workbench", "runtime", "test-runner-lock.sqlite3");
    this.temporaryRootPath = options.temporaryRootPath
      ?? path.join(PROJECT_TEMPORARY_ROOT, "tests");
    this.onWait = options.onWait ?? (() => console.log("Another Workbench test run is active; waiting for it to finish."));
    this.waitForRetry = options.waitForRetry ?? waitForRetry;
  }

  async acquire(): Promise<ProjectTestRunLease> {
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
    const database = new Database(this.databasePath);
    database.pragma("busy_timeout = 0");
    let acquired = false;
    let reportedWait = false;
    try {
      while (!acquired) {
        try {
          database.exec("BEGIN EXCLUSIVE");
          acquired = true;
        } catch (error) {
          if (!isLockContention(error)) throw error;
          if (!reportedWait) {
            reportedWait = true;
            this.onWait();
          }
          await this.waitForRetry();
        }
      }
      await fs.rm(this.temporaryRootPath, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
      await createDirectory(this.temporaryRootPath);
    } catch (error) {
      const failures = [error];
      if (acquired) {
        try {
          database.exec("ROLLBACK");
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
      try {
        database.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      throwFailures("Test-run acquisition and cleanup both failed.", failures);
      throw error;
    }

    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        const failures: unknown[] = [];
        try {
          await fs.rm(this.temporaryRootPath, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
        } catch (error) {
          failures.push(error);
        }
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
        disposed = true;
        throwFailures("Test-run cleanup and lease release both failed.", failures);
      },
      temporaryRootPath: this.temporaryRootPath,
    };
  }
}
