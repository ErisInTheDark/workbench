/*
 * Exports:
 * - WorkbenchAppStateRepositoryOptions: app-state data root, database path, and clock seams.
 * - default WorkbenchAppStateRepository: own app-state SQLite recovery, connection, transactions, and local registration.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import {
    compileWorkbenchDatabaseStatement,
    insertRow,
    selectRows,
    updateRows,
    type WorkbenchDatabaseMutation,
    type WorkbenchDatabaseQuery,
    type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";

import migrateWorkbenchDatabase, {
  restoreWorkbenchDatabaseBackup, type WorkbenchDatabaseDiagnostic,
} from "workbench-shared/database/workbench-database-migration";
import recoverWorkbenchDatabase from "workbench-shared/database/recover-workbench-database";
import {
    appStateSchema,
    appStateTableInventory,
    appStateTables,
} from "workbench-shared/state/workbench-app-state-schema";
import { assertSchemaReleaseManifest } from "workbench-shared/database/schema/schema-release-manifest";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import { WorkbenchProjectRemapSchema, type WorkbenchProjectRemap } from "workbench-shared/state/workbench-client-state";
import type { WorkbenchProjectAlias } from "workbench-shared/types";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { composeProjectAliases } from "workbench-shared/workbench/project/project-aliases";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

export interface WorkbenchAppStateRepositoryOptions {
  dataRootPath?: string;
  databasePath?: string;
  diagnostic?: WorkbenchDatabaseDiagnostic;
  now?: () => number;
}

export default class WorkbenchAppStateRepository {
  readonly databasePath: string;
  readonly #now: () => number;
  #diagnostic: WorkbenchDatabaseDiagnostic | undefined;
  #database: Database.Database | null = null;
  #daemonRegistrationId: string | null = null;
  #opening: Promise<string> | null = null;
  #closing: Promise<void> | null = null;
  readonly #backups = new Set<Promise<void>>();

  constructor(options: WorkbenchAppStateRepositoryOptions = {}) {
    const dataRootPath = options.dataRootPath ?? resolveWorkbenchDataRoot();
    this.databasePath = path.resolve(options.databasePath ?? path.join(dataRootPath, "app", "app-state.sqlite3"));
    this.#now = options.now ?? Date.now;
    this.#diagnostic = options.diagnostic;
  }

  configureDiagnostics(diagnostic: WorkbenchDatabaseDiagnostic) {
    if (this.#database || this.#opening) throw new Error("App database diagnostics must be configured before opening.");
    this.#diagnostic = diagnostic;
  }

  get daemonRegistrationId() {
    if (!this.#daemonRegistrationId) throw new Error("Workbench app state is not ready.");
    return this.#daemonRegistrationId;
  }

  async start(beforeMigration?: (backupPath: string) => void) {
    if (this.#database || this.#opening) throw new Error("Workbench app state repository has already started.");
    const opening = this.#open(beforeMigration);
    this.#opening = opening;
    try { return await opening; }
    finally { this.#opening = null; }
  }

  async #open(beforeMigration?: (backupPath: string) => void) {
    assertSchemaReleaseManifest(appStateSchema, appStateReleases, "app");
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    await recoverWorkbenchDatabase(this.databasePath, appStateSchema, beforeMigration, this.#diagnostic);
    const database = new Database(this.databasePath);
    try {
      database.pragma("foreign_keys = ON");
      await migrateWorkbenchDatabase(database, appStateSchema, { beforeMigration, diagnostic: this.#diagnostic });
      this.#database = database;
      this.#ensureMetadataAndRegistration();
      return this.daemonRegistrationId;
    } catch (error) {
      database.close();
      this.#database = null;
      throw error;
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    const closing = (async () => {
      const failures: unknown[] = [];
      try { await this.#opening; } catch (error) { failures.push(error); }
      for (const result of await Promise.allSettled([...this.#backups])) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      const database = this.#database;
      try {
        database?.close();
        this.#database = null;
        this.#daemonRegistrationId = null;
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "App database closure failed.");
    })().finally(() => { if (this.#closing === closing) this.#closing = null; });
    this.#closing = closing;
    return closing;
  }

  async resume(backupPath?: string) {
    if (this.#closing) await this.#closing;
    if (this.#database) return this.daemonRegistrationId;
    if (backupPath) await restoreWorkbenchDatabaseBackup(backupPath, this.databasePath);
    return await this.start();
  }

  async backupTo(destinationPath: string): Promise<void> {
    if (this.#closing) throw new Error("Workbench app state repository is closing.");
    const backup = this.#requireDatabase().backup(destinationPath).then(() => undefined)
      .finally(() => { this.#backups.delete(backup); });
    this.#backups.add(backup);
    await backup;
  }

  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]) {
    const database = this.#requireDatabase();
    if (statements.length === 0) return 0;
    return database.transaction(() => this.#execute(statements))();
  }

  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row[] {
    const compiled = compileWorkbenchDatabaseStatement(appStateTableInventory, statement);
    return this.#requireDatabase().prepare(compiled.sql).all(...compiled.parameters) as Row[];
  }

  currentVersion() {
    const row = this.query(selectRows(appStateTables.appStateMetadata, {
      where: { id: "singleton" },
    }))[0];
    if (!row) throw new Error("Workbench app state metadata is missing.");
    return {
      oldestAvailableRevision: row.oldest_available_revision,
      revision: row.revision,
    };
  }

  readDaemonRegistrations() {
    return this.query(selectRows(appStateTables.daemonRegistrations)).map(row => ({
      id: row.id, kind: row.kind,
      daemonId: row.durable_daemon_id === null ? null : DaemonIdSchema.parse(row.durable_daemon_id),
    }));
  }

  registerDaemon(daemonId: string, attachedLocal: boolean) {
    const durableId = DaemonIdSchema.parse(daemonId);
    const existing = this.query(selectRows(appStateTables.daemonRegistrations, {
      where: { durable_daemon_id: durableId },
      limit: 1,
    }))[0];
    if (!attachedLocal) {
      if (existing) return existing.id;
      const id = randomUUID();
      this.commit(revision => [insertRow(appStateTables.daemonRegistrations, {
        id, kind: "remote", durable_daemon_id: durableId, created_at: this.#now(), revision,
      })]);
      return id;
    }
    const local = this.query(selectRows(appStateTables.daemonRegistrations, {
      where: { kind: "local" }, limit: 1,
    }))[0];
    if (!local) throw new Error("Local daemon registration is missing.");
    if (local.durable_daemon_id === durableId) return local.id;
    if (local.durable_daemon_id === null && existing) {
      throw new Error("Unbound legacy local state conflicts with an existing daemon registration.");
    }
    if (local.durable_daemon_id === null) {
      this.commit(revision => [updateRows(appStateTables.daemonRegistrations, {
        durable_daemon_id: durableId, revision,
      }, { id: local.id })]);
      return local.id;
    }
    const nextId = existing?.id ?? randomUUID();
    this.commit(revision => [
      updateRows(appStateTables.daemonRegistrations, { kind: "remote", revision }, { id: local.id }),
      existing
        ? updateRows(appStateTables.daemonRegistrations, { kind: "local", revision }, { id: existing.id })
        : insertRow(appStateTables.daemonRegistrations, {
          id: nextId, kind: "local", durable_daemon_id: durableId,
          created_at: this.#now(), revision,
        }),
    ]);
    this.#daemonRegistrationId = nextId;
    return nextId;
  }

  readProjectAliases(daemonRegistrationId = this.daemonRegistrationId): WorkbenchProjectAlias[] {
    return this.query(selectRows(appStateTables.projectAliases, {
      where: { daemon_registration_id: daemonRegistrationId },
    })).map(row => ({ alias: row.alias, projectId: ProjectIdSchema.parse(row.project_id) }));
  }

  resolveProjectId(daemonRegistrationId: string, projectId: string) {
    return this.query(selectRows(appStateTables.projectAliases, {
      where: { daemon_registration_id: daemonRegistrationId, alias: projectId },
    }))[0]?.project_id ?? projectId;
  }

  remapProjects(
    input: WorkbenchProjectRemap,
    build: (aliases: readonly WorkbenchProjectAlias[], revision: number) => readonly WorkbenchDatabaseMutation[],
  ) {
    const request = WorkbenchProjectRemapSchema.parse(input);
    if (!this.query(selectRows(appStateTables.daemonRegistrations, {
      where: { id: request.daemonRegistrationId }, limit: 1,
    })).length) throw new Error("Project remap belongs to an unknown daemon registration.");
    const existing = this.readProjectAliases(request.daemonRegistrationId);
    const { changes: aliases } = composeProjectAliases(existing, request.aliases);
    if (!aliases.length) return this.currentVersion().revision;
    return this.commit(revision => {
      const mutations = build(aliases, revision);
      // Deleted parents have no children. Preserve their canonical tombstones too,
      // without passing empty deleted payloads through live-record constructors.
      for (const table of appStateSchema.currentTables) {
        if (!("project_id" in table.columns) || !("deleted" in table.columns) || table.name === "last_launch_target") continue;
        const names = Object.keys(table.columns);
        const columns = names.map(name => `"${name}"`).join(", ");
        const values = names.map(name => name === "project_id" || name === "revision" ? "?" : `"${name}"`).join(", ");
        for (const alias of aliases) {
          const parameters = names.flatMap<string | number>(name => name === "project_id" ? [alias.projectId] : name === "revision" ? [revision] : []);
          this.#requireDatabase().prepare(`INSERT INTO "${table.name}" (${columns})
            SELECT ${values} FROM "${table.name}" WHERE daemon_registration_id = ? AND project_id = ? AND deleted = 1
            ON CONFLICT DO NOTHING`)
            .run(...parameters, request.daemonRegistrationId, alias.alias);
        }
      }
      return [
        ...aliases.map(alias => existing.some(item => item.alias === alias.alias)
          ? updateRows(appStateTables.projectAliases, { project_id: alias.projectId }, {
            daemon_registration_id: request.daemonRegistrationId, alias: alias.alias,
          })
          : insertRow(appStateTables.projectAliases, {
            daemon_registration_id: request.daemonRegistrationId, alias: alias.alias, project_id: alias.projectId,
          })),
        ...mutations,
      ];
    });
  }

  commit(build: (revision: number) => readonly WorkbenchDatabaseMutation[]) {
    const database = this.#requireDatabase();
    return database.transaction(() => {
      const row = this.query(selectRows(appStateTables.appStateMetadata, {
        where: { id: "singleton" },
      }))[0];
      if (!row) throw new Error("Workbench app state metadata is missing.");
      const revision = row.revision + 1;
      this.#execute([
        ...build(revision),
        updateRows(appStateTables.appStateMetadata, { revision }, { id: "singleton" }),
      ]);
      return revision;
    })();
  }

  #ensureMetadataAndRegistration() {
    const metadata = this.query(selectRows(appStateTables.appStateMetadata, {
      where: { id: "singleton" },
    }))[0];
    if (!metadata) {
      this.executeTransaction([insertRow(appStateTables.appStateMetadata, {
        id: "singleton",
        oldest_available_revision: 0,
        revision: 0,
      })]);
    }
    const existing = this.query(selectRows(appStateTables.daemonRegistrations, {
      where: { kind: "local" },
      limit: 1,
    }))[0];
    if (existing) {
      this.#daemonRegistrationId = existing.id;
      return;
    }
    const id = randomUUID();
    this.commit((revision) => [
      insertRow(appStateTables.daemonRegistrations, {
        created_at: this.#now(),
        id,
        kind: "local",
        durable_daemon_id: null,
        revision,
      }),
    ]);
    this.#daemonRegistrationId = id;
  }

  #execute(statements: readonly WorkbenchDatabaseMutation[]) {
    const database = this.#requireDatabase();
    return statements.reduce((changes, statement) => {
      const compiled = compileWorkbenchDatabaseStatement(appStateTableInventory, statement);
      return changes + database.prepare(compiled.sql).run(...compiled.parameters).changes;
    }, 0);
  }

  #requireDatabase() {
    if (!this.#database) throw new Error("Workbench app state repository is closed.");
    return this.#database;
  }
}
