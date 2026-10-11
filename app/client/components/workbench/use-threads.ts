/*
 * Exports:
 * - useThreads: read and act on the route-owned thread collection; members read the sidebars, home and pinned ordering, and the combined thread listing (placement, members, rows, folders, archived count, load status).
 */
"use client";

import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import type {
  WorkbenchControls, WorkbenchHarness, WorkbenchThreadListing, WorkbenchThreadRuntimeSnapshot,
} from "workbench-shared/types";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot, WorkbenchPinnedThreadLayoutSnapshot, WorkbenchThreadStateRequest,
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

/** One project's sidebar in every observation mode; null while unknown. */
useThreads.sidebar = function useThreadsSidebar(projectId: ProjectId | "" | null | undefined, explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  const getSnapshot = useCallback(
    () => projectId ? store?.getProjectSnapshot(projectId) ?? null : null,
    [projectId, store],
  );
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
};

useThreads.sidebars = function useThreadsSidebars(explicitClient?: WorkbenchClientController) {
  const store = useSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getProjectThreadSidebars ?? (() => EMPTY_PROJECT_THREAD_SIDEBARS),
    () => EMPTY_PROJECT_THREAD_SIDEBARS,
  );
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

useThreads.placement = function useThreadsPlacement() { return useListing(listing => listing.placement); };
useThreads.members = function useThreadsMembers() { return useListing(listing => listing.members); };
useThreads.member = function useThreadsMember(key: string) { return useListing(listing => listing.members[key] ?? null); };
useThreads.rows = function useThreadsRows() { return useListing(listing => listing.rows); };
useThreads.folders = function useThreadsFolders() { return useListing(listing => listing.folders); };
useThreads.archivedCount = function useThreadsArchivedCount() { return useListing(listing => listing.archivedCount); };
useThreads.status = function useThreadsStatus() { return useListing(listing => listing.status); };
