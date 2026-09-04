/*
 * No production exports. This worker owns the one better-sqlite3 connection, schema installation, readiness proof, and close boundary. Keywords: database, worker, sqlite, lifecycle.
 */
import { parentPort } from "node:worker_threads";

import Database from "better-sqlite3";

import type { WorkbenchDatabaseInventory, WorkbenchDatabaseRequest, WorkbenchDatabaseResponse } from "./workbench-database-protocol.ts";
import { installWorkbenchDatabaseSchema, workbenchDatabaseTables } from "./workbench-database-schema.ts";
import {
  compileWorkbenchDatabaseStatement,
  type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import WorkbenchTranscriptRepository from "./transcript/WorkbenchTranscriptRepository.ts";
import WorkbenchThreadStateRelationalRepository from "./thread-state/WorkbenchThreadStateRelationalRepository.ts";

if (!parentPort) throw new Error("Workbench database worker requires a parent port");

let database: Database.Database | null = null;
let transcriptRepository: WorkbenchTranscriptRepository | null = null;
let threadStateShadowRepository: WorkbenchThreadStateRelationalRepository | null = null;

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

function closeDatabase() {
  transcriptRepository = null;
  threadStateShadowRepository = null;
  const activeDatabase = database;
  database = null;
  if (!activeDatabase) return null;
  try {
    activeDatabase.close();
    return null;
  } catch (error) {
    return boundedError(error);
  }
}

function postFatalFailure(request: WorkbenchDatabaseRequest, error: unknown, context?: string) {
  const closeFailure = closeDatabase();
  const parts = [
    context,
    boundedError(error),
    closeFailure ? `Database close also failed: ${closeFailure}` : null,
  ].filter((part): part is string => Boolean(part));
  post({ id: request.id, type: "fatalFailure", message: parts.join(" ").slice(0, 1_000) });
}

function postRequestFailure(request: WorkbenchDatabaseRequest, error: unknown) {
  const requestMessage = boundedError(error);
  try {
    proveReadWrite();
    post({ id: request.id, type: "requestFailure", message: requestMessage });
  } catch (readinessError) {
    postFatalFailure(
      request,
      readinessError,
      `Database request failed (${requestMessage}) and the connection readiness proof also failed.`,
    );
  }
}

function executeTransaction(request: Extract<WorkbenchDatabaseRequest, { type: "executeTransaction" }>) {
  if (!database) throw new Error("Workbench database is not initialized");
  return database.transaction(() => {
    let changes = 0;
    for (const statement of request.statements) {
      const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
      changes += database!.prepare(compiled.sql).run(...compiled.parameters).changes;
    }
    return { changes };
  })();
}

function handleInitializedRequest(request: Exclude<WorkbenchDatabaseRequest, { type: "initialize" }>) {
  if (request.type === "getInventory") {
    post({ id: request.id, type: "inventory", inventory: inventory() });
    return;
  }
  if (request.type === "executeTransaction") {
    post({ id: request.id, type: "mutationResult", result: executeTransaction(request) });
    return;
  }
  if (request.type === "query") {
    if (!database) throw new Error("Workbench database is not initialized");
    const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, request.statement);
    const rows = database.prepare(compiled.sql).all(...compiled.parameters) as WorkbenchDatabaseRow[];
    post({ id: request.id, type: "queryResult", rows });
    return;
  }
  if (request.type === "rebuildThreadStateShadow") {
    if (!threadStateShadowRepository) throw new Error("Workbench thread-state shadow repository is not initialized");
    post({
      id: request.id,
      type: "threadStateShadowStatus",
      status: threadStateShadowRepository.rebuild(request.request),
    });
    return;
  }
  if (request.type === "readThreadStateShadowStatus") {
    if (!threadStateShadowRepository) throw new Error("Workbench thread-state shadow repository is not initialized");
    post({
      id: request.id,
      type: "threadStateShadowStatus",
      status: threadStateShadowRepository.readStatus(),
    });
    return;
  }
  if (request.type === "settleTranscript") {
    if (!transcriptRepository) throw new Error("Workbench transcript repository is not initialized");
    post({
      id: request.id,
      type: "transcriptSettlement",
      settlement: transcriptRepository.settle(request.observations),
    });
    return;
  }
  if (request.type === "readTranscript") {
    if (!transcriptRepository) throw new Error("Workbench transcript repository is not initialized");
    post({
      id: request.id,
      type: "transcriptSnapshot",
      snapshot: transcriptRepository.read(request.request),
    });
    return;
  }
  if (request.type === "readTranscriptMaterializedTurnIds") {
    if (!transcriptRepository) throw new Error("Workbench transcript repository is not initialized");
    post({
      id: request.id,
      type: "transcriptMaterializedTurnIds",
      turnIds: transcriptRepository.readMaterializedTurnIds(request.threadId, request.turnIds),
    });
    return;
  }
  if (!database) throw new Error("Workbench database is not initialized");
  database.close();
  transcriptRepository = null;
  threadStateShadowRepository = null;
  database = null;
  post({ id: request.id, type: "closed" });
  parentPort!.close();
}

parentPort.on("message", (request: WorkbenchDatabaseRequest) => {
  if (request.type === "initialize") {
    try {
      if (database) throw new Error("Workbench database is already initialized");
      database = new Database(request.databasePath);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      installWorkbenchDatabaseSchema(database);
      proveReadWrite();
      transcriptRepository = new WorkbenchTranscriptRepository(database);
      threadStateShadowRepository = new WorkbenchThreadStateRelationalRepository(database);
      post({ id: request.id, type: "ready", inventory: inventory() });
    } catch (error) {
      postFatalFailure(request, error, "Workbench database initialization failed.");
    }
    return;
  }
  try {
    handleInitializedRequest(request);
  } catch (error) {
    if (request.type === "close") postFatalFailure(request, error, "Workbench database close failed.");
    else postRequestFailure(request, error);
  }
});
