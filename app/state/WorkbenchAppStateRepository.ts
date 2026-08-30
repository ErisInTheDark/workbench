/*
 * Exports:
 * - WorkbenchAppStateRepositoryOptions: app-state database path and clock seams. Keywords: app, state, SQLite, test.
 * - default WorkbenchAppStateRepository: own one app-state SQLite connection, schema, transactions, and local registration. Keywords: app, state, repository.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

import resolveWorkbenchLibraryRoot from "../workbench-library-root.ts";
import {
  appStateSchema,
  appStateTableInventory,
  appStateTables,
} from "workbench-shared/state/workbench-app-state-schema";
import { applyWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";

export interface WorkbenchAppStateRepositoryOptions {
  databasePath?: string;
  now?: () => number;
  workbenchLibraryRoot?: string;
}

export default class WorkbenchAppStateRepository {
  readonly databasePath: string;
  readonly #now: () => number;
  #database: Database.Database | null = null;
  #daemonRegistrationId: string | null = null;

  constructor(options: WorkbenchAppStateRepositoryOptions = {}) {
    const libraryRoot = resolveWorkbenchLibraryRoot(options.workbenchLibraryRoot);
    this.databasePath = path.resolve(options.databasePath ?? path.join(libraryRoot, "runtime", "app-state.sqlite3"));
    this.#now = options.now ?? Date.now;
  }

  get daemonRegistrationId() {
    if (!this.#daemonRegistrationId) throw new Error("Workbench app state is not ready.");
    return this.#daemonRegistrationId;
  }

  start() {
    if (this.#database) throw new Error("Workbench app state repository has already started.");
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const database = new Database(this.databasePath);
    try {
      database.pragma("foreign_keys = ON");
      applyWorkbenchDatabaseSchema(database, appStateSchema);
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
    const database = this.#database;
    this.#database = null;
    this.#daemonRegistrationId = null;
    database?.close();
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
