/*
 * Keywords: subagent, reservation, relationship, reload, serialised mutation.
 * Exports:
 * - WorkbenchSubagentReservation: reserved child metadata without a thread id.
 * - WorkbenchStoredSubagent: reserved or active stored relationship.
 * - WorkbenchSubagentStoreState: shared relationships and mutation queues.
 * - createWorkbenchSubagentStoreState: construct fresh store state.
 * - getProcessWorkbenchSubagentStoreState: resolve storage-root state across scoped reloads.
 */
import path from "node:path";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";

export type WorkbenchSubagentReservation = Omit<WorkbenchSubagentRelationship, "threadId"> & { reservationId: string };
export type WorkbenchStoredSubagent =
  | (WorkbenchSubagentReservation & { kind: "reserved" })
  | (WorkbenchSubagentRelationship & { kind: "active" });

export interface WorkbenchSubagentStoreState {
  initializationPromise: Promise<void> | null;
  nextDirectSubagentIndexes: Map<string, number>;
  operations: Map<string, Promise<void>>;
  parents: Map<string, Map<string, WorkbenchStoredSubagent>>;
}

const PROCESS_STATES_KEY = Symbol.for("workbench.subagentStoreStates.v1");

export function createWorkbenchSubagentStoreState(): WorkbenchSubagentStoreState {
  return {
    initializationPromise: null,
    nextDirectSubagentIndexes: new Map(),
    operations: new Map(),
    parents: new Map(),
  };
}

function normalizeStorageRoot(storageRoot: string) {
  const resolved = path.resolve(storageRoot).replace(/\\/gu, "/");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

export function getProcessWorkbenchSubagentStoreState(storageRoot: string) {
  let states = Reflect.get(globalThis, PROCESS_STATES_KEY) as Map<string, WorkbenchSubagentStoreState> | undefined;
  if (!states) {
    states = new Map();
    Reflect.set(globalThis, PROCESS_STATES_KEY, states);
  }
  const key = normalizeStorageRoot(storageRoot);
  let state = states.get(key);
  if (!state) {
    state = createWorkbenchSubagentStoreState();
    states.set(key, state);
  }
  return state;
}
