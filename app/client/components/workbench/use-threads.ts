/*
 * Exports:
 * - useThreads: read and act on the route-owned thread collection; members read the current thread and documents alone, the sidebars and one sidebar draft, home and pinned ordering, and the combined thread listing (activity-free structure, one row by key or physical key, rows for keys, sidebar errors and loading, archived count, load status).
 */
"use client";

import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

import type {
  WorkbenchControls, WorkbenchHarness, WorkbenchLogicalThreadRow, WorkbenchThreadListing, WorkbenchThreadListingStructure,
  WorkbenchThreadRuntimeSnapshot,
} from "workbench-shared/types";
import { threadRowLookup } from "./thread-row-lookup";
import type { WorkspaceThreadMember } from "workbench-shared/workbench/workspace/workspace-observation";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot, WorkbenchPinnedThreadLayoutSnapshot, WorkbenchThreadDraft, WorkbenchThreadStateRequest,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectThreadRowSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { ProjectId } from "workbench-shared/workbench/identity";
import { getThreadDocumentFromSnapshot } from "../../workbench/thread/thread-document-keys";
import WorkbenchClientContext, { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";

const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};
const EMPTY_THREAD_RUNTIME_SNAPSHOT: WorkbenchThreadRuntimeSnapshot = {
  currentThread: null,
  currentThreadId: "",
  subagents: [],
  threadDocuments: { documentsByKey: {}, keysByThreadId: {}, selectedThreadKey: "" },
  threads: [],
  threadsError: "",
};
const EMPTY_PROJECT_THREAD_SIDEBARS: WorkbenchProjectThreadRowSidebars = { projects: [] };
const EMPTY_HOME_THREAD_DISPLAY_ORDER: WorkbenchHomeThreadDisplayOrderSnapshot = {
  displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder",
};
const EMPTY_PINNED_THREAD_LAYOUT: WorkbenchPinnedThreadLayoutSnapshot = {
  displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout",
};
const EMPTY_LISTING: WorkbenchThreadListing = {
  members: {}, rows: [], archivedCount: 0, status: { listed: false, loading: false, error: "" },
};

/** Chrome-free surfaces have no Workbench client; they read no sidebar rather than failing to render. */
function useSidebarStore(explicitClient?: WorkbenchClientController) {
  const providedClient = useContext(WorkbenchClientContext);
  return (explicitClient ?? providedClient)?.mounted?.threadSidebar ?? null;
}

function useListing<Value>(select: (listing: WorkbenchThreadListing) => Value) {
  const store = useSidebarStore();
  const read = () => select(store?.getListing?.() ?? EMPTY_LISTING);
  return useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, read, read);
}

export function useThreads(explicitClient?: WorkbenchClientController, threadId?: string) {
  const client = useWorkbenchClientController(explicitClient);
  const controls = client.controls;
  const scoped = threadId
    ? (client.mounted?.threadContextFor(threadId) ?? client.mounted?.draftContextFor(threadId))?.threads : null;
  const store = scoped ?? client.mounted?.threadRuntime;
  const runtime = useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    scoped?.getPublishedSnapshot ?? store?.getSnapshot ?? (() => EMPTY_THREAD_RUNTIME_SNAPSHOT),
    () => EMPTY_THREAD_RUNTIME_SNAPSHOT,
  );
  const document = useCallback(
    (threadId: string) => getThreadDocumentFromSnapshot(runtime.threadDocuments, threadId),
    [runtime.threadDocuments],
  );
  const listModels = useCallback(async (
    harness: WorkbenchHarness,
    options?: Parameters<WorkbenchControls["listModels"]>[1],
  ) => (
    await (scoped?.listModels(harness, options) ?? controls?.listModels(harness, options)) ?? []
  ), [controls, scoped]);
  const subscribeModelUpdates = useCallback(
    (listener: (harness: WorkbenchHarness) => void) => scoped?.subscribeModelUpdates(listener) ?? (() => {}),
    [scoped],
  );
  const updateState = useCallback(async (request: WorkbenchThreadStateRequest) => {
    if (!controls) throw new Error("Workbench controls are not ready.");
    if (scoped) await scoped.requestWorkbench(request.method, request);
    else await controls.updateThreadState(request);
  }, [controls, scoped]);

  return useMemo(() => ({
    current: runtime.currentThread,
    document,
    documents: runtime.threadDocuments,
    threads: runtime.threads,
    listModels,
    subscribeModelUpdates,
    updateState,
  }), [document, listModels, subscribeModelUpdates, runtime, updateState]);
}

function useRuntimeField<Value>(read: (snapshot: WorkbenchThreadRuntimeSnapshot) => Value, explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchClientController(explicitClient).mounted?.threadRuntime ?? null;
  const getSnapshot = () => read(store?.getSnapshot() ?? EMPTY_THREAD_RUNTIME_SNAPSHOT);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
}

/** The route-owned current thread alone, so thread-list runtime pushes don't wake its readers. */
useThreads.current = function useThreadsCurrent(explicitClient?: WorkbenchClientController) {
  return useRuntimeField(snapshot => snapshot.currentThread, explicitClient);
};

useThreads.documents = function useThreadsDocuments(explicitClient?: WorkbenchClientController) {
  return useRuntimeField(snapshot => snapshot.threadDocuments, explicitClient);
};

/** One project's sidebar in every observation mode; null while unknown. */
useThreads.sidebar = function useThreadsSidebar(projectId: ProjectId | "" | null | undefined, explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  const getSnapshot = useCallback(
    () => projectId ? store?.getProjectSnapshot(projectId) ?? null : null,
    [projectId, store],
  );
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
};

