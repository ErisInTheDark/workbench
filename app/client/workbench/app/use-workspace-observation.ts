/*
 * Exports:
 * - default useWorkspaceObservation: observe one workspace query for a component's lifetime and render its latest snapshot.
 */
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { WorkspaceQuery } from "workbench-shared/workbench/workspace/workspace-observation";
import type WorkbenchWorkspaceClient from "./WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle, WorkspaceQuerySnapshot } from "./WorkbenchWorkspaceClient";

const PENDING: WorkspaceQuerySnapshot = { phase: "pending", failure: null, value: null };
const unsubscribed = () => () => {};

/** Callers memoize `query`; a new object identity replaces the observation. Null observes nothing. */
export default function useWorkspaceObservation<Query extends WorkspaceQuery>(
  workspace: WorkbenchWorkspaceClient | null,
  query: Query | null,
): WorkspaceQuerySnapshot<Query["kind"]> {
  const [handle, setHandle] = useState<WorkspaceQueryHandle<Query["kind"]> | null>(null);
  useEffect(() => {
    if (!workspace || !query) {
      setHandle(null);
      return;
    }
    const next = workspace.observe(query);
    setHandle(next);
    return () => next.release();
  }, [query, workspace]);
  const read = () => (handle?.getSnapshot() ?? PENDING) as WorkspaceQuerySnapshot<Query["kind"]>;
  return useSyncExternalStore(handle?.subscribe ?? unsubscribed, read, read);
}
