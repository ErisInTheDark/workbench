/*
 * WorkbenchDatabaseControllerState: complete database-controller lifecycle state. Keywords: database, worker, lifecycle.
 * WorkbenchDatabaseRequestPayload: typed request payloads admitted by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseRequest: correlated requests admitted by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseResponse: typed responses returned by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseInventory: installed schema inventory returned after readiness. Keywords: database, schema, inventory.
 * WorkbenchDatabaseMutationResult: aggregate result of one atomic mutation batch. Keywords: database, statement, transaction.
 */
import type {
  WorkbenchDatabaseMutation,
  WorkbenchDatabaseQuery,
  WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSnapshot,
} from "./transcript/workbench-transcript-types.ts";
import type {
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./thread-state/workbench-thread-state-shadow-types.ts";

export type WorkbenchDatabaseControllerState = "starting" | "ready" | "failed" | "closed";

export interface WorkbenchDatabaseInventory {
  tableNames: string[];
  schemaVersion: number;
}

export interface WorkbenchDatabaseMutationResult {
  changes: number;
}

export type WorkbenchDatabaseRequestPayload =
  | { type: "initialize"; databasePath: string }
  | { type: "getInventory" }
  | { type: "executeTransaction"; statements: readonly WorkbenchDatabaseMutation[] }
  | { type: "query"; statement: WorkbenchDatabaseQuery }
  | { type: "rebuildThreadStateShadow"; request: WorkbenchThreadStateShadowRefresh }
  | { type: "readThreadStateShadowStatus" }
  | { type: "recordThreadStateShadowFailure"; request: WorkbenchThreadStateShadowRefresh }
  | { type: "settleTranscript"; observations: readonly WorkbenchTranscriptObservation[] }
  | { type: "readTranscript"; request: WorkbenchTranscriptReadRequest }
  | { type: "readTranscriptMaterializedTurnIds"; threadId: string; turnIds: readonly string[] }
  | { type: "close" };

export type WorkbenchDatabaseRequest = WorkbenchDatabaseRequestPayload & { id: number };

export type WorkbenchDatabaseResponse =
  | { id: number; type: "ready"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "inventory"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "mutationResult"; result: WorkbenchDatabaseMutationResult }
  | { id: number; type: "queryResult"; rows: WorkbenchDatabaseRow[] }
  | { id: number; type: "threadStateShadowStatus"; status: WorkbenchThreadStateShadowStatus | null }
  | { id: number; type: "transcriptSettlement"; settlement: WorkbenchTranscriptSettlement }
  | { id: number; type: "transcriptSnapshot"; snapshot: WorkbenchTranscriptSnapshot | null }
  | { id: number; type: "transcriptMaterializedTurnIds"; turnIds: string[] }
  | { id: number; type: "closed" }
  | { id: number; type: "requestFailure"; message: string }
  | { id: number; type: "fatalFailure"; message: string };