/** One project sidebar draft by id; keeps its identity while the draft is unchanged. */
useThreads.draft = function useThreadsDraft(projectId: ProjectId | "" | null | undefined, draftId: string,
  explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  const kept = useRef<WorkbenchThreadDraft | null>(null);
  const getSnapshot = useCallback(() => {
    const entry = projectId && draftId ? store?.getProjectSnapshot(projectId)?.entries.find(candidate =>
      candidate.entryKind === "draft" && candidate.draft.draftId === draftId) : null;
    const next = entry?.entryKind === "draft" ? entry.draft : null;
    if (!areDeeplyEqual(kept.current, next)) kept.current = next;
    return kept.current;
  }, [draftId, projectId, store]);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
};

useThreads.sidebars = function useThreadsSidebars(explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  const getSnapshot = store?.getProjectThreadSidebars ?? (() => EMPTY_PROJECT_THREAD_SIDEBARS);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
};

/** Global home thread ordering and whether this client can change it. */
useThreads.homeOrder = function useThreadsHomeOrder(explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  const order = useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getHomeThreadDisplayOrder ?? (() => EMPTY_HOME_THREAD_DISPLAY_ORDER),
    () => EMPTY_HOME_THREAD_DISPLAY_ORDER,
  );
  const supported = useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getHomeThreadDisplayOrderSupported ?? (() => false),
    () => false,
  );
  return useMemo(() => ({ order, supported }), [order, supported]);
};

useThreads.pinnedLayout = function useThreadsPinnedLayout(explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getPinnedThreadLayout ?? (() => EMPTY_PINNED_THREAD_LAYOUT),
    () => EMPTY_PINNED_THREAD_LAYOUT,
  );
};

const EMPTY_STRUCTURE: WorkbenchThreadListingStructure = { slots: {} };

/** The combined list's placement and member identities; thread activity leaves it unchanged. */
useThreads.structure = function useThreadsStructure() {
  const store = useSidebarStore();
  const read = () => store?.getListingStructure?.() ?? EMPTY_STRUCTURE;
  return useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, read, read);
};

function rowFor(rows: readonly WorkbenchLogicalThreadRow[], key: string) {
  return threadRowLookup(rows).logical.get(key) ?? null;
}

/** One listed row by placement key: its member (title, activity) and its loaded row, null while its summary is pending. */
useThreads.row = function useThreadsRow(key: string) {
  const store = useSidebarStore();
  const kept = useRef<{ member: WorkspaceThreadMember | null; row: WorkbenchLogicalThreadRow | null } | null>(null);
  const read = useCallback(() => {
    const listing = store?.getListing?.() ?? EMPTY_LISTING;
    const member = listing.members[key] ?? null;
    const row = rowFor(listing.rows, key);
    if (kept.current?.member !== member || kept.current.row !== row) kept.current = { member, row };
    return kept.current;
  }, [key, store]);
  return useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, read, read);
};

/** A listed row by `daemonId:physical display key`, for folder-sidebar rows that are also listed; first listing wins. */
useThreads.physicalRow = function useThreadsPhysicalRow(physicalKey: string) {
  const store = useSidebarStore();
  const read = useCallback(() => physicalKey
    ? threadRowLookup(store?.getListing?.().rows ?? []).physical.get(physicalKey) ?? null : null, [physicalKey, store]);
  return useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, read, read);
};

/** The loaded rows for some placement keys, in key order; changes only when one of those rows does. */
useThreads.rowsFor = function useThreadsRowsFor(keys: readonly string[]) {
  const store = useSidebarStore();
  const keyText = keys.join("\n");
  const kept = useRef<readonly WorkbenchLogicalThreadRow[]>([]);
  const read = useCallback(() => {
    const rows = store?.getListing?.().rows ?? [];
    const next = keyText ? keyText.split("\n").flatMap(key => rowFor(rows, key) ?? []) : [];
    if (next.length !== kept.current.length || next.some((row, index) => row !== kept.current[index])) kept.current = next;
    return kept.current;
  }, [keyText, store]);
  return useSyncExternalStore(store?.subscribeListing ?? EMPTY_SUBSCRIBE, read, read);
};

/** The distinct load errors of the given projects' sidebars, as one stable string. */
useThreads.sidebarErrors = function useThreadsSidebarErrors(projectIds: readonly string[]) {
  const store = useSidebarStore();
  const ids = projectIds.join("\n");
  const read = useCallback(() => {
    const selected = new Set(ids.split("\n"));
    return [...new Set((store?.getProjectThreadSidebars?.().projects ?? [])
      .filter(sidebar => selected.has(sidebar.projectId)).map(({ error }) => error).filter(Boolean))].join("\n");
  }, [ids, store]);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, read, read);
};

/** Whether no sidebar has loaded yet for a folder-sidebar list. */
useThreads.sidebarLoading = function useThreadsSidebarLoading(projectId: ProjectId | "") {
  const store = useSidebarStore();
  const read = useCallback(() => !(projectId && store?.getProjectSnapshot(projectId))
    && !(store?.getProjectThreadSidebars?.().projects.length), [projectId, store]);
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, read, read);
};

useThreads.archivedCount = function useThreadsArchivedCount() { return useListing(listing => listing.archivedCount); };
useThreads.status = function useThreadsStatus() { return useListing(listing => listing.status); };
