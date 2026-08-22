/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, one bridge transport, pushed project/sidebar state, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, websocket.
 * - areExplorerSnapshotsEquivalent: compare root-visible explorer semantics while excluding sidebar-only activity ordering. Keywords: explorer, equality, render boundary.
 * - openWorkbenchThreadStateObservation: negotiate atomic v2 bootstrap with exact legacy reload-window fallback. Keywords: thread state, protocol, compatibility.
 */

import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "./codex/thread-state";
import type {
    ExplorerSnapshot,
    DeleteFileResponse,
    WorkbenchPendingUserInputRequest,
    ThreadPayload,
    WorkbenchBindings,
    WorkbenchControls,
    WorkbenchHarness,
    WorkbenchRouteLoadResult,
    WorkbenchReadThreadOptions,
    WorkbenchSendThreadMessageOptions,
    WorkbenchSubagentSummary,
    WorkbenchThreadDocumentSnapshot,
    WorkbenchProjectsPayload,
    ThreadSummary,
} from "./types";
import { areDeeplyEqual } from "./workbench/deep-equality";
import {
    createProjectRoute,
    isWorkbenchRouteOwnerOfThread,
    type WorkbenchRoute,
} from "./workbench/navigation/workbench-route";
import {
    readStoredHarness,
    readStoredFontSize,
} from "./workbench/state/browser-state";
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
import WorkbenchThreadClient, { type WorkbenchAcceptedIntent } from "./workbench/WorkbenchThreadClient";
import { WorkbenchCreateEntryResultSchema, WorkbenchDeleteFileResultSchema, type WorkbenchProjectStateUpdate } from "./workbench/project/project-state";
import ThreadSidebarClient from "./workbench/thread/ThreadSidebarClient";
import { WorkbenchThreadSidebarSnapshotSchema, WorkbenchThreadStateOpenResultSchema, WorkbenchThreadStateSnapshotSchema, WorkbenchThreadTitleMutationResultSchema, type WorkbenchThreadSidebarSnapshot } from "./workbench/thread/thread-state";
import { getTurnRenderSignature } from "./workbench/thread/thread-item-signature";
import reportClientSchemaError from "./workbench/report-client-schema-error";

type MountedWorkbenchControls = WorkbenchControls & {
  createFilePanelClient: (
    surfaces: WorkbenchEditorDomSurfaces,
    options?: Partial<Omit<WorkbenchFilePanelClientOptions, "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">>,
  ) => ReturnType<typeof WorkbenchFilePanelClient>;
};

function areThreadSummariesEquivalent(left: ThreadSummary, right: ThreadSummary) {
  return left.id === right.id
    && left.harness === right.harness
    && left.name === right.name
    && left.preview === right.preview
    && left.createdAt === right.createdAt
    && left.status === right.status
    && left.cwd === right.cwd
    && left.source === right.source
    && left.path === right.path
    && left.forkedFromId === right.forkedFromId
    && left.agentNickname === right.agentNickname
    && left.agentRole === right.agentRole;
}

