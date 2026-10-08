/*
 * Exports:
 * - useWorkbenchClientMount: own async Workbench client mount and disposal around root-owned DOM surfaces.
 * - useWorkbenchThreads: read and act on the route-owned thread collection through one visible namespace.
 * - useWorkbenchModelCatalogues: subscribe to the thread owner's account model cache by identity.
 * - useWorkbenchProjectThreadSidebar: read one project-owned sidebar in every observation mode.
 * - useThreadClaimIntersections/useThreadCollisionEntries/useThreadArcEntry: select narrow source-qualified Git arc facts.
 * - useWorkbenchThreadSidebarEntry: read one project-owned thread sidebar entry by identity.
 * - useWorkbenchThreadTitleHistory: read previous titles and apply project-qualified rename/dismiss intent.
 * - useWorkbenchThreadRow: observe one thread's live lean row from any project by id.
 * - useWorkbenchProjectThreadSidebars: read the aggregate project sidebar projection.
 * - useWorkbenchProjectThreadSummaries: read the aggregate project summary projection.
 * - useWorkbenchHomeThreadDisplayOrder: read global home thread ordering.
 * - useWorkbenchHomeThreadDisplayOrderSupported: read global home ordering capability.
 * - useWorkbenchPinnedThreadLayout: read global pinned thread layout.
 * - useWorkbenchThreadTextPresentationField: subscribe to one exact streaming text field.
 * - useWorkbenchThreadFileIndex: read the owning daemon folder's file suggestions without selecting browse state.
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
  WorkbenchModelOption,
  WorkbenchThreadRuntimeSnapshot,
  WorkbenchThreadSidebarStore,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot,
  WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchProjectThreadSummaries,
} from "workbench-shared/workbench/thread/thread-state";
import type {
  WorkbenchProjectThreadRowSidebars as WorkbenchProjectThreadSidebars,
  WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry,
  WorkbenchThreadSidebarRowSnapshot as WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-sidebar-row";
import {
  createWorkbenchThreadClaimIntersectionSelector,
  type WorkbenchHarnessId,
} from "workbench-shared/workbench/thread/thread-state";
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkspaceThreadRow } from "workbench-shared/workbench/workspace/workspace-observation";
import type WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import type WorkbenchAppRpcClient from "../../workbench/app/WorkbenchAppRpcClient";
import { getThreadDocumentFromSnapshot } from "../../workbench/thread/thread-document-keys";
import type { WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchDomSurfaces } from "../../workbench/workbench-dom";
import type { ThreadTextPresentationKey } from "../../workbench/thread/ThreadTextPresentationController";
import WorkbenchClientContext, { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
import ThreadTextPresentationContext from "./ThreadTextPresentationContext";
import { useThread } from "./use-thread";
import type { DaemonId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchProjectFileIndexSnapshot } from "../../workbench/project/WorkbenchProjectFileIndexStore";
import { useWorkbenchWorkspace } from "./WorkbenchWorkspaceContext";

const MISSING_THREAD_FILE_INDEX: WorkbenchProjectFileIndexSnapshot = {
  candidates: [], paths: [], id: "project-files:missing-owner",
  status: "error", error: "The thread's daemon folder is unavailable for file suggestions.",
};

export function useWorkbenchThreadFileIndex(threadId: string, enabled: boolean) {
  const client = useWorkbenchClientController();
  const store = client.mounted?.projectFileIndexStore ?? null;
  const context = enabled
    ? client.mounted?.threadContextFor(threadId) ?? client.mounted?.draftContextFor(threadId)
    : null;
  const daemonId = context?.daemonId ?? null;
  const projectId = context?.project.id ?? null;
  const target = useMemo(() => daemonId && projectId ? { daemonId, projectId } : null,
    [daemonId, projectId]);
  const subscribe = useCallback((listener: () => void) =>
    store?.subscribe(target, listener) ?? (() => undefined), [store, target]);
  const getSnapshot = useCallback(() => store?.getSnapshot(target) ?? MISSING_THREAD_FILE_INDEX,
    [store, target]);
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
}

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
const EMPTY_MODEL_CATALOGUES: ReadonlyMap<WorkbenchHarness, readonly WorkbenchModelOption[]> = new Map();

export function useWorkbenchModelCatalogues(threadId: string) {
  const mounted = useWorkbenchClientController().mounted;
  const store = (mounted?.threadContextFor(threadId) ?? mounted?.draftContextFor(threadId))?.threads;
  return useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getModelCatalogues ?? (() => EMPTY_MODEL_CATALOGUES),
    () => EMPTY_MODEL_CATALOGUES,
  );
}
const EMPTY_PROJECT_SOURCE_ERROR = () => "";
const INITIAL_PRESENTATION: ReturnType<NonNullable<MountedWorkbenchClient["presentationClient"]>["snapshot"]> = {
  phase: "idle", error: null, data: null,
};
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
  appRpc: WorkbenchAppRpcClient | null;
  clientStateController: WorkbenchClientStateController;
  getDomSurfaces: () => WorkbenchDomSurfaces | null;
  initialRoute: WorkbenchRoute;
}

export function useWorkbenchClientMount(options: WorkbenchClientMountOptions): WorkbenchClientController & {
  startup: { phase: "loading" | "ready" | "failed"; error: string | null };
  projectSourceError: string;
} {
  const workspace = useWorkbenchWorkspace();
  const [mounted, setMounted] = useState<MountedWorkbenchClient | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let mountedClient: MountedWorkbenchClient | null = null;
    const timeoutId = window.setTimeout(() => {
      void import("../../WorkbenchClient").then(({ WorkbenchClient }) => {
        const current = optionsRef.current;
        const nextMounted = WorkbenchClient({
          workspace,
          appRpc: current.appRpc,
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
      }).catch(error => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message.slice(0, 512)
          : "Workbench client could not mount.";
        setMountError(message);
        console.error("Workbench client could not mount:", message);
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      mountedClient?.dispose();
    };
  }, [options.clientStateController, workspace]);

  const presentation = useSyncExternalStore(
    mounted?.presentationClient?.subscribe ?? EMPTY_SUBSCRIBE,
    mounted?.presentationClient?.snapshot ?? (() => INITIAL_PRESENTATION),
    () => INITIAL_PRESENTATION,
  );
  const projectSourceError = useSyncExternalStore(
    mounted?.projectSourceErrors.subscribe ?? EMPTY_SUBSCRIBE,
    mounted?.projectSourceErrors.getSnapshot ?? EMPTY_PROJECT_SOURCE_ERROR,
    EMPTY_PROJECT_SOURCE_ERROR,
  );
  return useMemo(() => ({
    controls: mounted?.controls ?? null,
    explorer,
    mounted,
    projectSourceError,
    startup: { phase: mountError ? "failed" as const : mounted ? "ready" as const : "loading" as const, error: mountError },
  }), [explorer, mountError, mounted, presentation, projectSourceError]);
}

export function useWorkbenchThreadTextPresentationField(
  key: ThreadTextPresentationKey | null,
  canonicalText: string,
  explicitClient?: WorkbenchClientController,
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

function useOwnerSource(threadId: string) {
  const client = useWorkbenchClientController();
  const store = client.mounted?.threadSidebar ?? null;
  const owner = client.mounted?.threadOwnerFor(threadId) ?? null;
  const daemonId = owner?.daemonId;
  const projectId = owner?.projectId;
  const logicalProjectId = owner ? client.explorer.logicalProjects?.find(project =>
    project.locations.some(location => location.daemonId === owner.daemonId
      && location.target.projectId === owner.projectId))?.id ?? null : null;
  return { store, daemonId, projectId, logicalProjectId };
}

function ownerSourceSnapshot(
  store: WorkbenchThreadSidebarStore | null, daemonId: DaemonId | undefined, projectId: ProjectId | undefined,
) {
  return daemonId && projectId
    ? store?.getLocationSnapshot?.({ daemonId, projectId }) ?? null : null;
}

export function useThreadClaimIntersections(
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
}

export function useThreadCollisionEntries(
  threadId: string,
  owners: readonly { harness: string; threadId: string }[],
) {
  const { store, daemonId, projectId, logicalProjectId } = useOwnerSource(threadId);
  const ownerKey = owners.map(owner => `${owner.harness.toLowerCase()}\0${owner.threadId.toLowerCase()}`).sort().join("\n");
  const select = useMemo(() => {
    let selected: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>[] = [];
    const keys = new Set(ownerKey.split("\n"));
    return (snapshot: WorkbenchThreadSidebarSnapshot | null) => {
      const next = (snapshot?.entries ?? []).filter((entry): entry is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> =>
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
}

export function useThreadArcEntry(threadId: string, harness: WorkbenchHarnessId) {
  const { store, daemonId, projectId } = useOwnerSource(threadId);
  const select = useMemo(() => {
    let selected: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> | null = null;
    return (snapshot: WorkbenchThreadSidebarSnapshot | null) => {
      const next = snapshot?.entries.find((entry): entry is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> =>
        entry.entryKind === "thread" && entry.identity.harness === harness && entry.identity.threadId === threadId) ?? null;
      if (areDeeplyEqual(selected, next)) return selected;
      selected = next;
      return selected;
    };
  }, [harness, threadId]);
  const getSnapshot = useCallback(() => select(ownerSourceSnapshot(store, daemonId, projectId)),
    [daemonId, projectId, select, store]);
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

/** One thread's live lean row from any project, independent of which rows a view lists; null while loading or unknown. */
export function useWorkbenchThreadRow(threadId: string | null) {
  const workspace = useWorkbenchClientController().mounted?.workspace ?? null;
  const [row, setRow] = useState<WorkspaceThreadRow | null>(null);
  useEffect(() => {
    setRow(null);
    const parsed = threadId ? ThreadReferenceSchema.safeParse(threadId) : null;
    if (!workspace || !parsed?.success) return;
    let handle: { getSnapshot(): { value: { data: WorkspaceThreadRow | null } | null }; release(): void } | null = null;
    const read = () => { if (handle) setRow(handle.getSnapshot().value?.data ?? null); };
    handle = workspace.observe({ kind: "threadRow", threadId: parsed.data }, read);
    read();
    return () => handle?.release();
  }, [threadId, workspace]);
  return row;
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
  const thread = useThread(projectId, { kind: "provider", harness, threadId });
  const entry = thread.entry;
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

export function useWorkbenchThreads(explicitClient?: WorkbenchClientController, threadId?: string) {
  const client = useWorkbenchClientController(explicitClient);
  const controls = client.controls;
  const scoped = threadId
    ? (client.mounted?.threadContextFor(threadId)
      ?? client.mounted?.draftContextFor(threadId))?.threads : null;
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
    goals: scoped?.threadGoals ?? controls?.threadGoals ?? null,
    skills: scoped?.threadSkills ?? controls?.threadSkills ?? null,
    listModels,
    subscribeModelUpdates,
    updateState,
  }), [
    controls?.threadGoals,
    controls?.threadSkills,
    scoped,
    document,
    listModels,
    subscribeModelUpdates,
    runtime,
    updateState,
  ]);
}
