/*
 * Exports:
 * - WorkbenchAppStateRepositoryOptions: app-state database path and clock seams.
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

import migrateWorkbenchDatabase, { restoreWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import recoverWorkbenchDatabase from "workbench-shared/database/recover-workbench-database";
import {
    appStateSchema,
    appStateTableInventory,
    appStateTables,
} from "workbench-shared/state/workbench-app-state-schema";
import { assertSchemaReleaseManifest } from "workbench-shared/database/schema/schema-release-manifest";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import resolveWorkbenchRuntimeRoot from "../workbench-runtime-root.ts";
import { WorkbenchProjectRemapSchema, type WorkbenchProjectRemap } from "workbench-shared/state/workbench-client-state";
import type { WorkbenchProjectAlias } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

export interface WorkbenchAppStateRepositoryOptions {
  databasePath?: string;
  now?: () => number;
  repositoryRootPath?: string;
}

export default class WorkbenchAppStateRepository {
  readonly databasePath: string;
  readonly #now: () => number;
  #database: Database.Database | null = null;
  #daemonRegistrationId: string | null = null;
  #opening: Promise<string> | null = null;
  #closing: Promise<void> | null = null;
  readonly #backups = new Set<Promise<void>>();

  constructor(options: WorkbenchAppStateRepositoryOptions = {}) {
    const runtimeRoot = resolveWorkbenchRuntimeRoot(options.repositoryRootPath);
    this.databasePath = path.resolve(options.databasePath ?? path.join(runtimeRoot, "app-state.sqlite3"));
    this.#now = options.now ?? Date.now;
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
    await recoverWorkbenchDatabase(this.databasePath, appStateSchema, beforeMigration);
    const database = new Database(this.databasePath);
    try {
      database.pragma("foreign_keys = ON");
      await migrateWorkbenchDatabase(database, appStateSchema, { beforeMigration });
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

  readProjectAliases(): WorkbenchProjectAlias[] {
    return this.query(selectRows(appStateTables.projectAliases, {
      where: { daemon_registration_id: this.daemonRegistrationId },
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
    if (request.daemonRegistrationId !== this.daemonRegistrationId) throw new Error("Project remap belongs to another daemon registration.");
    const existing = new Map(this.readProjectAliases().map(alias => [alias.alias, alias.projectId]));
    const additions = new Map<string, WorkbenchProjectAlias>();
    for (const alias of request.aliases) {
      if (alias.alias === alias.projectId) continue;
      if (alias.projectId !== "workbench-library" && !/^(?:remote|local|workspace):\/\/.+$/u.test(alias.projectId)) {
        throw new Error("Project remap destination must be canonical.");
      }
      const prior = existing.get(alias.alias) ?? additions.get(alias.alias)?.projectId;
      if (prior && prior !== alias.projectId) throw new Error("Project alias conflicts with retained ownership.");
      if (!prior) additions.set(alias.alias, alias);
    }
    for (const alias of [...this.readProjectAliases(), ...additions.values()]) {
      if (existing.has(alias.projectId) || additions.has(alias.projectId)) throw new Error("Project aliases cannot form chains.");
    }
    if (!additions.size) return this.currentVersion().revision;
    const aliases = [...additions.values()];
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
            SELECT ${values} FROM "${table.name}" WHERE daemon_registration_id = ? AND project_id = ? AND deleted = 1`)
            .run(...parameters, request.daemonRegistrationId, alias.alias);
        }
      }
      return [
        ...aliases.map(alias => insertRow(appStateTables.projectAliases, {
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
