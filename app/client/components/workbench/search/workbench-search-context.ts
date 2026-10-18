/*
 * Exports:
 * - WorkbenchSearchContext: the app's workspace search controller, provided by WorkbenchSearchProvider.
 * - useWorkbenchSearch: the search controller; `.snapshot` reads live dialog state, `.scope` keeps results scoped to a project,
 *   and `.onActivate` routes activated results to the latest handler.
 */
"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import type WorkbenchSearchController from "../../../workbench/search/WorkbenchSearchController";
import type { WorkbenchSearchHit } from "../../../workbench/search/WorkbenchSearchController";

export const WorkbenchSearchContext = createContext<WorkbenchSearchController | null>(null);

export function useWorkbenchSearch() {
  const controller = useContext(WorkbenchSearchContext);
  if (!controller) throw new Error("Workbench search requires a WorkbenchSearchProvider.");
  return controller;
}

useWorkbenchSearch.snapshot = function useWorkbenchSearchSnapshot() {
  const controller = useWorkbenchSearch();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
};

useWorkbenchSearch.scope = function useWorkbenchSearchScope(projectId: string | null) {
  const controller = useWorkbenchSearch();
  useEffect(() => {
    controller.setProjectId(projectId);
  }, [controller, projectId]);
};

useWorkbenchSearch.onActivate = function useWorkbenchSearchActivation(handler: (result: WorkbenchSearchHit) => void) {
  const controller = useWorkbenchSearch();
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => controller.onActivate(result => latest.current(result)), [controller]);
};
