/*
 * Exports:
 * - useWorkbenchClientMount: own async Workbench client mount and disposal around root-owned DOM surfaces.
 * - useWorkbenchThreads: read and act on the route-owned thread collection through one visible namespace.
 * - useWorkbenchProjectThreadSidebar: read one project-owned sidebar in every observation mode.
 * - useWorkbenchThreadSidebarEntry: read one project-owned thread sidebar entry by identity.
 * - useWorkbenchThreadTitleHistory: read previous titles and apply project-qualified rename/dismiss intent.
 * - useWorkbenchProjectThreadSidebars: read the aggregate project sidebar projection.
 * - useWorkbenchProjectThreadSummaries: read the aggregate project summary projection.
 * - useWorkbenchHomeThreadDisplayOrder: read global home thread ordering.
 * - useWorkbenchHomeThreadDisplayOrderSupported: read global home ordering capability.
 * - useWorkbenchPinnedThreadLayout: read global pinned thread layout.
 * - useWorkbenchThreadTextPresentationField: subscribe to one exact streaming text field.
 */
"use client";

import {
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { MountedWorkbenchClient } from "../../WorkbenchClient";
import type {
  ExplorerSnapshot,
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchReadThreadOptions,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadRuntimeSnapshot,
  WorkbenchUserInputResponse,
} from "workbench-shared/types";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot,
  WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchProjectThreadSidebars,
  WorkbenchProjectThreadSummaries,
  WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import type WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { getThreadDocumentFromSnapshot } from "../../workbench/thread/thread-document-keys";
import type { WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchDomSurfaces } from "../../workbench/workbench-dom";
import type { ThreadTextPresentationKey } from "../../workbench/thread/ThreadTextPresentationController";
import WorkbenchClientContext, { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
import ThreadTextPresentationContext from "./ThreadTextPresentationContext";
import { useWorkbenchThread } from "./use-workbench-thread";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  changes: {},
  configuredDiscoveryRootPath: null,
  currentPath: "",
  currentProjectId: "",
  currentThreadId: "",
  expandedDirectories: [""],
  fontSize: 1.08,
  isProjectLoading: false,
  isThreadsLoading: false,
  locallyModifiedPaths: [],
  projectFileCandidates: ProjectTreeFileIndex.empty.candidates,
  projectFileIndexId: ProjectTreeFileIndex.empty.id,
  projectFileIndexKey: ProjectTreeFileIndex.empty.key,
  projectFilePaths: ProjectTreeFileIndex.empty.paths,
  projects: [],
  root: "Project",
  rootPath: "",
  roots: [],
  subagents: [],
  threads: [],
  threadsError: "",
  tree: [],
  workbenchStorageRootPath: "",
};

const EMPTY_THREAD_RUNTIME_SNAPSHOT: WorkbenchThreadRuntimeSnapshot = {
  currentThread: null,
  currentThreadId: "",
  isLoading: false,
  pendingUserInputRequestsByThreadId: {},
  rateLimits: null,
  subagents: [],
  threadDocuments: {
    documentsByKey: {},
    keysByThreadId: {},
    selectedThreadKey: "",
  },
  threads: [],
  threadsError: "",
};
const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};
const EMPTY_PROJECT_THREAD_SIDEBARS: WorkbenchProjectThreadSidebars = { projects: [] };
const EMPTY_PROJECT_THREAD_SUMMARIES: WorkbenchProjectThreadSummaries = { projects: [] };
const EMPTY_HOME_THREAD_DISPLAY_ORDER: WorkbenchHomeThreadDisplayOrderSnapshot = {
  displayOrder: {},
  revision: 0,
  updateKind: "homeThreadDisplayOrder",
};
const EMPTY_PINNED_THREAD_LAYOUT: WorkbenchPinnedThreadLayoutSnapshot = {
  displayOrder: {},
  revision: 0,
  updateKind: "pinnedThreadLayout",
};
type ProviderThreadSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

interface WorkbenchClientMountOptions {
  clientStateController: WorkbenchClientStateController;
  getDomSurfaces: () => WorkbenchDomSurfaces | null;
  initialRoute: WorkbenchRoute;
}

