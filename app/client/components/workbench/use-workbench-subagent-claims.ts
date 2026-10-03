/*
 * Exports:
 * - WorkbenchSubagentClaims: one direct child's active claim paths with its name, colour identity, and title.
 * - collectSubagentClaims: select direct children of a parent that hold active (unstashed) claims.
 * - useWorkbenchSubagentClaims: subscribe to a parent's direct-child claims from its project sidebar.
 */
"use client";

import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import type { ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { ThreadAgentIdentitySubject } from "../../workbench/thread/thread-subagents";
import WorkbenchClientContext from "./workbench-client-context";

export interface WorkbenchSubagentClaims extends ThreadAgentIdentitySubject {
  claimedPaths: readonly string[];
  threadId: string;
  title: string;
}

const NO_CLAIMS: readonly WorkbenchSubagentClaims[] = [];

export function collectSubagentClaims(entries: readonly WorkbenchThreadSidebarEntry[], parentThreadId: string): readonly WorkbenchSubagentClaims[] {
  const claims = entries.flatMap((entry) => entry.entryKind === "subagent"
    && entry.parentThreadId === parentThreadId
    && entry.gitArc?.phase === "active"
    ? [{
      claimedPaths: entry.gitArc.claimedPaths,
      directSubagentIndex: entry.directSubagentIndex,
      name: entry.name,
      parentThreadId: entry.parentThreadId,
      threadId: entry.identity.threadId,
      title: entry.title,
    }]
    : []);
  return claims.length ? claims.sort((left, right) => left.name.localeCompare(right.name) || left.threadId.localeCompare(right.threadId)) : NO_CLAIMS;
}

const EMPTY_SUBSCRIBE = () => () => undefined;

/** Provider-optional: thread rows also render standalone, where there are no sidebar children to roll up. */
export function useWorkbenchSubagentClaims(projectId: ProjectId | "" | null | undefined, parentThreadId: string | null) {
  const store = useContext(WorkbenchClientContext)?.mounted?.threadSidebar ?? null;
  const getSnapshot = useCallback(
    () => projectId && parentThreadId ? store?.getProjectSnapshot(projectId) ?? null : null,
    [parentThreadId, projectId, store],
  );
  const snapshot = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
  return useMemo(
    () => parentThreadId && snapshot ? collectSubagentClaims(snapshot.entries, parentThreadId) : NO_CLAIMS,
    [parentThreadId, snapshot],
  );
}