function areThreadSummaryCollectionsEquivalent(left: readonly ThreadSummary[], right: readonly ThreadSummary[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const rightByKey = new Map(right.map((thread) => [`${thread.harness}:${thread.id}`, thread]));
  return left.every((thread) => {
    const match = rightByKey.get(`${thread.harness}:${thread.id}`);
    return Boolean(match && areThreadSummariesEquivalent(thread, match));
  });
}

function areSubagentSummariesEquivalent(left: WorkbenchSubagentSummary, right: WorkbenchSubagentSummary) {
  return left.activityStatus === right.activityStatus
    && left.createdAt === right.createdAt
    && left.cwd === right.cwd
    && left.directSubagentIndex === right.directSubagentIndex
    && left.harness === right.harness
    && left.name === right.name
    && left.parentThreadId === right.parentThreadId
    && left.profileId === right.profileId
    && left.profileName === right.profileName
    && left.projectId === right.projectId
    && left.threadId === right.threadId
    && left.title === right.title
    && left.updatedAt === right.updatedAt
    && left.pinned === right.pinned
    && (left.lifecycle === right.lifecycle || areDeeplyEqual(left.lifecycle, right.lifecycle));
}

function areSubagentSummaryCollectionsEquivalent(left: readonly WorkbenchSubagentSummary[], right: readonly WorkbenchSubagentSummary[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const rightByKey = new Map(right.map((subagent) => [`${subagent.harness}:${subagent.threadId}`, subagent]));
  return left.every((subagent) => {
    const match = rightByKey.get(`${subagent.harness}:${subagent.threadId}`);
    return Boolean(match && areSubagentSummariesEquivalent(subagent, match));
  });
}

export function areExplorerSnapshotsEquivalent(left: ExplorerSnapshot | null, right: ExplorerSnapshot) {
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
    && areSubagentSummaryCollectionsEquivalent(left.subagents, right.subagents)
    && areThreadSummaryCollectionsEquivalent(left.threads, right.threads)
    && (left.changes === right.changes || areDeeplyEqual(left.changes, right.changes))
    && (left.expandedDirectories === right.expandedDirectories || areDeeplyEqual(left.expandedDirectories, right.expandedDirectories))
    && (left.locallyModifiedPaths === right.locallyModifiedPaths || areDeeplyEqual(left.locallyModifiedPaths, right.locallyModifiedPaths));
}

function isUnsupportedThreadStateOpenVersion(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unrecognized key/iu.test(message) && /version/iu.test(message);
}

export async function openWorkbenchThreadStateObservation({
  acceptProject,
  installCatalog,
  projectId,
  request,
}: {
  acceptProject: (update: WorkbenchProjectStateUpdate) => void;
  installCatalog: (catalog: WorkbenchProjectsPayload) => void;
  projectId: string;
  request: (params: { projectId: string; version?: 2 }) => Promise<unknown>;
}) {
  const acceptComposite = (response: unknown) => {
    const parsed = WorkbenchThreadStateOpenResultSchema.safeParse(response);
    if (!parsed.success) return parsed;
    installCatalog(parsed.data.catalog);
    if (parsed.data.project) acceptProject(parsed.data.project);
    return parsed;
  };
  let response: unknown;
  try {
    response = await request({ projectId, version: 2 });
  } catch (error) {
    if (!isUnsupportedThreadStateOpenVersion(error)) throw error;
    const fallbackResponse = await request({ projectId });
    const compatible = acceptComposite(fallbackResponse);
    if (compatible.success) return compatible.data.sidebar;
    const legacy = WorkbenchThreadSidebarSnapshotSchema.safeParse(fallbackResponse);
    if (!legacy.success) {
      reportClientSchemaError("Rejected legacy Workbench thread-state open response", legacy.error);
      throw new Error("The legacy thread-state open response was invalid.");
    }
    return legacy.data;
  }

  const parsed = acceptComposite(response);
  if (!parsed.success) {
    reportClientSchemaError("Rejected Workbench thread-state open response", parsed.error);
    throw new Error("The thread-state open response was invalid.");
  }
  return parsed.data.sidebar;
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
  let coordinateAcceptedIntent: (event: WorkbenchAcceptedIntent) => Promise<void> = async (_event) => {
    throw new Error("The thread sidebar coordinator is not ready.");
  };
  const threadClient = WorkbenchThreadClient({
    onStatusMessage: (message) => {
      reportStatusMessage(message);
    },
    onThreadStarted: (thread) => {
      if (!isWorkbenchRouteOwnerOfThread(activeRoute, thread.id)) {
        return;
      }
      emitExplorerStateChange();
    },
    publishAcceptedIntent: (event) => coordinateAcceptedIntent(event),
  });
  const projectClient = WorkbenchProjectClient({
    onError: (message) => reportStatusMessage(message),
    transport: {
      createEntry: async (projectId, parentPath, name, type) => WorkbenchCreateEntryResultSchema.parse(await threadClient.requestWorkbench("workbench/thread-state/project/entry/create", { name, parentPath, projectId, type })),
      deleteFile: async (projectId, filePath, options) => WorkbenchDeleteFileResultSchema.parse(await threadClient.requestWorkbench("workbench/thread-state/project/file/delete", { confirmUntracked: options.confirmUntracked, path: filePath, projectId })),
      refresh: async (projectId) => { await threadClient.requestWorkbench("workbench/thread-state/project/refresh", { projectId }); },
    },
  });
  let threadSidebarSnapshot: WorkbenchThreadSidebarSnapshot | null = null;
  const threadSidebarClient = new ThreadSidebarClient({
    onChange: (snapshot) => {
      threadSidebarSnapshot = snapshot;
      threadClient.installSidebarSnapshot(snapshot);
      emitExplorerStateChange();
    },
    transport: {
      close: async (projectId) => { await threadClient.requestWorkbench("workbench/thread-state/close", { projectId }); },
      deleteDraft: async (projectId, draftId, clientUpdatedAt) => { await threadClient.requestWorkbench("workbench/thread-state/draft/delete", { clientUpdatedAt, draftId, projectId }); },
      open: async (projectId) => await openWorkbenchThreadStateObservation({
        acceptProject: projectClient.accept,
        installCatalog: projectClient.installCatalog,
        projectId,
        request: async (params) => await threadClient.requestWorkbench("workbench/thread-state/open", params),
      }),
      upsertDraft: async (projectId, draft) => { await threadClient.requestWorkbench("workbench/thread-state/draft/upsert", { draft, projectId }); },
    },
  });
  workbenchBindings.onThreadSidebarStoreReady?.(threadSidebarClient);
  coordinateAcceptedIntent = async (event) => {
    await threadSidebarClient.acceptIntent({
      ...(event.draftId ? { draftId: event.draftId } : {}),
      identity: { harness: event.harness, threadId: event.threadId },
      title: event.title,
      turnId: event.turnId,
    });
    await threadClient.requestWorkbench("workbench/thread-state/intent/accept", {
      ...(event.draftId ? { draftId: event.draftId } : {}),
      identity: { harness: event.harness, threadId: event.threadId },
      projectId: event.projectId,
      title: event.title,
      turnId: event.turnId,
    });
  };
  coordinatorLifecycle.addUnsubscribe(threadClient.onWorkbenchNotification((notification) => {
    if (notification.method === "workbench/thread-state/updated") {
      const parsed = WorkbenchThreadStateSnapshotSchema.safeParse(notification.params);
      if (!parsed.success) {
        reportClientSchemaError("Rejected workbench thread-state update", parsed.error);
        return;
      }
      if ("updateKind" in parsed.data) {
        if (parsed.data.updateKind === "project") projectClient.accept(parsed.data);
        else threadSidebarClient.acceptActivity(parsed.data);
      } else {
        threadSidebarClient.accept(parsed.data);
      }
      return;
    }
    projectClient.resetObservation();
    void threadSidebarClient.reopen();
  }));
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
      if (isWorkbenchRouteOwnerOfThread(activeRoute, nextThreadId)) {
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
      || lastSnapshot.subagents !== snapshot.subagents
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
      subagents: (threadSidebarSnapshot?.entries ?? []).filter((entry): entry is Extract<typeof entry, { entryKind: "subagent" }> => entry.entryKind === "subagent").map((entry) => ({
        activityStatus: entry.lifecycle.kind === "working" ? "active" : "inactive",
        createdAt: entry.createdAt,
        cwd: entry.cwd,
        directSubagentIndex: entry.directSubagentIndex,
        harness: entry.identity.harness,
        lastActivityAt: entry.activityAt,
        lifecycle: entry.lifecycle,
        name: entry.name,
        parentThreadId: entry.parentThreadId,
        pinned: entry.pinned,
        profileId: entry.profileId,
        profileName: entry.profileName,
        projectId: entry.projectId,
        threadId: entry.identity.threadId,
        title: entry.title,
        updatedAt: entry.updatedAt,
      })),
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

  async function refreshRateLimits() {
    await threadClient.refreshRateLimits();
  }

  function hydrateProjectSidebarData(route: WorkbenchRoute, generation: number, options: { block?: boolean } = {}) {
    void options;
    if (isRouteGenerationActive(route, generation)) emitExplorerStateChange();
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

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    options: WorkbenchSendThreadMessageOptions = {},
  ) {
    let createdThreadId = "";
    let payload: ThreadPayload | null;
    try {
      payload = await threadClient.sendThreadMessage(thread, input, {
        ...options,
        onThreadCreated: (createdThread) => {
          createdThreadId = createdThread.id;
          if (options.selectThread !== false && sessionState.currentThreadId === thread.id) {
            applyThreadPayloadToCurrentView(createdThread, "Connecting thread.");
          }
          options.onThreadCreated?.(createdThread);
        },
      });
    } catch (error) {
      if (createdThreadId && sessionState.currentThreadId === createdThreadId) {
        applyThreadPayloadToCurrentView(thread);
        emitExplorerStateChange();
      }
      throw error;
    }
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

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    const createdPath = await projectClient.createEntry(parentPath, name, type);

    reportStatusMessage(`Created ${createdPath}`);

    return createdPath;
  }

  async function deleteFile(filePath: string, options: { confirmUntracked?: boolean } = {}): Promise<DeleteFileResponse> {
    const result = await projectClient.deleteFile(filePath, options);
    if (result.confirmationRequired) {
      return result;
    }

    try {
      await draftStore.clearBuffer(filePath);
    } catch {
      reportStatusMessage("The file was deleted, but its persisted Workbench draft could not be removed from browser storage.");
    }
    if (activeFilePath === filePath) {
      activeFilePath = "";
    }
    emitExplorerStateChange();
    return result;
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
    } else {
      const rollbackSelection = projectClient.beginProjectSelection(route.projectId);
      if (!await threadSidebarClient.open(route.projectId)) {
        rollbackSelection?.();
        if (previousProjectId && previousProjectId !== route.projectId) await threadSidebarClient.open(previousProjectId);
        return `Project not found or unavailable: ${route.projectId}`;
      }
    }

    const nextProjectId = projectClient.getSnapshot().currentProjectId;
    if (!route.projectId && nextProjectId) await threadSidebarClient.open(nextProjectId);
    if (nextProjectId && previousProjectId !== nextProjectId) {
      await draftStore.hydratePersistedDrafts();
    }

    return "";
  }

  async function applyRouteOwned(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
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

    if (route.view === "project" || route.view === "settings" || route.view === "mosaic") {
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
      const target = route.threadTarget ?? { kind: "provider" as const, threadId: route.threadId };
      if (target.kind === "new") {
        const draft = threadClient.createThread("codex", `draft:${crypto.randomUUID()}`);
        applyThreadPayloadToCurrentView(draft);
        emitExplorerStateChange();
        return { ok: true };
      }
      if (target.kind === "draft") {
        const entry = threadSidebarSnapshot?.entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === target.draftId);
        if (!entry || entry.entryKind !== "draft") {
          threadClient.clearThreadSelection();
          applyCurrentThreadSelection(null);
          return { error: "This draft is missing or belongs to another project.", ok: false };
        }
        const draft = {
          ...threadClient.createThread(entry.draft.harness, `draft:${entry.draft.draftId}`),
          agentPath: entry.draft.agent,
          model: entry.draft.model,
          reasoningEffort: entry.draft.reasoningEffort,
          serviceTier: entry.draft.serviceTier,
        };
        applyThreadPayloadToCurrentView(draft);
        emitExplorerStateChange();
        return { ok: true };
      }
      const rootThreadId = target.kind === "subagent" ? target.parentThreadId : target.threadId;
      const didOpen = await openThread(rootThreadId, { harness: target.harness });
      reapplyActiveRouteAfterStaleLoad(route, routeGeneration);
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return didOpen ? { ok: true } : { error: `Thread not found: ${rootThreadId}`, ok: false };
    }

    return { error: "Unknown route.", ok: false };
  }

  async function applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    let result: WorkbenchRouteLoadResult = { ok: false };
    await threadSidebarClient.guardNavigation(async () => { result = await applyRouteOwned(route); });
    return result;
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
    deleteFile,
    deleteThreadDraft: (draftId) => threadSidebarClient.delete(draftId),
    editThreadDraft: (draft) => threadSidebarClient.edit(draft),
    listModels: threadClient.listModels,
    readThread,
    refreshRateLimits,
    sendThreadMessage,
    setThreadTitle: async (request) => {
      const projectId = projectClient.getSnapshot().currentProjectId;
      if (!projectId) throw new Error("A project must be selected before renaming a thread.");
      const parsed = WorkbenchThreadTitleMutationResultSchema.safeParse(await threadClient.requestWorkbench("workbench/thread-state/title/set", {
        identity: { harness: request.harness, threadId: request.threadId },
        projectId,
        title: request.title,
      }));
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench thread title mutation response", parsed.error);
        throw new Error("The thread title mutation response was invalid.");
      }
      if (parsed.data.identity.harness !== request.harness || parsed.data.identity.threadId !== request.threadId) {
        throw new Error("The thread title response did not match the requested thread.");
      }
      threadClient.applyAcceptedThreadTitle(request.threadId, request.harness, parsed.data.title);
      return parsed.data.title;
    },
    compactThread,
    stopThread,
    threadGoals: threadClient.threadGoals,
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
    updateThreadState: async (request) => {
      await threadClient.requestWorkbench(request.method, request);
    },
  };

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
  return () => {
    threadSidebarClient.bestEffortFlush();
    void threadSidebarClient.close();
    projectClient.dispose();
    threadClient.dispose();
    coordinatorLifecycle.dispose();
  };
}