export function useWorkbenchClientMount(options: WorkbenchClientMountOptions): WorkbenchClientController {
  const [mounted, setMounted] = useState<MountedWorkbenchClient | null>(null);
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let mountedClient: MountedWorkbenchClient | null = null;
    const timeoutId = window.setTimeout(() => {
      void import("../../WorkbenchClient").then(async ({ WorkbenchClient }) => {
        const current = optionsRef.current;
        const nextMounted = await WorkbenchClient({
          clientStateController: current.clientStateController,
          dom: current.getDomSurfaces(),
          initialRoute: current.initialRoute,
          onExplorerStateChange: (snapshot) => {
            if (cancelled) return;
            startTransition(() => {
              if (!cancelled) setExplorer(snapshot);
            });
          },
        });
        if (cancelled) {
          nextMounted.dispose();
          return;
        }
        mountedClient = nextMounted;
        setMounted(nextMounted);
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      mountedClient?.dispose();
    };
  }, [options.clientStateController]);

  return useMemo(() => ({
    controls: mounted?.controls ?? null,
    explorer,
    mounted,
  }), [explorer, mounted]);
}

export function useWorkbenchThreadTextPresentationField(
  key: ThreadTextPresentationKey | null,
  canonicalText: string,
  explicitClient?: WorkbenchClientController,
) {
  const providedClient = useContext(WorkbenchClientContext);
  const standaloneText = useContext(ThreadTextPresentationContext);
  const controller = (explicitClient ?? providedClient)?.mounted?.threadTextPresentation ?? standaloneText;
  const stableKey = useMemo<ThreadTextPresentationKey | null>(() => key ? {
    field: key.field,
    index: key.index,
    itemId: key.itemId,
    source: { kind: key.source.kind, sourceKey: key.source.sourceKey },
    threadId: key.threadId,
    turnId: key.turnId,
  } : null, [
    key?.field,
    key?.index,
    key?.itemId,
    key?.source.kind,
    key?.source.sourceKey,
    key?.threadId,
    key?.turnId,
  ]);
  const getSnapshot = useCallback(
    () => stableKey ? controller?.getSnapshot(stableKey) ?? canonicalText : canonicalText,
    [canonicalText, controller, stableKey],
  );
  const subscribe = useCallback((listener: () => void) => (
    stableKey && controller
      ? controller.subscribe(stableKey, canonicalText, listener)
      : EMPTY_SUBSCRIBE(listener)
  ), [canonicalText, controller, stableKey]);
  return useSyncExternalStore(subscribe, getSnapshot, () => canonicalText);
}

function useWorkbenchThreadSidebarStore(explicitClient?: WorkbenchClientController) {
  return useWorkbenchClientController(explicitClient).mounted?.threadSidebar ?? null;
}

export function useWorkbenchProjectThreadSidebar(projectId: ProjectId | "" | null | undefined, explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  const getSnapshot = useCallback(
    () => projectId ? store?.getProjectSnapshot(projectId) ?? null : null,
    [projectId, store],
  );
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
}

export function useWorkbenchThreadSidebarEntry(
  projectId: ProjectId | "" | null | undefined,
  harness: WorkbenchHarness,
  threadId: string,
  explicitClient?: WorkbenchClientController,
) {
  const snapshot = useWorkbenchProjectThreadSidebar(projectId, explicitClient);
  return useMemo(() => snapshot?.entries.find((entry): entry is ProviderThreadSidebarEntry => (
    entry.entryKind !== "draft"
    && entry.identity.harness === harness
    && entry.identity.threadId === threadId
  )) ?? null, [harness, snapshot, threadId]);
}

export function useWorkbenchProjectThreadSidebars(explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getProjectThreadSidebars ?? (() => EMPTY_PROJECT_THREAD_SIDEBARS),
    () => EMPTY_PROJECT_THREAD_SIDEBARS,
  );
}

export function useWorkbenchThreadTitleHistory(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId) {
  const client = useWorkbenchClientController();
  const thread = useWorkbenchThread(projectId, { kind: "provider", harness, threadId });
  const entry = thread.state.entry;
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
  return {
    previousTitles: entry?.previousTitles ?? [],
    reapply,
    dismiss,
  };
}

export function useWorkbenchProjectThreadSummaries(explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  const getSnapshot = store?.getProjectThreadSummaries ?? (() => EMPTY_PROJECT_THREAD_SUMMARIES);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    getSnapshot,
    getSnapshot,
  );
}

export function useWorkbenchHomeThreadDisplayOrder(explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getHomeThreadDisplayOrder ?? (() => EMPTY_HOME_THREAD_DISPLAY_ORDER),
    () => EMPTY_HOME_THREAD_DISPLAY_ORDER,
  );
}

export function useWorkbenchHomeThreadDisplayOrderSupported(explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getHomeThreadDisplayOrderSupported ?? (() => false),
    () => false,
  );
}

export function useWorkbenchPinnedThreadLayout(explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getPinnedThreadLayout ?? (() => EMPTY_PINNED_THREAD_LAYOUT),
    () => EMPTY_PINNED_THREAD_LAYOUT,
  );
}

export function useWorkbenchThreads(explicitClient?: WorkbenchClientController) {
  const client = useWorkbenchClientController(explicitClient);
  const controls = client.controls;
  const store = client.mounted?.threadRuntime;
  const runtime = useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getSnapshot ?? (() => EMPTY_THREAD_RUNTIME_SNAPSHOT),
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
    await controls?.listModels(harness, options) ?? []
  ), [controls]);
  const pendingQuestionnaire = useCallback(
    (threadId: string) => runtime.pendingUserInputRequestsByThreadId[threadId] ?? null,
    [runtime.pendingUserInputRequestsByThreadId],
  );
  const read = useCallback(async (
    threadId: string,
    harness?: WorkbenchHarness,
    options?: WorkbenchReadThreadOptions,
  ) => (
    await controls?.readThread(threadId, harness, options) ?? null
  ), [controls]);
  const submitQuestionnaire = useCallback(async (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => {
    if (!controls) throw new Error("Workbench controls are not ready.");
    await controls.submitPendingUserInputRequest(threadId, response, options);
  }, [controls]);
  const updateState = useCallback(async (request: WorkbenchThreadStateRequest) => {
    if (!controls) throw new Error("Workbench controls are not ready.");
    await controls.updateThreadState(request);
  }, [controls]);

  return useMemo(() => ({
    current: runtime.currentThread,
    document,
    documents: runtime.threadDocuments,
    goals: controls?.threadGoals ?? null,
    listModels,
    pendingQuestionnaire,
    pendingQuestionnairesByThreadId: runtime.pendingUserInputRequestsByThreadId,
    rateLimits: runtime.rateLimits,
    read,
    submitQuestionnaire,
    updateState,
  }), [
    controls?.threadGoals,
    document,
    listModels,
    pendingQuestionnaire,
    read,
    runtime,
    submitQuestionnaire,
    updateState,
  ]);
}
