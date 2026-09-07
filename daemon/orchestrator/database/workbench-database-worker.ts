/*
 * No production exports. This worker owns the one better-sqlite3 connection, schema installation, search/stats/transcript repositories, readiness proof, and close boundary. Keywords: database, worker, sqlite, search, stats, transcript, lifecycle.
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
import WorkbenchThreadIdentityRepository from "./thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./transcript/WorkbenchTranscriptIdentityRepository.ts";
import WorkbenchThreadStateRelationalRepository from "./thread-state/WorkbenchThreadStateRelationalRepository.ts";
import WorkbenchSearchRepository from "./search/WorkbenchSearchRepository.ts";
import WorkbenchStatsRepository from "./stats/WorkbenchStatsRepository.ts";
import WorkbenchClaimStatsRepository from "./stats/WorkbenchClaimStatsRepository.ts";
import WorkbenchStatsImportRepository from "./stats/WorkbenchStatsImportRepository.ts";
import WorkbenchStatsAttributionRepository from "./stats/WorkbenchStatsAttributionRepository.ts";

if (!parentPort) throw new Error("Workbench database worker requires a parent port");

let database: Database.Database | null = null;
let transcriptRepository: WorkbenchTranscriptRepository | null = null;
let threadIdentityRepository: WorkbenchThreadIdentityRepository | null = null;
let transcriptIdentityRepository: WorkbenchTranscriptIdentityRepository | null = null;
let threadStateShadowRepository: WorkbenchThreadStateRelationalRepository | null = null;
let searchRepository: WorkbenchSearchRepository | null = null;
let statsRepository: WorkbenchStatsRepository | null = null;
let statsImportRepository: WorkbenchStatsImportRepository | null = null;
let statsAttributionRepository: WorkbenchStatsAttributionRepository | null = null;

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
  threadIdentityRepository = null;
  transcriptIdentityRepository = null;
  transcriptRepository = null;
  threadStateShadowRepository = null;
  searchRepository = null;
  statsRepository = null;
  statsImportRepository = null;
  statsAttributionRepository = null;
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
  if (request.type === "observeTurnIdentities") {
    if (!threadIdentityRepository) throw new Error("Workbench thread identity repository is not initialized");
    post({ id: request.id, type: "turnIdentities", identities: threadIdentityRepository.observeTurns(request.inputs) });
    return;
  }
  if (request.type === "resolveTurnIdentity") {
    if (!threadIdentityRepository) throw new Error("Workbench thread identity repository is not initialized");
    const identity = threadIdentityRepository.resolveTurn(request.input);
    post({ id: request.id, type: "turnIdentity", identity });
    return;
  }
  if (request.type === "admitTranscriptItemIdentities" || request.type === "resolveTranscriptItemIdentity") {
    if (!transcriptIdentityRepository) throw new Error("Workbench transcript identity repository is not initialized");
    if (request.type === "admitTranscriptItemIdentities") {
      post({ id: request.id, type: "transcriptItemIdentities", identities: transcriptIdentityRepository.admitMany(request.inputs) });
    } else {
      post({ id: request.id, type: "transcriptItemIdentity", identity: transcriptIdentityRepository.resolve(request.input) });
    }
    return;
  }
  if (request.type === "observeThreadIdentities") {
    if (!threadIdentityRepository) throw new Error("Workbench thread identity repository is not initialized");
    post({ id: request.id, type: "threadIdentities", identities: threadIdentityRepository.observeMany(request.inputs) });
    return;
  }
  if (request.type === "resolveThreadIdentity"
    || request.type === "resolveNativeThreadIdentity" || request.type === "listThreadIdentities") {
    if (!threadIdentityRepository) throw new Error("Workbench thread identity repository is not initialized");
    if (request.type === "listThreadIdentities") {
      post({ id: request.id, type: "threadIdentities", identities: threadIdentityRepository.list() });
    } else {
      const identity = request.type === "resolveThreadIdentity"
          ? threadIdentityRepository.resolve(request.input)
          : threadIdentityRepository.resolveNative(request.input);
      post({ id: request.id, type: "threadIdentity", identity });
    }
    return;
  }
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
  if (request.type === "replaceSearchProjects") {
    if (!searchRepository) throw new Error("Workbench search repository is not initialized");
    searchRepository.replaceProjects(request.projects);
    post({ id: request.id, type: "mutationResult", result: { changes: request.projects.length } });
    return;
  }
  if (request.type === "replaceSearchProjectFiles") {
    if (!searchRepository) throw new Error("Workbench search repository is not initialized");
    searchRepository.replaceProjectFiles(request.projectId, request.paths);
    post({ id: request.id, type: "mutationResult", result: { changes: request.paths.length } });
    return;
  }
  if (request.type === "search") {
    if (!searchRepository) throw new Error("Workbench search repository is not initialized");
    post({ id: request.id, type: "searchResult", result: searchRepository.search(request.request) });
    return;
  }
  if (request.type === "recordStatsClaimSnapshot") {
    if (!statsRepository) throw new Error("Workbench stats repository is not initialized");
    statsRepository.recordClaimSnapshot(request.snapshot);
    post({ id: request.id, type: "mutationResult", result: { changes: 1 } });
    return;
  }
  if (request.type === "recordStatsRateLimits") {
    if (!statsRepository) throw new Error("Workbench stats repository is not initialized");
    statsRepository.recordRateLimits(request.observation);
    post({ id: request.id, type: "mutationResult", result: { changes: 1 } });
    return;
  }
  if (request.type === "readStats") {
    if (!statsRepository) throw new Error("Workbench stats repository is not initialized");
    post({ id: request.id, type: "statsResult", result: statsRepository.read(request.request, request.now) });
    return;
  }
  if (request.type === "readStatsDetailed") {
    if (!statsRepository) throw new Error("Workbench stats repository is not initialized");
    post({ id: request.id, type: "statsDetailedResult", result: statsRepository.readDetailed(request.request, request.now) });
    return;
  }
  if (request.type === "readClaimStats") {
    if (!database) throw new Error("Workbench database is not initialized");
    post({ id: request.id, type: "claimStatsResult", result: new WorkbenchClaimStatsRepository(database).read(request.request, request.now) });
    return;
  }
  if (request.type === "beginStatsImport") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    statsImportRepository.beginUsage(request.runId, request.harnesses, request.now);
    post({ id: request.id, type: "statsImportProgress", progress: statsImportRepository.progress("running", 1, 0) });
    return;
  }
  if (request.type === "addStatsClaimDiscoveries") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    statsImportRepository.addClaimDiscoveries(request.runId, request.discoveries, request.now);
    post({ id: request.id, type: "statsImportProgress", progress: statsImportRepository.progress("running", 1, 0) });
    return;
  }
  if (request.type === "claimStatsUsageImport") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    post({ id: request.id, type: "statsUsageImportCandidate", candidate: statsImportRepository.claimUsage(request.runId, request.harnesses, request.now) });
    return;
  }
  if (request.type === "claimStatsClaimImport") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    post({ id: request.id, type: "statsClaimImportCandidate", candidate: statsImportRepository.claimClaims(request.runId, request.now) });
    return;
  }
  if (request.type === "settleStatsUsageImport") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    statsImportRepository.settleUsage(request.runId, request.candidate, request.settlement, request.now);
    post({ id: request.id, type: "statsImportProgress", progress: statsImportRepository.progress("running", 1, 0) });
    return;
  }
  if (request.type === "settleStatsClaimImport") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    statsImportRepository.settleClaims(request.runId, request.candidate, request.settlement, request.now);
    post({ id: request.id, type: "statsImportProgress", progress: statsImportRepository.progress("running", 1, 0) });
    return;
  }
  if (request.type === "repairStatsAttributions") {
    if (!statsAttributionRepository) throw new Error("Workbench stats attribution repository is not initialized");
    post({ id: request.id, type: "mutationResult", result: { changes: statsAttributionRepository.repair(request.now, request.threadId) } });
    return;
  }
  if (request.type === "readStatsImportProgress") {
    if (!statsImportRepository) throw new Error("Workbench stats import repository is not initialized");
    post({ id: request.id, type: "statsImportProgress", progress: statsImportRepository.progress(request.state, request.revision, request.unsupportedClaimCheckpoints) });
    return;
  }
  if (!database) throw new Error("Workbench database is not initialized");
  database.close();
  threadIdentityRepository = null;
  transcriptIdentityRepository = null;
  transcriptRepository = null;
  threadStateShadowRepository = null;
  searchRepository = null;
  statsRepository = null;
  statsImportRepository = null;
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
      threadIdentityRepository = new WorkbenchThreadIdentityRepository(database);
      transcriptIdentityRepository = new WorkbenchTranscriptIdentityRepository(database);
      transcriptRepository = new WorkbenchTranscriptRepository(database, threadIdentityRepository);
      threadStateShadowRepository = new WorkbenchThreadStateRelationalRepository(database, threadIdentityRepository, transcriptIdentityRepository);
      searchRepository = new WorkbenchSearchRepository(database);
      statsRepository = new WorkbenchStatsRepository(database);
      statsImportRepository = new WorkbenchStatsImportRepository(database);
      statsAttributionRepository = new WorkbenchStatsAttributionRepository(database);
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
