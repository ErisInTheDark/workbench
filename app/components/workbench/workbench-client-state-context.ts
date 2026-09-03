/*
 * Exports:
 * - WorkbenchClientStateContext: current browser state owner context with intentional memory-only Next default. Keywords: browser, state, React, context.
 * - useWorkbenchClientStateController: read the current browser state owner. Keywords: browser, state, React, controller.
 * - useWorkbenchClientStateSnapshot: subscribe to the current browser state projection. Keywords: browser, state, React, snapshot.
 */
"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";

const memoryController = new WorkbenchClientStateController({ mode: "memory" });

export const WorkbenchClientStateContext = createContext(memoryController);

export function useWorkbenchClientStateController() {
  return useContext(WorkbenchClientStateContext);
}

export function useWorkbenchClientStateSnapshot() {
  const controller = useWorkbenchClientStateController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
