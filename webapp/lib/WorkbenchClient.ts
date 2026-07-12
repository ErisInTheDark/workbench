/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, polling, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, polling.
 */

import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "./codex/thread-state";
import type {
    ExplorerSnapshot,
    WorkbenchPendingUserInputRequest,
    ThreadPayload,
    WorkbenchBindings,
    WorkbenchControls,
    WorkbenchHarness,
    WorkbenchRouteLoadResult,
    WorkbenchReadThreadOptions,
    WorkbenchSendThreadMessageOptions,
    WorkbenchThreadDocumentSnapshot,
} from "./types";
import { areDeeplyEqual } from "./workbench/deep-equality";
import {
    createProjectRoute,
    type WorkbenchRoute,
} from "./workbench/navigation/workbench-route";
import {
    readStoredHarness,
    readStoredFontSize,
} from "./workbench/state/browser-state";
import ActiveTabRefreshLeader from "./workbench/state/ActiveTabRefreshLeader";
import FileDraftStore from "./workbench/state/FileDraftStore";
import LifecycleScope from "./workbench/state/LifecycleScope";
import SessionState from "./workbench/state/SessionState";
import {
    type WorkbenchEditorDomSurfaces,
    type WorkbenchDomSurfaces,
} from "./workbench/workbench-dom";
import WorkbenchFilePanelClient from "./workbench/WorkbenchFilePanelClient";
import type { WorkbenchFilePanelClientOptions } from "./workbench/WorkbenchFilePanelClient";
import WorkbenchProjectClient from "./workbench/WorkbenchProjectClient";
import WorkbenchThreadClient from "./workbench/WorkbenchThreadClient";
import { getTurnRenderSignature } from "./workbench/thread/thread-item-signature";

const AUTO_REFRESH_INTERVAL_MS = 1500;

type MountedWorkbenchControls = WorkbenchControls & {
  createFilePanelClient: (
    surfaces: WorkbenchEditorDomSurfaces,
    options?: Partial<Omit<WorkbenchFilePanelClientOptions, "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">>,
  ) => ReturnType<typeof WorkbenchFilePanelClient>;
};

function areExplorerSnapshotsEquivalent(left: ExplorerSnapshot | null, right: ExplorerSnapshot) {
  if (!left) {
    return false;
  }

  return left.currentProjectId === right.currentProjectId
    && left.root === right.root
    && left.rootPath === right.rootPath
    && left.projectFileIndexId === right.projectFileIndexId
    && left.projectFileIndexKey === right.projectFileIndexKey
    && left.isProjectLoading === right.isProjectLoading
    && left.isThreadsLoading === right.isThreadsLoading
    && left.currentPath === right.currentPath
    && left.currentThreadId === right.currentThreadId
    && left.threadsError === right.threadsError
    && left.fontSize === right.fontSize
    && left.workbenchStorageRootPath === right.workbenchStorageRootPath
    && left.projectFileCandidates === right.projectFileCandidates
    && left.projectFilePaths === right.projectFilePaths
    && (left.projects === right.projects || areDeeplyEqual(left.projects, right.projects))
    && (left.roots === right.roots || areDeeplyEqual(left.roots, right.roots))
    && (left.tree === right.tree || areDeeplyEqual(left.tree, right.tree))
    && (left.threads === right.threads || areDeeplyEqual(left.threads, right.threads))
    && (left.changes === right.changes || areDeeplyEqual(left.changes, right.changes))
    && (left.expandedDirectories === right.expandedDirectories || areDeeplyEqual(left.expandedDirectories, right.expandedDirectories))
    && (left.locallyModifiedPaths === right.locallyModifiedPaths || areDeeplyEqual(left.locallyModifiedPaths, right.locallyModifiedPaths));
}

