/*
 * Exports:
 * - useWorkbenchClientMount: own async Workbench client mount and disposal around root-owned DOM surfaces. Keywords: lifecycle, bootstrap, client.
 * - useWorkbenchThreads: read and act on the route-owned thread collection through one visible namespace. Keywords: threads, runtime, controller.
 * - useWorkbenchThread: bind thread reads and intent methods to one thread identity. Keywords: thread, identity, questionnaire.
 * - useWorkbenchProjectThreadSidebar: read one project-owned sidebar in every observation mode. Keywords: project, sidebar, snapshot.
 * - useWorkbenchThreadSidebarEntry: read one project-owned thread sidebar entry by identity. Keywords: thread, sidebar, lifecycle.
 * - useWorkbenchProjectThreadSidebars: read the aggregate project sidebar projection. Keywords: home, projects, sidebar.
 * - useWorkbenchProjectThreadSummaries: read the aggregate project summary projection. Keywords: project, summary, status.
 * - useWorkbenchHomeThreadDisplayOrder: read global home thread ordering. Keywords: home, order, sidebar.
 * - useWorkbenchHomeThreadDisplayOrderSupported: read global home ordering capability. Keywords: home, capability, ordering.
 * - useWorkbenchPinnedThreadLayout: read global pinned thread layout. Keywords: pinned, layout, sidebar.
 * - useWorkbenchThreadTextPresentationField: subscribe to one exact streaming text field. Keywords: thread, text, presentation, leaf.
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
  ThreadPayload,
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
import WorkbenchClientContext, { type WorkbenchClientController } from "./workbench-client-context";

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  changes: {},
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
  const [transcriptSource, setTranscriptSource] = useState<WorkbenchClientController["transcriptSource"]>({
    status: "idle",
  });
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
          onTranscriptSourceChange: (state) => {
            if (cancelled) return;
            setTranscriptSource(state);
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
    transcriptSource,
  }), [explorer, mounted, transcriptSource]);
}

function useWorkbenchClientController(explicitClient?: WorkbenchClientController) {
  const providedClient = useContext(WorkbenchClientContext);
  const client = explicitClient ?? providedClient;
  if (!client) {
    throw new Error("Workbench domain hooks require WorkbenchClientProvider.");
  }
  return client;
}

export function useWorkbenchThreadTextPresentationField(
  key: ThreadTextPresentationKey | null,
  canonicalText: string,
  explicitClient?: WorkbenchClientController,
) {
  const providedClient = useContext(WorkbenchClientContext);
  const controller = (explicitClient ?? providedClient)?.mounted?.threadTextPresentation ?? null;
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

export function useWorkbenchProjectThreadSidebar(projectId: string | null | undefined, explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  const getSnapshot = useCallback(
    () => projectId ? store?.getProjectSnapshot(projectId) ?? null : null,
    [projectId, store],
  );
  return useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, getSnapshot, getSnapshot);
}

export function useWorkbenchThreadSidebarEntry(
  projectId: string | null | undefined,
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

export function useWorkbenchProjectThreadSummaries(explicitClient?: WorkbenchClientController) {
  const store = useWorkbenchThreadSidebarStore(explicitClient);
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getProjectThreadSummaries ?? (() => EMPTY_PROJECT_THREAD_SUMMARIES),
    () => EMPTY_PROJECT_THREAD_SUMMARIES,
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

export function useWorkbenchThread(threadId: string, explicitClient?: WorkbenchClientController) {
  const client = useWorkbenchClientController(explicitClient);
  const threads = useWorkbenchThreads(client);
  const document = threads.document(threadId) ?? null;
  const changeAgent = useCallback((agentPath: string | null) => {
    client.controls?.setCurrentThreadAgent(threadId, agentPath);
  }, [client.controls, threadId]);
  const changeModel = useCallback((model: string) => {
    client.controls?.setCurrentThreadModel(threadId, model);
  }, [client.controls, threadId]);
  const changeReasoningEffort = useCallback((effort: string | null) => {
    client.controls?.setCurrentThreadReasoningEffort(threadId, effort);
  }, [client.controls, threadId]);
  const changeServiceTier = useCallback((serviceTier: string | null) => {
    client.controls?.setCurrentThreadServiceTier(threadId, serviceTier);
  }, [client.controls, threadId]);
  const compact = useCallback(async (source: ThreadPayload | null = document) => (
    source ? await client.controls?.compactThread(source) ?? null : null
  ), [client.controls, document]);
  const read = useCallback(async (harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => (
    await threads.read(threadId, harness, options)
  ), [threadId, threads.read]);
  const stop = useCallback(async (source: ThreadPayload | null = document) => (
    source ? await client.controls?.stopThread(source) ?? null : null
  ), [client.controls, document]);
  const submitQuestionnaire = useCallback(async (
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => {
    await threads.submitQuestionnaire(threadId, response, options);
  }, [threadId, threads.submitQuestionnaire]);

  return useMemo(() => ({
    changeAgent,
    changeModel,
    changeReasoningEffort,
    changeServiceTier,
    compact,
    document,
    pendingQuestionnaire: threads.pendingQuestionnaire(threadId),
    rateLimits: threads.rateLimits,
    read,
    stop,
    submitQuestionnaire,
    threads,
    updateState: threads.updateState,
  }), [
    changeAgent,
    changeModel,
    changeReasoningEffort,
    changeServiceTier,
    compact,
    document,
    read,
    stop,
    submitQuestionnaire,
    threadId,
    threads,
  ]);
}
