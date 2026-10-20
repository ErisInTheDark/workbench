/*
 * Exports:
 * - default useWorkspaceObservation: observe one workspace query for a component's lifetime and render its latest snapshot.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { WorkspaceQuery } from "workbench-shared/workbench/workspace/workspace-observation";
import type WorkbenchWorkspaceClient from "./WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle, WorkspaceQuerySnapshot } from "./WorkbenchWorkspaceClient";

const PENDING: WorkspaceQuerySnapshot = { phase: "pending", failure: null, value: null };
const unsubscribed = () => () => {};

/** The observation follows the query's meaning, so an inline query object is fine; an equal one never re-observes. Null observes nothing. */
export default function useWorkspaceObservation<Query extends WorkspaceQuery>(
  workspace: WorkbenchWorkspaceClient | null,
  query: Query | null,
): WorkspaceQuerySnapshot<Query["kind"]> {
  const key = query ? JSON.stringify(query) : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the query's meaning; its identity is noise.
  const stableQuery = useMemo(() => query, [key]);
  const [handle, setHandle] = useState<WorkspaceQueryHandle<Query["kind"]> | null>(null);
  useEffect(() => {
    if (!workspace || !stableQuery) {
      setHandle(null);
      return;
    }
    const next = workspace.observe(stableQuery);
    setHandle(next);
    return () => next.release();
  }, [stableQuery, workspace]);
  const read = () => (handle?.getSnapshot() ?? PENDING) as WorkspaceQuerySnapshot<Query["kind"]>;
  return useSyncExternalStore(handle?.subscribe ?? unsubscribed, read, read);
}
