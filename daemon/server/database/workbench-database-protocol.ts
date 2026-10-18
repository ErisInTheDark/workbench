/*
 * WorkbenchDatabaseControllerState: complete database-controller lifecycle state.
 * WorkbenchDatabaseRequestPayload: lifecycle requests plus calls to registered requests (./workbench-database-requests).
 * WorkbenchDatabaseRequest: correlated requests admitted by the database worker.
 * WorkbenchDatabaseResponse: lifecycle responses, registered request results and failures returned by the database worker.
 * WorkbenchDatabaseWorkerMessage: correlated responses plus out-of-band diagnostics.
 * WORKBENCH_DATABASE_READ_CLASSES/WorkbenchDatabaseReadClass: pure-read priority classes, most urgent first (live transcript, interactive state, history query, stats aggregates).
 * isBackgroundDatabaseReadClass: classes that must leave a reader free for interactive work.
 * getWorkbenchDatabaseReadClass/isWorkbenchDatabaseReadRequest: classify pure reads for the reader pool.
 * getWorkbenchDatabaseRequestOrdering: whether a request waits for, or becomes, the latest thread-state write.
 * WorkbenchDatabaseInventory: installed schema inventory returned after readiness.
 * WorkbenchDatabaseMutationResult: aggregate result of one atomic mutation batch.
 * WorkbenchTranscriptItemRange: one stable bounded relational item read.
 */
import type { WorkbenchDatabaseDiagnosticEvent } from "workbench-shared/database/workbench-database-diagnostic";
import type { WorkbenchTranscriptItemCursor } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { WorkbenchProjectPreparation, WorkbenchProjectStartup } from "./project/workbench-project-persistence";
import type { WorkbenchTranscriptSnapshot } from "./transcript/workbench-transcript-types.ts";
import { getWorkbenchDatabaseRequest, type WorkbenchDatabaseRequestName } from "./workbench-database-requests.ts";

export type WorkbenchDatabaseControllerState = "starting" | "ready" | "suspended" | "failed" | "closed";

export interface WorkbenchTranscriptItemRange {
  firstCursor?: WorkbenchTranscriptItemCursor;
  hasMore: boolean;
  snapshot: WorkbenchTranscriptSnapshot;
}

export interface WorkbenchDatabaseInventory {
  tableNames: string[];
  schemaVersion: number;
}

export interface WorkbenchDatabaseMutationResult {
  changes: number;
}

export type WorkbenchDatabaseRequestPayload =
  | { type: "call"; name: WorkbenchDatabaseRequestName; args: readonly unknown[] }
  | { type: "initialize"; databasePath: string; acknowledgeMigration?: boolean; projects?: WorkbenchProjectPreparation }
  | { type: "initializeReader"; databasePath: string }
  | { type: "acknowledgeMigration" }
  | { type: "suspend" }
  | { type: "resume"; restoreBackupPath?: string }
  | { type: "close" };

export type WorkbenchDatabaseRequest = WorkbenchDatabaseRequestPayload & { id: number };

/** Most urgent first: live ingest awaits transcript reads, the UI awaits core reads, and the rest is background. */
export const WORKBENCH_DATABASE_READ_CLASSES = ["transcript", "core", "query", "stats"] as const;
export type WorkbenchDatabaseReadClass = typeof WORKBENCH_DATABASE_READ_CLASSES[number];

export function isBackgroundDatabaseReadClass(readClass: WorkbenchDatabaseReadClass) {
  return readClass === "query" || readClass === "stats";
}

export function getWorkbenchDatabaseReadClass(request: WorkbenchDatabaseRequestPayload): WorkbenchDatabaseReadClass | null {
  return request.type === "call" ? getWorkbenchDatabaseRequest(request.name)?.read ?? null : null;
}

export function isWorkbenchDatabaseReadRequest(request: WorkbenchDatabaseRequestPayload): boolean {
  return getWorkbenchDatabaseReadClass(request) !== null;
}

export function getWorkbenchDatabaseRequestOrdering(request: WorkbenchDatabaseRequestPayload) {
  return request.type === "call" ? getWorkbenchDatabaseRequest(request.name)?.ordering ?? null : null;
}

export type WorkbenchDatabaseResponse =
  | { id: number; type: "result"; result: unknown }
  | { id: number; type: "ready"; inventory: WorkbenchDatabaseInventory; projects?: WorkbenchProjectStartup }
  | { id: number; type: "migrationCheckpoint"; backupPath: string }
  | { id: number; type: "suspended" }
  | { id: number; type: "closed" }
  | { id: number; type: "requestFailure"; message: string }
  | { id: number; type: "fatalFailure"; message: string };

export type WorkbenchDatabaseWorkerMessage =
  | WorkbenchDatabaseResponse
  | { type: "diagnostic"; diagnostic: WorkbenchDatabaseDiagnosticEvent };
