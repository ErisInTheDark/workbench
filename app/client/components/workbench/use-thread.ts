/*
 * Exports:
 * - useThread: lease one thread store (summary or view interest) and read its summary slice and actions. Members:
 *   `turns/questionnaire/approvals` read further slices of a leased store; `summary` leases one thread's batched summary
 *   for any thread display; `sidebarEntry` reads its project sidebar row; `titleHistory` reads previous titles with
 *   rename/dismiss intent; `presentedText` subscribes to one exact streaming text field; `fileIndex` reads the owning
 *   folder's file suggestions; `models` reads the owner's account model cache; `claimIntersections/collisions/arc` select
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
import type { ThreadTextPresentationKey } from "../../workbench/thread/ThreadTextPresentationController";
import type { WorkbenchProjectFileIndexSnapshot } from "../../workbench/project/WorkbenchProjectFileIndexStore";
import ThreadTextPresentationContext from "./ThreadTextPresentationContext";
import WorkbenchClientContext, { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
import { useProject } from "./use-projects";
import { useThreads } from "./use-threads";

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
  send: unavailable, stop: unavailable, compact: unavailable, resendSteer: unavailable, dismissSteer: unavailable,
  stopShell: unavailable, submitQuestionnaire: unavailable, snoozeQuestionnaire: unavailable, changeAgent: unavailable,
  changeModel: unavailable, changeReasoningEffort: unavailable, changeServiceTier: unavailable, changeSettings: unavailable,
  loadOlder: unavailable, observeGitArcProposal: () => () => {},
  observeGitArcClaimChanges: () => () => {}, refreshGitArcClaimChanges: () => {},
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

useThread.turns = function useThreadTurns(store: ThreadStore | null) { return useSlice(store, "turns"); };
useThread.questionnaire = function useThreadQuestionnaire(store: ThreadStore | null) { return useSlice(store, "questionnaire"); };
useThread.approvals = function useThreadApprovals(store: ThreadStore | null) { return useSlice(store, "approvals"); };

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
  const thread = useThread(projectId, { kind: "provider", harness, threadId });
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

/** One exact streaming text field, falling back to its canonical text. */
useThread.presentedText = function useThreadPresentedText(
  key: ThreadTextPresentationKey | null, canonicalText: string, explicitClient?: WorkbenchClientController,
) {
  const providedClient = useContext(WorkbenchClientContext);
  const standaloneText = useContext(ThreadTextPresentationContext);
  const mounted = (explicitClient ?? providedClient)?.mounted;
  const controller = key
    ? mounted?.threadTextPresentationFor(key.threadId) ?? standaloneText
    : mounted?.threadTextPresentation ?? standaloneText;
  const stableKey = useMemo<ThreadTextPresentationKey | null>(() => key ? {
    field: key.field,
    index: key.index,
    itemId: key.itemId,
    source: { kind: key.source.kind, sourceKey: key.source.sourceKey },
    threadId: key.threadId,
    turnId: key.turnId,
  } : null, [key?.field, key?.index, key?.itemId, key?.source.kind, key?.source.sourceKey, key?.threadId, key?.turnId]);
  const getSnapshot = useCallback(
    () => stableKey ? controller?.getSnapshot(stableKey) ?? canonicalText : canonicalText,
    [canonicalText, controller, stableKey],
  );
  const subscribe = useCallback((listener: () => void) => (
    stableKey && controller ? controller.subscribe(stableKey, canonicalText, listener) : EMPTY_SUBSCRIBE(listener)
  ), [canonicalText, controller, stableKey]);
  return useSyncExternalStore(subscribe, getSnapshot, () => canonicalText);
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
  return {
    snapshot: enabled && !target ? MISSING_THREAD_FILE_INDEX : snapshot,
    canRetry: Boolean(store && target),
    retry: () => store && target ? store.ensure(target, true) : Promise.resolve(MISSING_THREAD_FILE_INDEX),
  };
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
