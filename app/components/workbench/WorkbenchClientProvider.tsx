/*
 * Exports:
 * - WorkbenchClientController: mounted Workbench client, explorer, and transcript comparison read model. Keywords: Workbench client, React, mount.
 * - useWorkbenchClientMount: own async Workbench client mount and disposal around root-owned DOM surfaces. Keywords: lifecycle, bootstrap, domain hook.
 * - useWorkbenchThreads: read and act on the route-owned thread collection through one visible namespace. Keywords: thread controller, aggregate, domain hook.
 * - useWorkbenchThread: bind thread reads and intent methods to one thread identity. Keywords: thread controller, identity, questionnaire.
 * - default WorkbenchClientProvider: provide one mounted Workbench client to nested domain hooks. Keywords: provider, React, controller.
 */

"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
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
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import type WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { getThreadDocumentFromSnapshot } from "../../workbench/thread/thread-document-keys";
import type { WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkbenchDomSurfaces } from "../../workbench/workbench-dom";

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

export interface WorkbenchClientController {
  controls: WorkbenchControls | null;
  explorer: ExplorerSnapshot;
  mounted: MountedWorkbenchClient | null;
  transcriptComparison: {
    available: boolean;
    projection: WorkbenchTranscriptProjection | null;
  };
}

interface WorkbenchClientMountOptions {
  clientStateController: WorkbenchClientStateController;
  getDomSurfaces: () => WorkbenchDomSurfaces | null;
  initialRoute: WorkbenchRoute;
}

const WorkbenchClientContext = createContext<WorkbenchClientController | null>(null);

export function useWorkbenchClientMount(options: WorkbenchClientMountOptions): WorkbenchClientController {
  const [mounted, setMounted] = useState<MountedWorkbenchClient | null>(null);
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [transcriptComparison, setTranscriptComparison] = useState<WorkbenchClientController["transcriptComparison"]>({
    available: false,
    projection: null,
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
          onTranscriptComparisonChange: (available, projection) => {
            if (cancelled) return;
            startTransition(() => {
              if (!cancelled) setTranscriptComparison({ available, projection });
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
    transcriptComparison,
  }), [explorer, mounted, transcriptComparison]);
}

function useWorkbenchClientController(explicitClient?: WorkbenchClientController) {
  const providedClient = useContext(WorkbenchClientContext);
  const client = explicitClient ?? providedClient;
  if (!client) {
    throw new Error("Workbench domain hooks require WorkbenchClientProvider.");
  }
  return client;
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
    sidebar: client.mounted?.threadSidebar ?? null,
    submitQuestionnaire,
    updateState,
  }), [
    client.mounted?.threadSidebar,
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

export default function WorkbenchClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client: WorkbenchClientController;
}) {
  return <WorkbenchClientContext.Provider value={client}>{children}</WorkbenchClientContext.Provider>;
}