export async function WorkbenchClient(
  bindings: WorkbenchBindings & { dom?: WorkbenchDomSurfaces | null } = {},
): Promise<() => void> {
  const { ...workbenchBindings } = bindings;

  const coordinatorLifecycle = new LifecycleScope();
  let explorerStateChangeScheduled = false;
  let lastEmittedExplorerSnapshot: ExplorerSnapshot | null = null;
  let reportStatusMessage = (_message: string) => {};
  let activeRoute: WorkbenchRoute = workbenchBindings.initialRoute ?? createProjectRoute("");
  let activeRouteGeneration = 0;
  const projectClient = WorkbenchProjectClient();
  let hasAutoRefreshLeaderState = false;
  let isAutoRefreshLeader = false;
  const threadClient = WorkbenchThreadClient({
    onCollaborationStateUpdated: (projectId, state) => {
      workbenchBindings.onCollaborationStateUpdated?.(projectId, state);
    },
    onStatusMessage: (message) => {
      reportStatusMessage(message);
    },
    onThreadStarted: (thread) => {
      if (activeRoute.view !== "thread" || activeRoute.threadId !== thread.id) {
        return;
      }
      emitExplorerStateChange();
    },
    shouldRunNotificationThreadListRefresh: () => !hasAutoRefreshLeaderState || isAutoRefreshLeader,
  });
  const initialThreadSnapshot = threadClient.getSnapshot();
  const sessionState = SessionState({
    currentThread: initialThreadSnapshot.currentThread,
    currentThreadId: initialThreadSnapshot.currentThreadId,
  });
  const draftStore = FileDraftStore(
    () => projectClient.getSnapshot().currentProjectId,
    emitExplorerStateChange,
  );
  let activeFilePath = "";
  let activeProjectId = projectClient.getSnapshot().currentProjectId;
  coordinatorLifecycle.addUnsubscribe(projectClient.subscribe((snapshot) => {
    const previousProjectId = activeProjectId;
    activeProjectId = snapshot.currentProjectId;
    threadClient.setProjectContext({
      projectId: snapshot.currentProjectId,
      root: snapshot.root,
      rootPath: snapshot.rootPath,
      roots: snapshot.roots,
    });
    if (previousProjectId && previousProjectId !== snapshot.currentProjectId) {
      activeFilePath = "";
      void draftStore.hydratePersistedDrafts();
    }
    emitExplorerStateChange();
  }));

  let previousThreadSnapshot = initialThreadSnapshot;
  coordinatorLifecycle.addUnsubscribe(threadClient.subscribe((snapshot) => {
    const lastSnapshot = previousThreadSnapshot;
    previousThreadSnapshot = snapshot;

    if (
      !areThreadPayloadsEquivalent(lastSnapshot.currentThread, snapshot.currentThread)
      || lastSnapshot.currentThreadId !== snapshot.currentThreadId
    ) {
      const nextThreadId = snapshot.currentThread?.id ?? snapshot.currentThreadId;
      if (activeRoute.view === "thread" && nextThreadId === activeRoute.threadId) {
        applyCurrentThreadSelection(snapshot.currentThread);
      }
    }

    if (lastSnapshot.rateLimits !== snapshot.rateLimits) {
      emitRateLimitsChange();
    }

    if (!arePendingUserInputRequestsEquivalent(
      lastSnapshot.pendingUserInputRequestsByThreadId,
      snapshot.pendingUserInputRequestsByThreadId,
    )) {
      emitPendingUserInputRequestsChange();
    }

    if (lastSnapshot.threadDocuments !== snapshot.threadDocuments) {
      emitThreadDocumentsChange(snapshot.threadDocuments);
    }

    if (
      lastSnapshot.currentThreadId !== snapshot.currentThreadId
      || lastSnapshot.threads !== snapshot.threads
      || lastSnapshot.threadsError !== snapshot.threadsError
    ) {
      emitExplorerStateChange();
    }
  }));

  document.execCommand?.("defaultParagraphSeparator", false, "p");

  reportStatusMessage = (message) => {
    void message;
  };
  let previousSessionSnapshot = sessionState.getSnapshot();
  coordinatorLifecycle.addUnsubscribe(sessionState.subscribe((snapshot) => {
    const lastSnapshot = previousSessionSnapshot;
    previousSessionSnapshot = snapshot;

    if (
      lastSnapshot.currentPath !== snapshot.currentPath
      || lastSnapshot.currentThreadId !== snapshot.currentThreadId
    ) {
      emitExplorerStateChange();
    }

    if (lastSnapshot.currentThread !== snapshot.currentThread) {
      emitCurrentThreadChange();
    }
  }));
  async function openFile(
    filePath: string,
    options?: { ignoreDirty?: boolean; source?: "open" | "reload" },
  ) {
    void options;
    activeFilePath = filePath;
    emitExplorerStateChange();
    return true;
  }

  async function refreshCurrentFileFromDiskIfSafe() {
  }

  function getLocallyModifiedPaths() {
    const modifiedPaths = new Set<string>();
    for (const filePath of draftStore.getLocallyModifiedPaths()) {
      modifiedPaths.add(filePath);
    }

    return Array.from(modifiedPaths).sort((left, right) => left.localeCompare(right));
  }

  function getExplorerSnapshot(): ExplorerSnapshot {
    const projectSnapshot = projectClient.getSnapshot();
    const threadSnapshot = threadClient.getSnapshot();
    return {
      root: projectSnapshot.root,
      currentProjectId: projectSnapshot.currentProjectId,
      projects: projectSnapshot.projects,
      rootPath: projectSnapshot.rootPath,
      roots: projectSnapshot.roots,
      tree: projectSnapshot.tree,
      projectFileCandidates: projectSnapshot.projectFileCandidates,
      projectFileIndexId: projectSnapshot.projectFileIndexId,
      projectFileIndexKey: projectSnapshot.projectFileIndexKey,
      projectFilePaths: projectSnapshot.projectFilePaths,
      threads: threadSnapshot.threads,
      isProjectLoading: projectSnapshot.isLoading,
      isThreadsLoading: threadSnapshot.isLoading,
      changes: projectSnapshot.changes,
      currentPath: activeFilePath,
      currentThreadId: sessionState.currentThreadId,
      expandedDirectories: projectSnapshot.expandedDirectories,
      locallyModifiedPaths: getLocallyModifiedPaths(),
      threadsError: threadSnapshot.threadsError,
      fontSize: readStoredFontSize(),
      workbenchStorageRootPath: projectSnapshot.workbenchStorageRootPath,
    };
  }

  function flushExplorerStateChange() {
    const snapshot = getExplorerSnapshot();
    if (areExplorerSnapshotsEquivalent(lastEmittedExplorerSnapshot, snapshot)) {
      return;
    }

    lastEmittedExplorerSnapshot = snapshot;
    workbenchBindings.onExplorerStateChange?.(snapshot);
  }

  function emitExplorerStateChange() {
    if (explorerStateChangeScheduled) {
      return;
    }

    explorerStateChangeScheduled = true;
    queueMicrotask(() => {
      explorerStateChangeScheduled = false;
      flushExplorerStateChange();
    });
  }

  function emitCurrentThreadChange() {
    workbenchBindings.onCurrentThreadChange?.(sessionState.currentThread);
  }

  function emitThreadDocumentsChange(snapshot: WorkbenchThreadDocumentSnapshot = threadClient.getSnapshot().threadDocuments) {
    workbenchBindings.onThreadDocumentsChange?.(snapshot);
  }

  function emitRateLimitsChange() {
    workbenchBindings.onRateLimitsChange?.(threadClient.getSnapshot().rateLimits);
  }

  function emitPendingUserInputRequestsChange() {
    workbenchBindings.onPendingUserInputRequestsChange?.(threadClient.getSnapshot().pendingUserInputRequestsByThreadId);
  }

  function applyCurrentThreadSelection(thread: ThreadPayload | null) {
    if (
      areThreadPayloadsEquivalent(sessionState.currentThread, thread)
      && sessionState.currentThreadId === (thread?.id ?? "")
    ) {
      return false;
    }

    return sessionState.setCurrentThreadSelection(thread);
  }

  function areCurrentTurnsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
    const leftTurn = getCurrentTurn(left);
    const rightTurn = getCurrentTurn(right);

    if (leftTurn === rightTurn) {
      return true;
    }

    if (!leftTurn || !rightTurn) {
      return false;
    }

    return areDeeplyEqual(leftTurn, rightTurn);
  }

  function arePendingUserInputRequestsEquivalent(
    left: Record<string, WorkbenchPendingUserInputRequest>,
    right: Record<string, WorkbenchPendingUserInputRequest>,
  ) {
    if (left === right) {
      return true;
    }

    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) {
      return false;
    }

    return leftEntries.every(([threadId, request]) => {
      const matchingRequest = right[threadId];
      return Boolean(matchingRequest) && areDeeplyEqual(request, matchingRequest);
    });
  }

  function areTurnListsEquivalent(leftTurns: ThreadPayload["turns"], rightTurns: ThreadPayload["turns"]) {
    if (leftTurns.length !== rightTurns.length) {
      return false;
    }

    return leftTurns.every((leftTurn, index) => {
      const rightTurn = rightTurns[index];
      return !!rightTurn
        && leftTurn.id === rightTurn.id
        && leftTurn.status === rightTurn.status
        && leftTurn.itemsView === rightTurn.itemsView
        && getTurnRenderSignature(leftTurn) === getTurnRenderSignature(rightTurn);
    });
  }

  function areThreadPayloadsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    return left.id === right.id
      && left.harness === right.harness
      && left.model === right.model
      && left.reasoningEffort === right.reasoningEffort
      && left.serviceTier === right.serviceTier
      && left.agentPath === right.agentPath
      && left.isDraft === right.isDraft
      && left.name === right.name
      && left.preview === right.preview
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.status === right.status
      && left.cwd === right.cwd
      && left.source === right.source
      && left.path === right.path
      && left.forkedFromId === right.forkedFromId
      && left.agentNickname === right.agentNickname
      && left.agentRole === right.agentRole
      && areDeeplyEqual(left.browseResultEntries ?? [], right.browseResultEntries ?? [])
      && areDeeplyEqual(left.tokenUsage, right.tokenUsage)
      && areDeeplyEqual(left.turnHistory, right.turnHistory)
      && areTurnListsEquivalent(left.turns, right.turns)
      && areCurrentTurnsEquivalent(left, right);
  }

  function toggleDirectory(path: string) {
    projectClient.toggleDirectory(path);
  }

  async function refreshThreads() {
    await threadClient.refreshThreads();
  }

  async function refreshRateLimits() {
    await threadClient.refreshRateLimits();
  }

  async function refreshProjectSidebarData(route: WorkbenchRoute, generation: number) {
    const projectSnapshot = projectClient.getSnapshot();
    if (!projectSnapshot.currentProjectId) {
      emitExplorerStateChange();
      return;
    }

    const sidebarRefreshTasks = [
      () => refreshThreads(),
      () => threadClient.refreshPendingUserInputRequests(),
    ];

    await Promise.all(sidebarRefreshTasks.map((task) => task()));

    if (isRouteGenerationActive(route, generation)) {
      emitExplorerStateChange();
    }
  }

  function hydrateProjectSidebarData(route: WorkbenchRoute, generation: number, options: { block?: boolean } = {}) {
    const promise = refreshProjectSidebarData(route, generation).catch(() => {
      if (isRouteGenerationActive(route, generation)) {
        emitExplorerStateChange();
      }
    });

    if (options.block) {
      return promise;
    }

    void promise;
    return Promise.resolve();
  }

  function applyThreadPayloadToCurrentView(payload: ThreadPayload, statusMessage?: string) {
    activeFilePath = "";
    applyCurrentThreadSelection(payload);
    reportStatusMessage(statusMessage || payload.name || payload.preview || payload.id);
  }

  async function openThread(
    threadId: string,
    { harness, source = "open" }: { harness?: WorkbenchHarness; source?: "open" | "reload" } = {},
  ) {
    if (source === "open" && threadId === sessionState.currentThreadId) {
      return true;
    }

    if (threadClient.isDraftThreadId(threadId)) {
      const draftThread = threadClient.createThread(harness ?? readStoredHarness(), threadId);
      applyThreadPayloadToCurrentView(draftThread);
      emitExplorerStateChange();
      return true;
    }

    await threadClient.openThread(threadId, { harness, source });
    const payload = threadClient.getSnapshot().currentThread;
    if (!payload) {
      return false;
    }

    applyThreadPayloadToCurrentView(payload, `Read thread ${new Date(payload.updatedAt * 1000).toLocaleString()}`);
    emitExplorerStateChange();
    return true;
  }

  async function readThread(threadId: string, harness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) {
    return await threadClient.readThread(threadId, harness, options);
  }

  function markThreadSeen(thread: ThreadPayload) {
    threadClient.markThreadSeen(thread);
  }

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    options: WorkbenchSendThreadMessageOptions = {},
  ) {
    const payload = await threadClient.sendThreadMessage(thread, input, options);
    if (!payload) {
      return null;
    }

    if (options.selectThread === false && payload.id !== sessionState.currentThreadId) {
      emitExplorerStateChange();
      return payload;
    }

    applyThreadPayloadToCurrentView(payload, "Sent message.");
    emitExplorerStateChange();
    return payload;
  }

  async function stopThread(thread: ThreadPayload) {
    const payload = await threadClient.stopThread(thread);
    if (!payload) {
      return null;
    }

    if (payload.id === sessionState.currentThreadId) {
      applyThreadPayloadToCurrentView(payload, "Requested turn stop.");
    }

    emitExplorerStateChange();
    return payload;
  }

  async function pauseThread(thread: ThreadPayload) {
    const payload = await threadClient.pauseThread(thread);
    if (!payload) {
      return null;
    }

    if (payload.id === sessionState.currentThreadId) {
      applyThreadPayloadToCurrentView(payload, "Requested agent pause.");
    }

    emitExplorerStateChange();
    return payload;
  }

  async function resumeThread(thread: ThreadPayload) {
    const payload = await threadClient.resumeThread(thread);
    if (!payload) {
      return null;
    }

    if (payload.id === sessionState.currentThreadId) {
      applyThreadPayloadToCurrentView(payload, "Resumed paused agent.");
    }

    emitExplorerStateChange();
    return payload;
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    const createdPath = await projectClient.createEntry(parentPath, name, type);

    reportStatusMessage(`Created ${createdPath}`);

    return createdPath;
  }

  async function compactThread(thread: ThreadPayload) {
    const payload = await threadClient.compactThread(thread);
    if (!payload) {
      return null;
    }

    if (payload.id === sessionState.currentThreadId) {
      applyThreadPayloadToCurrentView(payload, "Requested context compaction.");
    }

    emitExplorerStateChange();
    return payload;
  }

  function clearCurrentSelectionView() {
    activeFilePath = "";
  }

  function isRouteGenerationActive(route: WorkbenchRoute, generation: number) {
    return activeRouteGeneration === generation
      && activeRoute.view === route.view
      && activeRoute.projectId === route.projectId
      && activeRoute.filePath === route.filePath
      && areDeeplyEqual(activeRoute.mosaicNode, route.mosaicNode)
      && activeRoute.settingsScope === route.settingsScope
      && activeRoute.threadId === route.threadId;
  }

  function reapplyActiveRouteAfterStaleLoad(route: WorkbenchRoute, generation: number) {
    if (isRouteGenerationActive(route, generation)) {
      return;
    }

    void applyRoute(activeRoute);
  }

  async function ensureRouteProject(route: WorkbenchRoute) {
    const previousProjectId = projectClient.getSnapshot().currentProjectId;
    if (!route.projectId) {
      await projectClient.selectInitialProject();
    } else if (!await projectClient.selectProjectStrict(route.projectId)) {
      return `Project not found: ${route.projectId}`;
    }

    const nextProjectId = projectClient.getSnapshot().currentProjectId;
    if (nextProjectId && previousProjectId !== nextProjectId) {
      await draftStore.hydratePersistedDrafts();
    }

    return "";
  }

  async function applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    activeRoute = route;
    const routeGeneration = ++activeRouteGeneration;

    if (route.view === "invalid") {
      clearCurrentSelectionView();
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      emitExplorerStateChange();
      return { error: route.error || "Invalid route.", ok: false };
    }

    const projectError = await ensureRouteProject(route);
    if (projectError) {
      clearCurrentSelectionView();
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      emitExplorerStateChange();
      return { error: projectError, ok: false };
    }

    if (!isRouteGenerationActive(route, routeGeneration)) {
      return { ok: false };
    }

    if (route.view === "project" || route.view === "settings" || route.view === "collaboration" || route.view === "mosaic") {
      activeFilePath = "";
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      clearCurrentSelectionView();
      emitExplorerStateChange();
      void hydrateProjectSidebarData(route, routeGeneration);
      return { ok: true };
    }

    if (route.view === "file") {
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      void hydrateProjectSidebarData(route, routeGeneration);
      const didOpen = await openFile(route.filePath);
      reapplyActiveRouteAfterStaleLoad(route, routeGeneration);
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return didOpen ? { ok: true } : { error: `File not found: ${route.filePath}`, ok: false };
    }

    if (route.view === "thread") {
      void hydrateProjectSidebarData(route, routeGeneration);
      const didOpen = await openThread(route.threadId);
      reapplyActiveRouteAfterStaleLoad(route, routeGeneration);
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return didOpen ? { ok: true } : { error: `Thread not found: ${route.threadId}`, ok: false };
    }

    return { error: "Unknown route.", ok: false };
  }

  async function refreshTree({ preserveSelection = false }: { preserveSelection?: boolean } = {}) {
    if (projectClient.getSnapshot().currentProjectId) {
      await projectClient.refreshProject();
    } else {
      await projectClient.selectInitialProject();
    }

    const shouldBlockOnSidebarData = Boolean(sessionState.currentThreadId || activeRoute.view === "thread");

    if (shouldBlockOnSidebarData) {
      await hydrateProjectSidebarData(activeRoute, activeRouteGeneration, { block: true });
      emitExplorerStateChange();
    } else {
      emitExplorerStateChange();
      void hydrateProjectSidebarData(activeRoute, activeRouteGeneration);
    }

    if (preserveSelection && activeRoute.view === "thread" && sessionState.currentThreadId === activeRoute.threadId) {
      const currentThreadId = sessionState.currentThreadId;
      if (sessionState.currentThread?.isDraft && sessionState.currentThread.id === currentThreadId) {
        return;
      }

      if (threadClient.hasThread(currentThreadId)) {
        if (!threadClient.isCurrentThreadUpToDate(currentThreadId)) {
          await openThread(currentThreadId, { source: "reload" });
        }
        if (sessionState.currentThreadId === currentThreadId) {
          return;
        }
      } else if (sessionState.currentThread && !sessionState.currentThread.isDraft) {
        return;
      } else {
        threadClient.clearThreadSelection();
        applyCurrentThreadSelection(null);
        emitExplorerStateChange();
      }
    }

    if (preserveSelection && activeRoute.view === "file" && activeFilePath === activeRoute.filePath) {
      const currentPath = activeFilePath;
      await refreshCurrentFileFromDiskIfSafe();
      if (activeFilePath === currentPath) {
        return;
      }
    }
  }

  async function runAutoRefresh() {
    try {
      await refreshTree({ preserveSelection: true });
    } catch {
      // Keep polling even if a transient refresh request fails.
    }
  }

  function scheduleAutoRefresh() {
    coordinatorLifecycle.scheduleRepeat("workbench-auto-refresh", AUTO_REFRESH_INTERVAL_MS, runAutoRefresh);
  }

  function stopAutoRefresh() {
    coordinatorLifecycle.cancel("workbench-auto-refresh");
  }

  function startAutoRefresh() {
    const leader = new ActiveTabRefreshLeader({
      onLeadershipChange: (isLeader) => {
        hasAutoRefreshLeaderState = true;
        isAutoRefreshLeader = isLeader;
        if (!isLeader) {
          stopAutoRefresh();
          return;
        }

        void runAutoRefresh();
        scheduleAutoRefresh();
      },
      storageKey: "workbench:auto-refresh-leader",
    });
    coordinatorLifecycle.addUnsubscribe(() => {
      leader.dispose();
    });
    hasAutoRefreshLeaderState = true;
    isAutoRefreshLeader = leader.current;
    if (leader.current) {
      scheduleAutoRefresh();
    }
  }

  const controls: MountedWorkbenchControls = {
    applyRoute,
    createFilePanelClient: (surfaces, filePanelOptions = {}) => WorkbenchFilePanelClient({
      ...filePanelOptions,
      clearThreadSelection: () => {
        threadClient.clearThreadSelection();
        applyCurrentThreadSelection(null);
      },
      draftStore,
      emitExplorerStateChange,
      expandProjectPath: (filePath) => {
        projectClient.expandPath(filePath);
      },
      getProjectChangeSummary: (path) => projectClient.getSnapshot().changes[path] ?? null,
      getProjectId: () => projectClient.getSnapshot().currentProjectId,
      refreshProject: async () => {
        await projectClient.refreshProject();
      },
      surfaces,
    }),
    createThreadDraft: (harness, draftOptions = {}) => {
      const draftThread = threadClient.createThread(harness, draftOptions.threadId, {
        select: draftOptions.select,
      });
      if (draftOptions.select !== false) {
        applyThreadPayloadToCurrentView(draftThread);
      }
      emitExplorerStateChange();
      return draftThread;
    },
    createEntry,
    listModels: threadClient.listModels,
    markThreadSeen,
    readThread,
    refreshRateLimits,
    sendThreadMessage,
    compactThread,
    pauseThread,
    resumeThread,
    stopThread,
    submitPendingUserInputRequest: threadClient.submitPendingUserInputRequest,
    setEditorFontSize: (fontSize) => {
      void fontSize;
    },
    setCurrentThreadModel: (threadId, model) => {
      threadClient.setCurrentThreadModel(threadId, model);
    },
    setCurrentThreadAgent: (threadId, agentPath) => {
      threadClient.setCurrentThreadAgent(threadId, agentPath);
    },
    setCurrentThreadComposerSettings: (threadId, settings) => {
      threadClient.setCurrentThreadComposerSettings(threadId, settings);
    },
    setCurrentThreadReasoningEffort: (threadId, effort) => {
      threadClient.setCurrentThreadReasoningEffort(threadId, effort);
    },
    setCurrentThreadServiceTier: (threadId, serviceTier) => {
      threadClient.setCurrentThreadServiceTier(threadId, serviceTier);
    },
    setDraftThreadHarness: (harness) => {
      threadClient.setDraftThreadHarness(harness);
    },
    toggleDirectory,
  };

  await draftStore.hydratePersistedDrafts();
  emitExplorerStateChange();
  emitCurrentThreadChange();
  emitThreadDocumentsChange();
  emitPendingUserInputRequestsChange();
  emitRateLimitsChange();
  await applyRoute(activeRoute);
  workbenchBindings.onControlsReady?.(controls);
  if (sessionState.currentThreadId || activeRoute.view === "thread") {
    void refreshRateLimits();
  }
  startAutoRefresh();
  return () => {
    projectClient.dispose();
    threadClient.dispose();
    coordinatorLifecycle.dispose();
  };
}
