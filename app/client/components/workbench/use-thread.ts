/*
 * Exports:
 * - useThread: lease one thread store (summary or view interest) and read its summary slice and actions; transcript reads
 *   live on `useTranscript`. Members: `questionnaire` reads a leased store's pending input; `summary` leases one thread's
 *   batched summary for any thread display; `sidebarEntry` reads its project sidebar row; `titleHistory` reads previous
 *   titles through the summary-resolved family with rename/dismiss intent; `fileIndex` reads the owning
 *   folder's file suggestions; `models` reads the owner's account model cache; `attention` reads its questionnaire label; `subagent` reads a thread's subagent
 *   relationship; `claimIntersections/collisions/arc` select
 *   narrow Git arc facts from the owner's source sidebar.
 */
"use client";

import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { WorkbenchHarness, WorkbenchModelOption, WorkbenchThreadSidebarStore } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { DaemonId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import {
  createWorkbenchThreadClaimIntersectionSelector, type WorkbenchHarnessId, type WorkbenchThreadRouteTarget,
} from "workbench-shared/workbench/thread/thread-state";
import type {
  WorkbenchThreadSidebarRow, WorkbenchThreadSidebarRowSnapshot,
} from "workbench-shared/workbench/thread/thread-sidebar-row";
import type ThreadStore from "../../workbench/thread/ThreadStore";
import {
  EMPTY_THREAD_STORE_STATE, type ThreadInterest, type ThreadSliceName, type ThreadStoreActions, type ThreadStoreState,
} from "../../workbench/thread/ThreadStore";
import type { WorkbenchProjectFileIndexSnapshot } from "../../workbench/project/WorkbenchProjectFileIndexStore";
import WorkbenchClientContext, { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
import { useProject } from "./use-projects";
import { useThreads } from "./use-threads";
import { threadAttentionLabel } from "./thread-attention";

type ProviderThreadSidebarEntry = Exclude<WorkbenchThreadSidebarRow, { entryKind: "draft" }>;
type ThreadSidebarThreadEntry = Extract<WorkbenchThreadSidebarRow, { entryKind: "thread" }>;
const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};
const EMPTY_MODEL_CATALOGUES: ReadonlyMap<WorkbenchHarness, readonly WorkbenchModelOption[]> = new Map();
const MISSING_THREAD_FILE_INDEX: WorkbenchProjectFileIndexSnapshot = {
  candidates: [], paths: [], id: "project-files:missing-owner",
  status: "error", error: "The thread's daemon folder is unavailable for file suggestions.",
};

function unavailable(): never { throw new Error("The thread is not ready."); }
const unavailableActions: ThreadStoreActions = {
  submitDraft: unavailable,
  send: unavailable, stop: unavailable, compact: unavailable, resendSteer: unavailable, dismissSteer: unavailable,
  stopCall: unavailable, startShellNow: unavailable, submitQuestionnaire: unavailable, snooze: unavailable, changeAgent: unavailable,
  changeModel: unavailable, changeReasoningEffort: unavailable, changeServiceTier: unavailable, changeSettings: unavailable,
  loadOlder: unavailable, observeGitArcProposal: () => () => {},
  observeGitArcClaimChanges: () => () => {}, refreshGitArcClaimChanges: () => {},
  setGoal: unavailable, clearGoal: unavailable, deactivateSkill: unavailable,
  addTodo: unavailable, removeTodo: unavailable, setTodoRequired: unavailable, setTodoText: unavailable, detachAddressedFeedback: unavailable,
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

const NO_SUMMARY_LEASE = () => () => {};

/**
 * One thread's located summary (lean row plus live facts) for any thread display; null while unknown. Every mounted
 * display shares one batched observation, so showing a thread costs a lease, not a subscription of its own.
 */
useThread.summary = function useThreadSummary(threadId: string | null) {
  const store = useContext(WorkbenchClientContext)?.mounted?.threadSummaries ?? null;
  const subscribe = useCallback((listener: () => void) => store && threadId ? store.subscribe(threadId, listener) : NO_SUMMARY_LEASE(),
    [store, threadId]);
  const read = useCallback(() => store && threadId ? store.get(threadId) : null, [store, threadId]);
  return useSyncExternalStore(subscribe, read, read);
};

useThread.questionnaire = function useThreadQuestionnaire(store: ThreadStore | null) { return useSlice(store, "questionnaire"); };

/** One project-owned thread sidebar row by identity; null while unknown or owned by another project. */
useThread.sidebarEntry = function useThreadSidebarEntry(
  projectId: ProjectId | "" | null | undefined, harness: WorkbenchHarness, threadId: string,
  explicitClient?: WorkbenchClientController,
) {
  const snapshot = useThreads.sidebar(projectId, explicitClient);
  return useMemo(() => snapshot?.entries.find((entry): entry is ProviderThreadSidebarEntry => (
    entry.entryKind !== "draft" && entry.identity.harness === harness && entry.identity.threadId === threadId
  )) ?? null, [harness, snapshot, threadId]);
};

/** Previous titles plus project-qualified reapply and dismiss intent. */
useThread.titleHistory = function useThreadTitleHistory(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId) {
  const client = useWorkbenchClientController();
  const summary = useThread.summary(threadId);
  const row = summary?.summary.row;
  const target: WorkbenchThreadRouteTarget | null = !row ? null
    : row.entryKind === "subagent"
      ? { kind: "subagent", parentThreadId: row.parentThreadId, ...row.identity }
      : { kind: "provider", ...row.identity };
  const thread = useThread(projectId, target);
  const reapply = useCallback(async (title: string) => {
    if (!client.controls) throw new Error("Workbench controls are not ready.");
    await client.controls.setThreadTitle({ projectId, harness, threadId, title });
  }, [client.controls, harness, projectId, threadId]);
  const dismiss = useCallback(async (title: string) => {
    if (!client.controls) throw new Error("Workbench controls are not ready.");
    const accepted = await client.controls.updateThreadStateWithAcceptance({
      method: "workbench/thread-state/title/dismiss", projectId, identity: { harness, threadId }, title,
    });
    if (!accepted) throw new Error("The current title cannot be dismissed.");
  }, [client.controls, harness, projectId, threadId]);
  return { previousTitles: thread.entry?.previousTitles ?? [], reapply, dismiss };
};

/** The owning daemon folder's file suggestions, without selecting browse state. */
useThread.fileIndex = function useThreadFileIndex(threadId: string, enabled: boolean) {
  const client = useWorkbenchClientController();
  const store = client.mounted?.projectFileIndexStore ?? null;
  const context = enabled
    ? client.mounted?.threadContextFor(threadId) ?? client.mounted?.draftContextFor(threadId)
    : null;
  const daemonId = context?.daemonId ?? null;
  const projectId = context?.project.id ?? null;
  const target = useMemo(() => daemonId && projectId ? { daemonId, projectId } : null, [daemonId, projectId]);
  const subscribe = useCallback((listener: () => void) =>
    store?.subscribe(target, listener) ?? (() => undefined), [store, target]);
  const getSnapshot = useCallback(() => store?.getSnapshot(target) ?? MISSING_THREAD_FILE_INDEX, [store, target]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!enabled || !store || !target) return;
    void store.ensure(target).catch(error => console.error(
      "Thread file suggestions unavailable:",
      error instanceof Error ? error.message.slice(0, 512) : "Unknown file-index failure.",
    ));
  }, [enabled, store, target]);
  const retry = useCallback(() => store && target ? store.ensure(target, true) : Promise.resolve(MISSING_THREAD_FILE_INDEX),
    [store, target]);
  return useMemo(() => ({
    snapshot: enabled && !target ? MISSING_THREAD_FILE_INDEX : snapshot,
    canRetry: Boolean(store && target),
    retry,
  }), [enabled, retry, snapshot, store, target]);
};

