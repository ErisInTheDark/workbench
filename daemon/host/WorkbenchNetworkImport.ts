/*
 * Exports:
 * - default WorkbenchNetworkImport: import legacy network state from an isolated SQLite backup.
 */
import Database from "better-sqlite3";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WorkbenchAppStateRepository from "../../app/server/state/WorkbenchAppStateRepository.ts";
import WorkbenchNetworkRepository from "./network/WorkbenchNetworkRepository.ts";
import { insertRow, selectRows } from "../../shared/database/workbench-database-statements.ts";
import { serviceTables } from "../../shared/state/workbench-service-schema.ts";
import type WorkbenchServiceRepository from "./WorkbenchServiceRepository.ts";

export default class WorkbenchNetworkImport {
  constructor(private readonly service: WorkbenchServiceRepository) {}

  async run(source: string) {
    if (this.service.query(selectRows(serviceTables.imported)).length) return;
    const receipt = insertRow(serviceTables.imported, { id: "singleton", source, imported_at: Date.now() });
    try { await stat(source); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // A later-created app database must never overwrite independently configured service state.
        this.service.executeTransaction([receipt]);
        return;
      }
      throw error;
    }
    const original = new Database(source, { readonly: true, fileMustExist: true });
    let directory: string | undefined;
    let copy: WorkbenchAppStateRepository | undefined;
    try {
      directory = await mkdtemp(path.join(tmpdir(), "workbench-network-import-"));
      const snapshot = path.join(directory, "app.sqlite3");
      copy = new WorkbenchAppStateRepository({ databasePath: snapshot });
      try { await original.backup(snapshot); }
      finally { original.close(); }
      await copy.start();
      const configuration = new WorkbenchNetworkRepository(copy).read();
      new WorkbenchNetworkRepository(this.service).write(configuration, [receipt]);
    } finally {
      if (original.open) original.close();
      await copy?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
