/*
 * Exports:
 * - WorkbenchSubagentStoreState/createWorkbenchSubagentStoreState: plain relationship and mutation state shared by fresh store wrappers. Keywords: subagent, store, reload, state, queue.
 * - getProcessWorkbenchSubagentStoreState: resolve one reload-stable state owner for each storage root. Keywords: subagent, process, storage root, reload.
 */
import path from "node:path";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";

export interface WorkbenchSubagentStoreState {
  initializationPromise: Promise<void> | null;
  nextDirectSubagentIndexes: Map<string, number>;
  operations: Map<string, Promise<void>>;
  parents: Map<string, Map<string, WorkbenchSubagentRelationship>>;
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