/** The thread owner's account model cache by identity. */
useThread.models = function useThreadModels(threadId: string) {
  const mounted = useWorkbenchClientController().mounted;
  const store = (mounted?.threadContextFor(threadId) ?? mounted?.draftContextFor(threadId))?.threads;
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getModelCatalogues ?? (() => EMPTY_MODEL_CATALOGUES),
    () => EMPTY_MODEL_CATALOGUES,
  );
};

const NO_LABEL = () => "";

/** One thread's questionnaire attention label from the sidebars and pinned summaries; "" when it waits on nothing. */
useThread.attention = function useThreadAttention(threadId: string | null) {
  const store = useContext(WorkbenchClientContext)?.mounted?.threadSidebar ?? null;
  const read = useCallback(() => threadId && store ? threadAttentionLabel(
    store.getProjectThreadSidebars?.() ?? { projects: [] }, store.getProjectThreadSummaries?.() ?? { projects: [] }, threadId,
  ) : "", [store, threadId]);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, store ? read : NO_LABEL, store ? read : NO_LABEL);
};

const NO_SUBAGENT_KEY = () => "";

/** A provider thread's subagent relationship (parent and harness) from the runtime; null when it is no subagent. */
useThread.subagent = function useThreadSubagent(threadId: string | null, harness?: WorkbenchHarness, explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchClientController(explicitClient).mounted?.threadRuntime ?? null;
  const getKey = useCallback(() => {
    const relationship = threadId ? store?.getSnapshot().subagents.find(entry => entry.threadId === threadId
      && (!harness || entry.harness === harness)) : null;
    return relationship ? `${relationship.harness}\0${relationship.parentThreadId}` : "";
  }, [harness, store, threadId]);
  const key = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, store ? getKey : NO_SUBAGENT_KEY, NO_SUBAGENT_KEY);
  return useMemo(() => {
    if (!key) return null;
    const [relationshipHarness, parentThreadId] = key.split("\0") as [WorkbenchHarness, string];
    return { harness: relationshipHarness, parentThreadId };
  }, [key]);
};

