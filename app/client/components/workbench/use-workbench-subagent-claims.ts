/*
 * Exports:
 * - WorkbenchSubagentClaims: one direct child's active claim paths with its name, colour identity, and title.
 * - collectSubagentClaims: select direct children of a parent that hold active (unstashed) claims.
 * - useWorkbenchSubagentClaims: subscribe to a parent's direct-child claims from its listing member, or its project sidebar;
 *   the result keeps its identity until the claims change.
 */
"use client";

import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";

import type { WorkbenchThreadListing } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
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
const NO_MEMBERS: WorkbenchThreadListing["members"] = {};

/** Provider-optional: thread rows also render standalone, where there are no sidebar children to roll up. */
export function useWorkbenchSubagentClaims(projectId: ProjectId | "" | null | undefined, parentThreadId: string | null) {
  const store = useContext(WorkbenchClientContext)?.mounted?.threadSidebar ?? null;
  const getSnapshot = useCallback(
    () => projectId && parentThreadId ? store?.getProjectSnapshot(projectId) ?? null : null,
    [parentThreadId, projectId, store],
  );
  const snapshot = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
  // The listing notifies on its own channel, not the sidebar's.
  const getMembers = useCallback(() => store?.getListing?.().members ?? NO_MEMBERS, [store]);
  const members = useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, getMembers, getMembers);
  const kept = useRef<readonly WorkbenchSubagentClaims[]>(NO_CLAIMS);
  return useMemo(() => {
    const next = selectClaims(members, snapshot, parentThreadId);
    if (!areDeeplyEqual(kept.current, next)) kept.current = next;
    return kept.current;
  }, [members, parentThreadId, snapshot]);
}

function selectClaims(
  members: WorkbenchThreadListing["members"], snapshot: { entries: readonly WorkbenchThreadSidebarEntry[] } | null, parentThreadId: string | null,
): readonly WorkbenchSubagentClaims[] {
  if (!parentThreadId) return NO_CLAIMS;
  // Listings without subagent rows carry each parent's children's claims on the parent member.
  const member = Object.values(members).find(candidate => candidate.ref.kind === "thread"
    && candidate.ref.identity.threadId === parentThreadId && candidate.subagentClaims);
  if (member?.subagentClaims) {
    return member.subagentClaims.length ? [...member.subagentClaims]
      .sort((left, right) => left.name.localeCompare(right.name) || left.threadId.localeCompare(right.threadId)) : NO_CLAIMS;
  }
  return snapshot ? collectSubagentClaims(snapshot.entries, parentThreadId) : NO_CLAIMS;
}
