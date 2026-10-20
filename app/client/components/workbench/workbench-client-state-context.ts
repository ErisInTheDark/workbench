/*
 * Exports:
 * - WorkbenchClientStateContext: current browser state owner context with intentional memory-only Next default. Keywords: browser, state, React, context.
 * - useWorkbenchClientStateController: read the current browser state owner. Keywords: browser, state, React, controller.
 * - useWorkbenchClientState: select one fact from the browser state, re-rendering only when that fact changes. */
"use client";

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

import WorkbenchClientStateController, { type WorkbenchClientStateSnapshot } from "../../workbench/state/WorkbenchClientStateController";

const memoryController = new WorkbenchClientStateController({ mode: "memory" });

export const WorkbenchClientStateContext = createContext(memoryController);

export function useWorkbenchClientStateController() {
  return useContext(WorkbenchClientStateContext);
}

/**
 * `select` may be an inline arrow: an equal selection keeps its previous identity, so writes elsewhere in the state
 * (a composer draft autosave, another preference) re-render nothing here.
 */
export function useWorkbenchClientState<Value>(select: (state: WorkbenchClientStateSnapshot) => Value): Value {
  const controller = useWorkbenchClientStateController();
  const kept = useRef<{ value: Value } | null>(null);
  const read = useCallback(() => {
    const next = select(controller.getSnapshot());
    if (kept.current && areDeeplyEqual(kept.current.value, next)) return kept.current.value;
    kept.current = { value: next };
    return next;
  }, [controller, select]);
  return useSyncExternalStore(controller.subscribe, read, read);
}
