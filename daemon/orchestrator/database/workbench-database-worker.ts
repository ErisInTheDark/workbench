/*
 * No production exports. This worker owns the one better-sqlite3 connection, schema installation, domain repositories including proposal diff cache, readiness proof, and close boundary.
 */
import { parentPort } from "node:worker_threads";
import path from "node:path";

import Database from "better-sqlite3";

import type { WorkbenchDatabaseInventory, WorkbenchDatabaseRequest, WorkbenchDatabaseResponse } from "./workbench-database-protocol.ts";
import { validateWorkbenchDatabaseReleases, workbenchDatabaseSchema, workbenchDatabaseTables } from "./workbench-database-schema.ts";
import migrateWorkbenchDatabase, { restoreWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import recoverWorkbenchDatabase from "workbench-shared/database/recover-workbench-database";
import {
  compileWorkbenchDatabaseStatement,
  type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import WorkbenchTranscriptRepository from "./transcript/WorkbenchTranscriptRepository.ts";
import WorkbenchThreadIdentityRepository from "./thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./transcript/WorkbenchTranscriptIdentityRepository.ts";
import WorkbenchThreadStateRelationalRepository from "./thread-state/WorkbenchThreadStateRelationalRepository.ts";
import WorkbenchThreadStateMigration, { readThreadStateRelationshipSources } from "./thread-state/WorkbenchThreadStateMigration.ts";
import WorkbenchSubagentRelationshipRepository from "./thread-state/WorkbenchSubagentRelationshipRepository.ts";
import WorkbenchSearchRepository from "./search/WorkbenchSearchRepository.ts";
import WorkbenchTranscriptQueryRepository from "./transcript/WorkbenchTranscriptQueryRepository.ts";
import { TranscriptQueryError } from "./transcript/transcript-query-contract.ts";
import WorkbenchStatsRepository from "./stats/WorkbenchStatsRepository.ts";
import WorkbenchClaimStatsRepository from "./stats/WorkbenchClaimStatsRepository.ts";
import WorkbenchStatsImportRepository from "./stats/WorkbenchStatsImportRepository.ts";
import WorkbenchStatsAttributionRepository from "./stats/WorkbenchStatsAttributionRepository.ts";
import GitArcProposalDiffRepository from "./git/GitArcProposalDiffRepository.ts";

if (!parentPort) throw new Error("Workbench database worker requires a parent port");

let database: Database.Database | null = null;
let transcriptRepository: WorkbenchTranscriptRepository | null = null;
let threadIdentityRepository: WorkbenchThreadIdentityRepository | null = null;
let transcriptIdentityRepository: WorkbenchTranscriptIdentityRepository | null = null;
let threadStateRepository: WorkbenchThreadStateRelationalRepository | null = null;
let searchRepository: WorkbenchSearchRepository | null = null;
let statsRepository: WorkbenchStatsRepository | null = null;
let statsImportRepository: WorkbenchStatsImportRepository | null = null;
let statsAttributionRepository: WorkbenchStatsAttributionRepository | null = null;
let gitArcProposalDiffRepository: GitArcProposalDiffRepository | null = null;
let migrationAcknowledgement: { id: number; acknowledge(): void } | null = null;
let suspendedDatabase: { path: string; version: number } | null = null;

function initializeRepositories() {
  if (!database) throw new Error("Workbench database is not initialized");
  proveReadWrite();
  threadIdentityRepository = new WorkbenchThreadIdentityRepository(database);
  transcriptIdentityRepository = new WorkbenchTranscriptIdentityRepository(database);
  transcriptRepository = new WorkbenchTranscriptRepository(database, threadIdentityRepository);
  threadStateRepository = new WorkbenchThreadStateRelationalRepository(database, threadIdentityRepository);
  searchRepository = new WorkbenchSearchRepository(database);
  statsRepository = new WorkbenchStatsRepository(database);
  statsImportRepository = new WorkbenchStatsImportRepository(database);
  statsAttributionRepository = new WorkbenchStatsAttributionRepository(database);
  gitArcProposalDiffRepository = new GitArcProposalDiffRepository(database);
}

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
  threadStateRepository = null;
  searchRepository = null;
  statsRepository = null;
  statsImportRepository = null;
  statsAttributionRepository = null;
  const activeDatabase = database;
  if (!activeDatabase) return null;
  try {
    activeDatabase.close();
    database = null;
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

function handleInitializedRequest(request: Exclude<WorkbenchDatabaseRequest, { type: "initialize" | "acknowledgeMigration" | "suspend" | "resume" }>) {
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
  if (request.type === "readGitArcProposalDiff" || request.type === "writeGitArcProposalDiff") {
    if (!gitArcProposalDiffRepository) throw new Error("Git arc proposal diff repository is not initialized");
    if (request.type === "readGitArcProposalDiff") {
      post({ id: request.id, type: "gitArcProposalDiff", changes: gitArcProposalDiffRepository.read(request.identity) });
    } else {
      gitArcProposalDiffRepository.write(request.value, request.maxBytes);
      post({ id: request.id, type: "mutationResult", result: { changes: 1 } });
    }
    return;
  }
  if (request.type === "readTranscriptProviderCursor") {
    if (!transcriptRepository) throw new Error("Workbench transcript repository is not initialized");
    post({
      id: request.id, type: "transcriptProviderCursor",
      cursor: transcriptRepository.readProviderPreviousCursor(request.threadId, request.turnId),
    });
    return;
  }
  if (request.type === "readTranscriptContext") {
    if (!transcriptRepository) throw new Error("Workbench transcript repository is not initialized");
    post({ id: request.id, type: "transcriptContext", snapshot: transcriptRepository.readContext(request.threadId) });
    return;
  }
  if (request.type === "readThreadContextUsage") {
    if (!transcriptRepository) throw new Error("Workbench transcript repository is not initialized");
    post({ id: request.id, type: "threadContextUsage", snapshot: transcriptRepository.readContextUsage(request.threadId) });
    return;
  }
  switch (request.type) {
    case "readSubagents":
    case "readOwnedSubagents":
    case "reserveSubagent":
    case "activateSubagent":
    case "removeSubagent": {
      if (!database) throw new Error("Workbench database is not initialized");
      const repository = new WorkbenchSubagentRelationshipRepository(database);
      const response = database.transaction((): WorkbenchDatabaseResponse => {
        switch (request.type) {
          case "readSubagents": return { id: request.id, type: "subagents", records: repository.read(request.query) };
          case "readOwnedSubagents": return { id: request.id, type: "subagents", records: repository.getOwnedMany(request.parentThreadId, request.projectId, request.threadIds) };
          case "reserveSubagent": return { id: request.id, type: "subagentReservation", record: repository.reserve(request.record) };
          case "activateSubagent":
            repository.activate(request.parentThreadId, request.reservationId, request.record);
            return { id: request.id, type: "mutationResult", result: { changes: 1 } };
          case "removeSubagent": return {
            id: request.id, type: "mutationResult",
            result: { changes: repository.remove(request.parentThreadId, request.identifier) ? 1 : 0 },
          };
        }
      })();
      post(response);
      return;
    }
    case "readThreadStateProject":
    case "readThreadStateTitleHistories":
    case "writeThreadStateProject":
    case "readThreadStateGlobal":
    case "writeThreadStateGlobal":
    case "readThreadStateRecords":
    case "readThreadStateDrafts":
    case "readThreadStateProfile":
    case "readThreadStateLayout":
    case "readThreadStatePinnedImports":
    case "readThreadStateArchiveDeadline":
    case "readThreadStateArchiveEligible":
    case "readThreadStateActivity":
    case "readThreadStateSnoozeSources":
    case "commitThreadState": {
      if (!database || !threadStateRepository) throw new Error("Workbench thread state is not initialized");
      const repository = threadStateRepository;
      const response = database.transaction((): WorkbenchDatabaseResponse => {
        switch (request.type) {
          case "readThreadStateProject": return { id: request.id, type: "threadStateProject", document: repository.readProject(request.projectId) };
          case "readThreadStateTitleHistories": return { id: request.id, type: "threadStateTitleHistories", histories: repository.readTitleHistories(request.projectId) };
          case "readThreadStateGlobal": return { id: request.id, type: "threadStateGlobal", document: repository.readGlobal(request.documentId) };
          case "writeThreadStateProject":
            repository.writeProject(request.projectId, request.document, request.titleHistories);
            return { id: request.id, type: "mutationResult", result: { changes: 1 } };
          case "writeThreadStateGlobal":
            repository.writeGlobal(request.document);
            return { id: request.id, type: "mutationResult", result: { changes: 1 } };
          case "readThreadStateRecords": return { id: request.id, type: "threadStateRecords", records: repository.readRecords(request.query) };
          case "readThreadStateDrafts": return { id: request.id, type: "threadStateDrafts", drafts: repository.readDrafts(request.projectId) };
          case "readThreadStateProfile": return { id: request.id, type: "threadStateProfile", profile: repository.readProjectProfile(request.projectId) };
          case "readThreadStateLayout": return { id: request.id, type: "threadStateLayout", layout: repository.readLayout(request.owner) };
          case "readThreadStatePinnedImports": return { id: request.id, type: "threadStatePinnedImports", projectIds: repository.readPinnedImports() };
          case "readThreadStateArchiveDeadline": return { id: request.id, type: "threadStateArchiveDeadline", activeAt: repository.readNextArchiveEligibility() };
          case "readThreadStateArchiveEligible": return { id: request.id, type: "threadStateArchiveEligible", records: repository.readArchiveEligible(request.activeBefore) };
          case "readThreadStateActivity": return { id: request.id, type: "threadStateActivity", activityAt: repository.readProjectActivity(request.projectId) };
          case "readThreadStateSnoozeSources": return { id: request.id, type: "threadStateSnoozeSources", sources: repository.readSnoozeSources(request.targetThreadId) };
          case "commitThreadState":
            repository.commit(request.changes);
            return { id: request.id, type: "mutationResult", result: { changes: 1 } };
        }
      })();
      post(response);
      return;
    }
  }
  if (request.type === "queryTranscript") {
    if (!database) throw new Error("Workbench database is not initialized");
    try {
      post({ id: request.id, type: "transcriptQueryResult", result: { ok: true, page: new WorkbenchTranscriptQueryRepository(database).read(request.request) } });
    } catch (error) {
      if (!(error instanceof TranscriptQueryError)) throw error;
      post({ id: request.id, type: "transcriptQueryResult", result: { ok: false, error: error.message } });
    }
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
    post({ id: request.id, type: "statsResult", result: statsRepository.read(request.request, request.now, request.renames) });
    return;
  }
  if (request.type === "readStatsDetailed") {
    if (!statsRepository) throw new Error("Workbench stats repository is not initialized");
    post({ id: request.id, type: "statsDetailedResult", result: statsRepository.readDetailed(request.request, request.now, request.renames) });
    return;
  }
  if (request.type === "readClaimStats") {
    if (!database) throw new Error("Workbench database is not initialized");
    post({ id: request.id, type: "claimStatsResult", result: new WorkbenchClaimStatsRepository(database).read(request.request, request.now, request.renames) });
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
  const closeFailure = closeDatabase();
  if (closeFailure) throw new Error(closeFailure);
  suspendedDatabase = null;
  post({ id: request.id, type: "closed" });
  parentPort!.close();
}

parentPort.on("message", async (request: WorkbenchDatabaseRequest) => {
  if (request.type === "suspend" || request.type === "resume") {
    try {
      if (request.type === "suspend") {
        if (!database || suspendedDatabase) throw new Error("Database cannot suspend from its current state.");
        suspendedDatabase = { path: database.name, version: inventory().schemaVersion };
        const closeFailure = closeDatabase();
        if (closeFailure) throw new Error(closeFailure);
        post({ id: request.id, type: "suspended" });
      } else {
        const suspended = suspendedDatabase;
        if (!suspended || database) throw new Error("Database has no suspended connection to resume.");
        if (request.restoreBackupPath) await restoreWorkbenchDatabaseBackup(request.restoreBackupPath, suspended.path);
        database = new Database(suspended.path, { fileMustExist: true });
        database.pragma("foreign_keys = ON");
        database.pragma("journal_mode = WAL");
        if (inventory().schemaVersion !== suspended.version) throw new Error("Database rollback did not restore the old worker's schema.");
        initializeRepositories();
        suspendedDatabase = null;
        post({ id: request.id, type: "ready", inventory: inventory() });
      }
    } catch (error) {
      if (request.type === "resume" && suspendedDatabase) {
        const closeFailure = closeDatabase();
        if (closeFailure) {
          postFatalFailure(request, error, `Database rollback connection close failed: ${closeFailure}`);
        } else {
          post({
            id: request.id,
            type: "requestFailure",
            message: `Workbench database rollback failed: ${boundedError(error)}`.slice(0, 1_000),
          });
        }
      } else {
        postFatalFailure(request, error, "Workbench database handoff failed.");
      }
    }
    return;
  }
  if (request.type === "acknowledgeMigration") {
    const pending = migrationAcknowledgement;
    if (!pending || pending.id !== request.id) {
      postFatalFailure(request, new Error("Unexpected database migration acknowledgement."));
      return;
    }
    migrationAcknowledgement = null;
    pending.acknowledge();
    return;
  }
  if (request.type === "initialize") {
    try {
      if (database) throw new Error("Workbench database is already initialized");
      validateWorkbenchDatabaseReleases();
      const acknowledgeCheckpoint = async (backupPath: string) => {
        if (request.acknowledgeMigration) await new Promise<void>((acknowledge) => {
          migrationAcknowledgement = { id: request.id, acknowledge };
          post({ id: request.id, type: "migrationCheckpoint", backupPath });
        });
      };
      await recoverWorkbenchDatabase(request.databasePath, workbenchDatabaseSchema, acknowledgeCheckpoint);
      database = new Database(request.databasePath);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      const connection = database;
      const threadStateMigration = workbenchDatabaseSchema.currentTables.some(table => table.name === "workbench_thread_state_import")
        ? new WorkbenchThreadStateMigration(connection) : null;
      let threadStateChecked = false;
      const convertThreadState = async () => {
        if (!threadStateMigration) return;
        const relationships = threadStateMigration.requiresImport()
          ? await readThreadStateRelationshipSources(path.join(path.dirname(request.databasePath), "runtime"))
          : [];
        threadStateMigration.run(workbenchDatabaseSchema, relationships, Date.now());
        threadStateChecked = true;
      };
      // A fresh database has no rollback source. Establish the whole domain in
      // its first schema transaction, rather than installing empty serving tables.
      if (threadStateMigration && !connection.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        await convertThreadState();
      }
      await migrateWorkbenchDatabase(database, workbenchDatabaseSchema, {
        beforeMigration: async (backupPath) => {
          await acknowledgeCheckpoint(backupPath);
          // The existing owner has verified and acknowledged its backup before
          // this source conversion is allowed to retire any legacy facts.
          await convertThreadState();
        },
      });
      if (!threadStateChecked) await convertThreadState();
      initializeRepositories();
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
