/*
 * WorkbenchDatabaseControllerState: complete database-controller lifecycle state. Keywords: database, worker, lifecycle.
 * WorkbenchDatabaseRequestPayload: typed request payloads admitted by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseRequest: correlated requests admitted by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseResponse: typed responses returned by the database worker. Keywords: database, worker, protocol.
 * WorkbenchDatabaseInventory: installed schema inventory returned after readiness. Keywords: database, schema, inventory.
 */

export type WorkbenchDatabaseControllerState = "starting" | "ready" | "failed" | "closed";

export interface WorkbenchDatabaseInventory {
  tableNames: string[];
  schemaVersion: number;
}

export type WorkbenchDatabaseRequestPayload =
  | { type: "initialize"; databasePath: string }
  | { type: "getInventory" }
  | { type: "close" };

export type WorkbenchDatabaseRequest = WorkbenchDatabaseRequestPayload & { id: number };

export type WorkbenchDatabaseResponse =
  | { id: number; type: "ready"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "inventory"; inventory: WorkbenchDatabaseInventory }
  | { id: number; type: "closed" }
  | { id: number; type: "failure"; message: string };
