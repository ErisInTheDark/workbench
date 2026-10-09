/*
 * Exports:
 * - useThread: lease one thread store (summary or view interest) and read its summary slice and actions; `useThread.turns/questionnaire/approvals` read further slices of a leased store.
 */
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import type ThreadStore from "../../workbench/thread/ThreadStore";
import {
  EMPTY_THREAD_STORE_STATE, type ThreadInterest, type ThreadSliceName, type ThreadStoreActions, type ThreadStoreState,
} from "../../workbench/thread/ThreadStore";
import { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";

function unavailable(): never { throw new Error("The thread is not ready."); }
const unavailableActions: ThreadStoreActions = {
  send: unavailable, stop: unavailable, compact: unavailable, resendSteer: unavailable, dismissSteer: unavailable,
  stopShell: unavailable, submitQuestionnaire: unavailable, snoozeQuestionnaire: unavailable, changeAgent: unavailable,
  changeModel: unavailable, changeReasoningEffort: unavailable, changeServiceTier: unavailable, changeSettings: unavailable,
  loadOlder: unavailable, observeGitArcProposal: () => () => {},
  setGoal: unavailable, clearGoal: unavailable, deactivateSkill: unavailable,
  addTodo: unavailable, removeTodo: unavailable, setTodoRequired: unavailable, setTodoText: unavailable, clearAddressedFeedback: unavailable,
};

function useSlice<Name extends ThreadSliceName>(store: ThreadStore | null, name: Name): ThreadStoreState[Name] {
  const subscribe = useCallback((listener: () => void) => store?.subscribe(name, listener) ?? (() => {}), [store, name]);
  const read = useCallback(() => store?.getSlice(name) ?? EMPTY_THREAD_STORE_STATE[name], [store, name]);
  return useSyncExternalStore(subscribe, read, read);
}

function useThreadStore(projectId: string, target: WorkbenchThreadRouteTarget | null, interest: ThreadInterest, explicitClient?: WorkbenchClientController) {
  const client = useWorkbenchClientController(explicitClient);
  const bindable = target && target.kind !== "new"
    && (target.kind === "draft" || projectId || target.kind === "provider" || target.kind === "subagent") ? target : null;
  const store = bindable ? client.mounted?.getThreadStore(projectId, bindable) ?? null : null;
  // The lease lives with the summary subscription, so mounting starts the feed and unmounting releases it.
  const subscribe = useCallback((listener: () => void) => {
    if (!store) return () => {};
    const unsubscribe = store.subscribe("summary", listener);
    const release = store.acquire(interest);
    return () => { unsubscribe(); release(); };
  }, [store, interest]);
  const read = useCallback(() => store?.getSlice("summary") ?? EMPTY_THREAD_STORE_STATE.summary, [store]);
  return { store, summary: useSyncExternalStore(subscribe, read, read) };
}

/** `view` interest opens the thread's turn content; `summary` only its entry and head. */
export function useThread(projectId: string, target: WorkbenchThreadRouteTarget | null, interest: ThreadInterest = "summary", explicitClient?: WorkbenchClientController) {
  const { store, summary } = useThreadStore(projectId, target, interest, explicitClient);
  return useMemo(() => ({
    ...summary,
    store,
    feed: store?.feed ?? null,
    actions: store?.actions ?? unavailableActions,
  }), [store, summary]);
}

useThread.turns = function useThreadTurns(store: ThreadStore | null) { return useSlice(store, "turns"); };
useThread.questionnaire = function useThreadQuestionnaire(store: ThreadStore | null) { return useSlice(store, "questionnaire"); };
useThread.approvals = function useThreadApprovals(store: ThreadStore | null) { return useSlice(store, "approvals"); };
