/*
 * No production exports. This worker owns the one better-sqlite3 connection, schema installation, readiness proof, and close boundary. Keywords: database, worker, sqlite, lifecycle.
 */
import { parentPort } from "node:worker_threads";

import Database from "better-sqlite3";

import type { WorkbenchDatabaseInventory, WorkbenchDatabaseRequest, WorkbenchDatabaseResponse } from "./workbench-database-protocol.ts";
import { installWorkbenchDatabaseSchema } from "./workbench-database-schema.ts";

if (!parentPort) throw new Error("Workbench database worker requires a parent port");

let database: Database.Database | null = null;

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function inventory(): WorkbenchDatabaseInventory {
  if (!database) throw new Error("Workbench database is not initialized");
  const rows = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return {
    tableNames: rows.map(({ name }) => name),
    schemaVersion: database.pragma("user_version", { simple: true }) as number,
  };
}

function proveReadWrite() {
  if (!database) throw new Error("Workbench database is not initialized");
  const sentinel = `workbench-readiness-${process.pid}`;
  database.transaction(() => {
    database!.prepare("INSERT INTO workbench_harnesses(id) VALUES (?)").run(sentinel);
    const row = database!.prepare("SELECT id FROM workbench_harnesses WHERE id = ?").get(sentinel) as { id: string } | undefined;
    if (row?.id !== sentinel) throw new Error("Workbench database readiness read did not return the committed sentinel");
    database!.prepare("DELETE FROM workbench_harnesses WHERE id = ?").run(sentinel);
  })();
}

function post(response: WorkbenchDatabaseResponse) {
  parentPort!.postMessage(response);
}

parentPort.on("message", (request: WorkbenchDatabaseRequest) => {
  try {
    if (request.type === "initialize") {
      if (database) throw new Error("Workbench database is already initialized");
      database = new Database(request.databasePath);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      installWorkbenchDatabaseSchema(database);
      proveReadWrite();
      post({ id: request.id, type: "ready", inventory: inventory() });
      return;
    }
    if (request.type === "getInventory") {
      post({ id: request.id, type: "inventory", inventory: inventory() });
      return;
    }
    if (request.type === "close") {
      database?.close();
      database = null;
      post({ id: request.id, type: "closed" });
      parentPort!.close();
    }
  } catch (error) {
    database?.close();
    database = null;
    post({ id: request.id, type: "failure", message: boundedError(error) });
  }
});
