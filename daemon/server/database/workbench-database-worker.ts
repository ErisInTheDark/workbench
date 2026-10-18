/*
 * No production exports. This worker owns the SQLite connection, schema installation, pre-cache project recovery, domain repositories,
 * readiness proof, registered request dispatch, and close boundary.
 */
import { parentPort } from "node:worker_threads";
import path from "node:path";

import Database from "better-sqlite3";

import {
  isWorkbenchDatabaseReadRequest,
  type WorkbenchDatabaseInventory,
  type WorkbenchDatabaseRequest,
  type WorkbenchDatabaseResponse,
  type WorkbenchDatabaseWorkerMessage,
} from "./workbench-database-protocol.ts";
import { getWorkbenchDatabaseRequest } from "./workbench-database-requests.ts";
import type { WorkbenchDatabaseWorkerContext } from "./requests/define-database-request.ts";
import { validateWorkbenchDatabaseReleases, workbenchDatabaseSchema } from "./workbench-database-schema.ts";
import migrateWorkbenchDatabase, { restoreWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import recoverWorkbenchDatabase from "workbench-shared/database/recover-workbench-database";
import WorkbenchTranscriptRepository from "./transcript/WorkbenchTranscriptRepository.ts";
import WorkbenchTranscriptTimestampRepair from "./transcript/WorkbenchTranscriptTimestampRepair.ts";
import WorkbenchThreadIdentityRepository from "./thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./transcript/WorkbenchTranscriptIdentityRepository.ts";
import WorkbenchThreadStateRelationalRepository from "./thread-state/WorkbenchThreadStateRelationalRepository.ts";
import WorkbenchThreadStateIntegrity from "./thread-state/WorkbenchThreadStateIntegrity.ts";
import WorkbenchSearchRepository from "./search/WorkbenchSearchRepository.ts";
import WorkbenchStatsRepository from "./stats/WorkbenchStatsRepository.ts";
import WorkbenchStatsImportRepository from "./stats/WorkbenchStatsImportRepository.ts";
import WorkbenchStatsAttributionRepository from "./stats/WorkbenchStatsAttributionRepository.ts";
import GitArcProposalDiffRepository from "./git/GitArcProposalDiffRepository.ts";
import WorkbenchProjectRepository from "./project/WorkbenchProjectRepository.ts";
import WorkbenchThreadLaunchRepository from "./thread-launch/WorkbenchThreadLaunchRepository.ts";
import WorkbenchProjectIdentityMigration from "./project/WorkbenchProjectIdentityMigration.ts";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import WorkbenchExternalStorageMigration from "./WorkbenchExternalStorageMigration.ts";
import WorkbenchTranscriptRetentionRepository from "./retention/WorkbenchTranscriptRetentionRepository.ts";
import type { WorkbenchProjectStartup } from "./project/workbench-project-persistence.ts";
import {
  WorkbenchDatabaseDiagnosticEventSchema,
  type WorkbenchDatabaseDiagnosticEvent,
} from "workbench-shared/database/workbench-database-diagnostic";

if (!parentPort) throw new Error("Workbench database worker requires a parent port");

let database: Database.Database | null = null;
let readOnly = false;
let projectRepository: WorkbenchProjectRepository | null = null;
let threadLaunchRepository: WorkbenchThreadLaunchRepository | null = null;
let transcriptRepository: WorkbenchTranscriptRepository | null = null;
let threadIdentityRepository: WorkbenchThreadIdentityRepository | null = null;
let transcriptIdentityRepository: WorkbenchTranscriptIdentityRepository | null = null;
let threadStateRepository: WorkbenchThreadStateRelationalRepository | null = null;
let searchRepository: WorkbenchSearchRepository | null = null;
let statsRepository: WorkbenchStatsRepository | null = null;
let statsImportRepository: WorkbenchStatsImportRepository | null = null;
let statsAttributionRepository: WorkbenchStatsAttributionRepository | null = null;
let gitArcProposalDiffRepository: GitArcProposalDiffRepository | null = null;
let transcriptRetentionRepository: WorkbenchTranscriptRetentionRepository | null = null;
let migrationAcknowledgement: { id: number; acknowledge(): void } | null = null;
let suspendedDatabase: { path: string; version: number } | null = null;

function initializeRepositories(reader = false) {
  if (!database) throw new Error("Workbench database is not initialized");
  if (!reader) proveReadWrite();
  projectRepository = new WorkbenchProjectRepository(database);
  threadLaunchRepository = new WorkbenchThreadLaunchRepository(database);
  if (!reader) threadLaunchRepository.recoverInterrupted();
  threadIdentityRepository = new WorkbenchThreadIdentityRepository(database);
  transcriptIdentityRepository = new WorkbenchTranscriptIdentityRepository(database);
  transcriptRepository = new WorkbenchTranscriptRepository(database, threadIdentityRepository);
  threadStateRepository = new WorkbenchThreadStateRelationalRepository(database, threadIdentityRepository);
  searchRepository = reader ? null : new WorkbenchSearchRepository(database);
  statsRepository = new WorkbenchStatsRepository(database);
  statsImportRepository = new WorkbenchStatsImportRepository(database);
  statsAttributionRepository = new WorkbenchStatsAttributionRepository(database);
  gitArcProposalDiffRepository = new GitArcProposalDiffRepository(database);
  transcriptRetentionRepository = reader ? null : new WorkbenchTranscriptRetentionRepository(database);
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

function required<Value>(value: Value | null, owner: string): Value {
  if (!value) throw new Error(`Workbench ${owner} is not initialized`);
  return value;
}

/** Registered requests reach the connection and repositories through this view of the worker's current state. */
const context: WorkbenchDatabaseWorkerContext = {
  get database() { return required(database, "database"); },
  get projects() { return required(projectRepository, "project repository"); },
  get threadLaunches() { return required(threadLaunchRepository, "thread launch repository"); },
  get threadIdentities() { return required(threadIdentityRepository, "thread identity repository"); },
  get transcriptIdentities() { return required(transcriptIdentityRepository, "transcript identity repository"); },
  get transcripts() { return required(transcriptRepository, "transcript repository"); },
  get threadState() { return required(threadStateRepository, "thread state"); },
  get search() { return required(searchRepository, "search repository"); },
  get stats() { return required(statsRepository, "stats repository"); },
  get statsImports() { return required(statsImportRepository, "stats import repository"); },
  get statsAttribution() { return required(statsAttributionRepository, "stats attribution repository"); },
  get proposalDiffs() { return required(gitArcProposalDiffRepository, "Git arc proposal diff repository"); },
  get retention() { return required(transcriptRetentionRepository, "transcript retention repository"); },
  inventory: () => inventory(),
  postDiagnostic: diagnostic => postDiagnostic(diagnostic),
};

function post(response: WorkbenchDatabaseResponse) {
  parentPort!.postMessage(response);
}

function postDiagnostic(diagnostic: WorkbenchDatabaseDiagnosticEvent) {
  parentPort!.postMessage({
    type: "diagnostic",
    diagnostic: WorkbenchDatabaseDiagnosticEventSchema.parse(diagnostic),
  } satisfies WorkbenchDatabaseWorkerMessage);
}

function closeDatabase() {
  projectRepository = null;
  threadLaunchRepository = null;
  threadIdentityRepository = null;
  transcriptIdentityRepository = null;
  transcriptRepository = null;
  threadStateRepository = null;
  searchRepository = null;
  statsRepository = null;
  statsImportRepository = null;
  statsAttributionRepository = null;
  transcriptRetentionRepository = null;
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

function handleInitializedRequest(request: Extract<WorkbenchDatabaseRequest, { type: "call" | "close" }>) {
  if (request.type === "call") {
    const definition = getWorkbenchDatabaseRequest(request.name);
    if (!definition) throw new Error(`Unknown database request ${String(request.name).slice(0, 120)}.`);
    post({ id: request.id, type: "result", result: definition.run(context, ...request.args) });
    return;
  }
  const closeFailure = closeDatabase();
  if (closeFailure) throw new Error(closeFailure);
  suspendedDatabase = null;
  post({ id: request.id, type: "closed" });
  parentPort!.close();
}

parentPort.on("message", async (request: WorkbenchDatabaseRequest) => {
  if (request.type === "initializeReader") {
    try {
      if (database) throw new Error("Workbench database is already initialized");
      database = new Database(request.databasePath, { readonly: true, fileMustExist: true });
      readOnly = true;
      initializeRepositories(true);
      post({ id: request.id, type: "ready", inventory: inventory() });
    } catch (error) {
      postFatalFailure(request, error, "Workbench database reader initialization failed.");
    }
    return;
  }
  if (readOnly && request.type !== "close" && !isWorkbenchDatabaseReadRequest(request)) {
    post({ id: request.id, type: "requestFailure", message: "Database reader is read-only." });
    return;
  }
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
      let checkpointRetained = false;
      const acknowledgeCheckpoint = async (backupPath: string) => {
        if (checkpointRetained) return;
        if (request.acknowledgeMigration) await new Promise<void>((acknowledge) => {
          migrationAcknowledgement = { id: request.id, acknowledge };
          post({ id: request.id, type: "migrationCheckpoint", backupPath });
        });
        checkpointRetained = true;
      };
      await recoverWorkbenchDatabase(request.databasePath, workbenchDatabaseSchema, acknowledgeCheckpoint);
      database = new Database(request.databasePath);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      const connection = database;
      const installedVersion = connection.pragma("user_version", { simple: true }) as number;
      if (installedVersion !== 0 && installedVersion < 33) {
        throw new Error("Workbench requires a current migrated database (schema 33 or later).");
      }
      let projects: WorkbenchProjectStartup | undefined;
      if (installedVersion === 0) {
        await migrateWorkbenchDatabase(database, workbenchDatabaseSchema, {
          beforeMigration: acknowledgeCheckpoint, diagnosticEvent: postDiagnostic,
        });
      } else if (installedVersion < databaseReleases.stableProjectPreparation.version) {
        await migrateWorkbenchDatabase(database, workbenchDatabaseSchema, {
          beforeMigration: acknowledgeCheckpoint,
          diagnosticEvent: postDiagnostic,
          targetVersion: databaseReleases.stableProjectPreparation.version,
        });
      }
      await new WorkbenchProjectIdentityMigration(connection).run(request.projects?.discovery, acknowledgeCheckpoint);
      await migrateWorkbenchDatabase(database, workbenchDatabaseSchema, {
        beforeMigration: acknowledgeCheckpoint, diagnosticEvent: postDiagnostic,
      });
      new WorkbenchProjectIdentityMigration(connection).repairHistoricalOwners();
      await new WorkbenchTranscriptTimestampRepair(connection).run(acknowledgeCheckpoint);
      // Serving writes always enforce foreign keys; only checkpointed restore,
      // migration and repair steps rewrite data outside that guarantee.
      if (checkpointRetained) new WorkbenchThreadStateIntegrity(connection).verify();
      await new WorkbenchExternalStorageMigration(connection, path.dirname(request.databasePath)).run();
      if (request.projects) {
        const { discovery } = request.projects;
        const repository = new WorkbenchProjectRepository(connection);
        projects = repository.reconcile(discovery);
      }
      initializeRepositories();
      post({ id: request.id, type: "ready", inventory: inventory(), projects });
    } catch (error) {
      postFatalFailure(request, error, "Workbench database initialization failed.");
    }
    return;
  }
  try {
    handleInitializedRequest(request);
  } catch (error) {
    if (request.type === "close") postFatalFailure(request, error, "Workbench database close failed.");
    else if (readOnly) post({ id: request.id, type: "requestFailure", message: boundedError(error) });
    else postRequestFailure(request, error);
  }
});
