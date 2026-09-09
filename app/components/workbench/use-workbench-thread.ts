/*
 * Keywords: thread identity, shared controller, React, consumer lease.
 * Exports:
 * - useWorkbenchThread: select one thread's domain state and bind stable actions to its identity.
 */
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchThreadController from "../../workbench/WorkbenchThreadController";
import type { ThreadControllerSnapshot } from "../../workbench/WorkbenchThreadController";
import { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
const empty: ThreadControllerSnapshot = {
  status: "loading", error: null, document: null, entry: null,
  pendingQuestionnaire: null, rateLimits: null, subagents: [], relatedDocuments: {}, transcript: { status: "idle" },
};
function unavailable(): never { throw new Error("The thread owner is not ready."); }
const unavailableActions: WorkbenchThreadController["actions"] = {
  changeAgent: unavailable, changeModel: unavailable, changeReasoningEffort: unavailable,
  changeServiceTier: unavailable, changeSettings: unavailable, compact: unavailable,
  stop: unavailable, read: unavailable, submitQuestionnaire: unavailable, snoozeQuestionnaire: unavailable,
};

export function useWorkbenchThread(projectId: string, target: WorkbenchThreadTarget | null, explicitClient?: WorkbenchClientController, interest: "summary" | "view" | "route" = "summary") {
  const client = useWorkbenchClientController(explicitClient);
  const owner = projectId && target && target.kind !== "new"
    ? client.mounted?.getThreadController(projectId, target) ?? null : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!owner) return () => {};
    const unsubscribe = owner.subscribe(listener);
    const release = owner.acquire(interest);
    return () => { unsubscribe(); release(); };
  }, [owner, interest]);
  const getSnapshot = useCallback(() => owner?.getSnapshot() ?? empty, [owner]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => ({
    owner,
    state: { ...snapshot, canRead: owner !== null },
    actions: owner?.actions ?? unavailableActions,
  }), [owner, snapshot]);
}