function useOwnerSource(threadId: string) {
  const client = useWorkbenchClientController();
  const store = client.mounted?.threadSidebar ?? null;
  const owner = client.mounted?.threadOwnerFor(threadId) ?? null;
  const daemonId = owner?.daemonId;
  const projectId = owner?.projectId;
  const location = useMemo(() => daemonId && projectId ? { daemonId, projectId } : null, [daemonId, projectId]);
  const logicalProjectId = useProject.forLocation(location)?.id ?? null;
  return { store, daemonId, projectId, logicalProjectId };
}

function ownerSourceSnapshot(
  store: WorkbenchThreadSidebarStore | null, daemonId: DaemonId | undefined, projectId: ProjectId | undefined,
) {
  return daemonId && projectId ? store?.getLocationSnapshot?.({ daemonId, projectId }) ?? null : null;
}

useThread.claimIntersections = function useThreadClaimIntersections(
  threadId: string, harness: WorkbenchHarnessId, scope: "plan" | "stashed",
) {
  const { store, daemonId, projectId, logicalProjectId } = useOwnerSource(threadId);
  const selector = useMemo(() => createWorkbenchThreadClaimIntersectionSelector({ harness, threadId }, scope),
    [harness, scope, threadId]);
  const getSnapshot = useCallback(() => selector(ownerSourceSnapshot(store, daemonId, projectId)),
    [daemonId, projectId, selector, store]);
  const intersections = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
  return useMemo(() => ({ intersections, logicalProjectId, ownerProjectId: projectId }),
    [intersections, logicalProjectId, projectId]);
};

useThread.collisions = function useThreadCollisions(
  threadId: string, owners: readonly { harness: string; threadId: string }[],
) {
  const { store, daemonId, projectId, logicalProjectId } = useOwnerSource(threadId);
  const ownerKey = owners.map(owner => `${owner.harness.toLowerCase()}\0${owner.threadId.toLowerCase()}`).sort().join("\n");
  const select = useMemo(() => {
    let selected: ThreadSidebarThreadEntry[] = [];
    const keys = new Set(ownerKey.split("\n"));
    return (snapshot: WorkbenchThreadSidebarRowSnapshot | null) => {
      const next = (snapshot?.entries ?? []).filter((entry): entry is ThreadSidebarThreadEntry =>
        entry.entryKind === "thread" && keys.has(`${entry.identity.harness.toLowerCase()}\0${entry.identity.threadId.toLowerCase()}`));
      if (areDeeplyEqual(selected, next)) return selected;
      selected = next;
      return selected;
    };
  }, [ownerKey]);
  const activeStore = ownerKey ? store : null;
  const getSnapshot = useCallback(() => select(ownerSourceSnapshot(activeStore, daemonId, projectId)),
    [activeStore, daemonId, projectId, select]);
  const entries = useSyncExternalStore(activeStore?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
  return { entries, logicalProjectId, ownerProjectId: projectId };
};

useThread.arc = function useThreadArc(threadId: string, harness: WorkbenchHarnessId) {
  const { store, daemonId, projectId } = useOwnerSource(threadId);
  const select = useMemo(() => {
    let selected: ThreadSidebarThreadEntry | null = null;
    return (snapshot: WorkbenchThreadSidebarRowSnapshot | null) => {
      const next = snapshot?.entries.find((entry): entry is ThreadSidebarThreadEntry =>
        entry.entryKind === "thread" && entry.identity.harness === harness && entry.identity.threadId === threadId) ?? null;
      if (areDeeplyEqual(selected, next)) return selected;
      selected = next;
      return selected;
    };
  }, [harness, threadId]);
  const getSnapshot = useCallback(() => select(ownerSourceSnapshot(store, daemonId, projectId)),
    [daemonId, projectId, select, store]);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
};
