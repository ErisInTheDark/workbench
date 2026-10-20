/*
 * Exports:
 * - WorkbenchSubagentClaims: one direct child's active claim paths with its name, colour identity, and title.
 * - useWorkbenchSubagentClaims: subscribe to a parent's direct-child claims from its listing member; the result keeps its
 *   identity until the claims change.
 */
"use client";

import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";

import type { WorkbenchThreadListing } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { ThreadAgentIdentitySubject } from "../../workbench/thread/thread-subagents";
import WorkbenchClientContext from "./workbench-client-context";

export interface WorkbenchSubagentClaims extends ThreadAgentIdentitySubject {
  claimedPaths: readonly string[];
  threadId: string;
  title: string;
}

const NO_CLAIMS: readonly WorkbenchSubagentClaims[] = [];
const EMPTY_SUBSCRIBE = () => () => undefined;
const NO_MEMBERS: WorkbenchThreadListing["members"] = {};

/** Provider-optional: thread rows also render standalone, where there are no listed children to roll up. */
export function useWorkbenchSubagentClaims(parentThreadId: string | null) {
  const store = useContext(WorkbenchClientContext)?.mounted?.threadSidebar ?? null;
  const getMembers = useCallback(() => store?.getListing?.().members ?? NO_MEMBERS, [store]);
  const members = useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, getMembers, getMembers);
  const kept = useRef<readonly WorkbenchSubagentClaims[]>(NO_CLAIMS);
  return useMemo(() => {
    const next = selectClaims(members, parentThreadId);
    if (!areDeeplyEqual(kept.current, next)) kept.current = next;
    return kept.current;
  }, [members, parentThreadId]);
}

/** Subagents are never listed themselves; each parent member carries its direct children's claims. */
function selectClaims(members: WorkbenchThreadListing["members"], parentThreadId: string | null): readonly WorkbenchSubagentClaims[] {
  if (!parentThreadId) return NO_CLAIMS;
  const member = Object.values(members).find(candidate => candidate.ref.kind === "thread"
    && candidate.ref.identity.threadId === parentThreadId && candidate.subagentClaims);
  return member?.subagentClaims?.length ? [...member.subagentClaims]
    .sort((left, right) => left.name.localeCompare(right.name) || left.threadId.localeCompare(right.threadId)) : NO_CLAIMS;
}
