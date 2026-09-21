/*
 * Exports:
 * - WorkbenchServiceRepositoryOptions: service database location.
 * - WorkbenchServiceRepository (default): owns durable service state and typed network storage.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  compileWorkbenchDatabaseStatement, deleteRows, insertRow, selectRows, upsertRow,
  type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow,
} from "../../shared/database/workbench-database-statements.ts";
import migrateWorkbenchDatabase, { restoreWorkbenchDatabaseBackup } from "../../shared/database/workbench-database-migration.ts";
import recoverWorkbenchDatabase from "../../shared/database/recover-workbench-database.ts";
import { assertSchemaReleaseManifest } from "../../shared/database/schema/schema-release-manifest.ts";
import { serviceSchema, serviceTableInventory, serviceTables as tables } from "../../shared/state/workbench-service-schema.ts";
import serviceReleases from "../../shared/state/workbench-service-releases.ts";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";

export interface WorkbenchServiceRepositoryOptions {
  databasePath?: string;
}

export default class WorkbenchServiceRepository {
  readonly databasePath: string;
  private database: Database.Database | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly backups = new Set<Promise<void>>();

  constructor(options: WorkbenchServiceRepositoryOptions = {}) {
    this.databasePath = path.resolve(options.databasePath ?? path.join(resolveWorkbenchDataRoot(), "service", "service.sqlite3"));
  }

  get daemonId() {
    const identity = this.query(selectRows(tables.metadata))[0];
    if (!identity) throw new Error("Service identity has not been initialised.");
    return identity.daemon_id;
  }

  get wakeEnabled() {
    return this.query(selectRows(tables.wake))[0]?.enabled === 1;
  }

  get startupFailure() {
    return this.query(selectRows(tables.failure))[0]?.message ?? null;
  }

  async start(beforeMigration?: (backupPath: string) => void) {
    if (this.database || this.opening || this.closing) throw new Error("Service repository is already open or changing lifecycle.");
    const opening = this.open(beforeMigration);
    this.opening = opening;
    try { await opening; }
    finally { this.opening = null; }
  }

  private async open(beforeMigration?: (backupPath: string) => void) {
    assertSchemaReleaseManifest(serviceSchema, serviceReleases, "service");
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
    await recoverWorkbenchDatabase(this.databasePath, serviceSchema, beforeMigration);
    const database = new Database(this.databasePath);
    try {
      database.pragma("foreign_keys = ON");
      await migrateWorkbenchDatabase(database, serviceSchema, { beforeMigration });
      this.database = database;
      const initial: WorkbenchDatabaseMutation[] = [];
      if (!this.query(selectRows(tables.metadata)).length) initial.push(insertRow(tables.metadata, { id: "singleton", daemon_id: randomUUID() }));
      if (!this.query(selectRows(tables.wake)).length) initial.push(insertRow(tables.wake, { id: "singleton", enabled: 0 }));
      this.executeTransaction(initial);
    } catch (error) {
      this.database = null;
      database.close();
      throw error;
    }
  }

  close() {
    if (this.closing) return this.closing;
    const closing = (async () => {
      const failures: Error[] = [];
      try { await this.opening; }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      for (const result of await Promise.allSettled([...this.backups])) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      try { this.database?.close(); this.database = null; }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      if (failures.length) throw new AggregateError(failures, "Service database closure failed.");
    })().finally(() => { if (this.closing === closing) this.closing = null; });
    this.closing = closing;
    return closing;
  }

  async resume(backupPath?: string) {
    if (this.closing) await this.closing;
    if (this.database) return;
    if (backupPath) await restoreWorkbenchDatabaseBackup(backupPath, this.databasePath);
    await this.start();
  }

  async backupTo(destination: string) {
    if (this.closing) throw new Error("Service repository is closing.");
    const backup = this.requireDatabase().backup(destination).then(() => undefined)
      .finally(() => this.backups.delete(backup));
    this.backups.add(backup);
    await backup;
  }

  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row[] {
    const compiled = compileWorkbenchDatabaseStatement(serviceTableInventory, statement);
    return this.requireDatabase().prepare(compiled.sql).all(...compiled.parameters) as Row[];
  }

  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]) {
    const database = this.requireDatabase();
    return database.transaction(() => {
      let changes = 0;
      for (const statement of statements) {
        const compiled = compileWorkbenchDatabaseStatement(serviceTableInventory, statement);
        changes += database.prepare(compiled.sql).run(...compiled.parameters).changes;
      }
      return changes;
    })();
  }

  setWakeEnabled(enabled: boolean) {
    this.executeTransaction([upsertRow(tables.wake, { id: "singleton", enabled: enabled ? 1 : 0 }, {
      conflictColumns: ["id"], updateColumns: ["enabled"],
    })]);
  }

  requestDaemon(session: string) {
    if (!session) throw new Error("A supervision session is required.");
    this.executeTransaction([
      upsertRow(tables.intent, { id: "singleton", session_id: session }, {
        conflictColumns: ["id"], updateColumns: ["session_id"],
      }),
      deleteRows(tables.failure, { id: "singleton" }),
    ]);
  }

  shouldResume(session: string) {
    return this.startupFailure === null && this.query(selectRows(tables.intent))[0]?.session_id === session;
  }

  stopDaemon() {
    this.executeTransaction([
      deleteRows(tables.intent, { id: "singleton" }),
      deleteRows(tables.failure, { id: "singleton" }),
    ]);
  }

  failStartup(message: string) {
    this.executeTransaction([upsertRow(tables.failure, {
      id: "singleton", message: message.replace(/[\r\n]/gu, " ").slice(0, 512),
    }, { conflictColumns: ["id"], updateColumns: ["message"] })]);
  }

  private requireDatabase() {
    if (!this.database) throw new Error("Service database is not open.");
    return this.database;
  }
}
