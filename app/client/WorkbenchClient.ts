/*
 * Exports:
 * - areExplorerSnapshotsEquivalent: compare root-visible explorer semantics while excluding sidebar-only activity ordering.
 * - openWorkbenchThreadStateObservation: negotiate project sidebar bootstrap versions.
 * - openWorkbenchGlobalThreadStateObservation: negotiate global sidebar bootstrap versions.
 * - describeGlobalThreadStateOpenFailure: describe bounded global-open transport failures.
 * - MountedWorkbenchClient: provider-facing controls, thread runtime, sidebar store, and disposal boundary.
 * - WorkbenchClient: wire the workbench DOM, bridge continuity recovery, pushed project/sidebar state, editor behavior, and explorer callbacks together.
 */

import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "workbench-shared/codex/thread-state";
import type {
    ExplorerSnapshot,
    DeleteFileResponse,
    WorkbenchProjectOption,
    ThreadPayload,
    WorkbenchBindings,
    WorkbenchControls,
    WorkbenchHarness,
    WorkbenchRouteLoadResult,
    WorkbenchReadThreadOptions,
    WorkbenchSendThreadMessageOptions,
    WorkbenchSubagentSummary,
    WorkbenchThreadRuntimeSnapshot,
    WorkbenchThreadRuntimeStore,
    WorkbenchThreadSidebarStore,
    WorkbenchProjectsPayload,
    ThreadSummary,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "workbench-shared/workbench/daemon-reload";
import {
    createHomeRoute,
    getWorkbenchThreadTargetRootId,
    getWorkbenchThreadTargetSelectedId,
    isWorkbenchRouteOwnerOfThread,
    isSameWorkbenchRoute,
    type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import FileDraftStore from "./workbench/state/FileDraftStore";
import WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController";
import type ThreadTextPresentationController from "./workbench/thread/ThreadTextPresentationController";
import LifecycleScope from "./workbench/state/LifecycleScope";
import SessionState from "./workbench/state/SessionState";
import { DEFAULT_EDITOR_FONT_SIZE } from "./workbench/state/workbench-settings";
import {
    type WorkbenchEditorDomSurfaces,
    type WorkbenchDomSurfaces,
} from "./workbench/workbench-dom";
import WorkbenchFilePanelClient from "./workbench/WorkbenchFilePanelClient";
import type { WorkbenchFilePanelClientOptions } from "./workbench/WorkbenchFilePanelClient";
import WorkbenchProjectClient from "./workbench/WorkbenchProjectClient";
import WorkbenchThreadClient, { type WorkbenchAcceptedIntent } from "./workbench/WorkbenchThreadClient";
import { DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadRuntimeStoreController from "./workbench/WorkbenchThreadRuntimeStore";
import WorkbenchConnectionRecoveryController, { type WorkbenchConnectionContinuity } from "./workbench/WorkbenchConnectionRecoveryController";
import WorkbenchDaemonRuntimeClient from "./workbench/WorkbenchDaemonRuntimeClient";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import ThreadIdentityController from "./workbench/thread/ThreadIdentityController";
import { WorkbenchCreateEntryResultSchema, WorkbenchDeleteFileResultSchema, type WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import ThreadSidebarClient from "./workbench/thread/ThreadSidebarClient";
import { serializeLegacyThreadDraft } from "workbench-shared/workbench/thread/thread-state";
import conformWorkbenchThreadStateOpenResult, {
    conformWorkbenchGlobalThreadStateOpenResult,
    conformWorkbenchThreadStateSnapshot,
} from "./workbench/thread/browser-thread-state-conformance";
import { WorkbenchGlobalThreadStateOpenResultSchema, WorkbenchPinnedThreadContextResultSchema, WorkbenchThreadSidebarSnapshotSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadStateOpenResultSchema, WorkbenchThreadStateSnapshotSchema, WorkbenchThreadTitleMutationResultSchema, type WorkbenchThreadDraft, type WorkbenchThreadSidebarEntry, type WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { getTurnRenderSignature } from "./workbench/thread/thread-item-signature";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";

type MountedWorkbenchControls = WorkbenchControls & {
  createFilePanelClient: (
    surfaces: WorkbenchEditorDomSurfaces,
    options?: Partial<Omit<WorkbenchFilePanelClientOptions, "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath" | "fileTransport" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">>,
  ) => ReturnType<typeof WorkbenchFilePanelClient>;
};

export interface MountedWorkbenchClient {
  getThreadController: ReturnType<typeof WorkbenchThreadClient>["getThreadController"];
  controls: WorkbenchControls;
  dispose: () => void;
  threadRuntime: WorkbenchThreadRuntimeStore;
  threadSidebar: WorkbenchThreadSidebarStore;
  threadTextPresentation: ThreadTextPresentationController;
}

function readInitialEditorFontSize(controller?: WorkbenchClientStateController) {
  const record = controller?.records("globalPreference").find((candidate) => (
    candidate.preference.key === "editorFontSize"
  ));
  return record?.preference.key === "editorFontSize"
    ? record.preference.value
    : DEFAULT_EDITOR_FONT_SIZE;
}

function readInitialHarness(controller?: WorkbenchClientStateController): WorkbenchHarness {
  const record = controller?.records("globalPreference").find((candidate) => (
    candidate.preference.key === "harness"
  ));
  return record?.preference.key === "harness"
    ? record.preference.value
    : "codex";
}

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
  if (
    error instanceof WorkbenchDaemonRequestError
    && (error.code as unknown) === "invalidThreadStateMutation"
  ) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (/unrecognized key/iu.test(message) && /version/iu.test(message))
    || (/invalid input/iu.test(message) && /expected 2/iu.test(message));
}

function isCompositeThreadStateOpenResponse(value: unknown): value is { sidebar: unknown } {
  return typeof value === "object" && value !== null && "sidebar" in value;
}

export async function openWorkbenchThreadStateObservation({
  acceptProject,
  installCatalog,
  projectId,
  request,
}: {
  acceptProject: (update: WorkbenchProjectStateUpdate) => void;
  installCatalog: (catalog: WorkbenchProjectsPayload) => void | Promise<unknown>;
  projectId: string;
  request: (params: { projectId: string; version?: 2 | 3 | 4 | 5 }) => Promise<unknown>;
}) {
  const acceptComposite = async (response: unknown) => {
    const parsed = WorkbenchThreadStateOpenResultSchema.safeParse(response);
    if (!parsed.success) {
      reportClientSchemaError("Repaired Workbench thread-state open response", parsed.error);
    }
    const conformed = conformWorkbenchThreadStateOpenResult(response, projectId);
    await installCatalog(conformed.data.catalog);
    if (conformed.data.project) acceptProject(conformed.data.project);
    return conformed;
  };
  let response: unknown;
  for (const version of [5, 4, 3, 2, undefined] as const) {
    try {
      response = await request(version === undefined ? { projectId } : { projectId, version });
      break;
    } catch (error) {
      if (version === undefined || !isUnsupportedThreadStateOpenVersion(error)) throw error;
    }
  }
  if (!isCompositeThreadStateOpenResponse(response)) {
    const legacy = WorkbenchThreadSidebarSnapshotSchema.safeParse(response);
    if (!legacy.success) {
      reportClientSchemaError("Rejected legacy Workbench thread-state open response", legacy.error);
      throw new Error("The legacy thread-state open response was invalid.");
    }
    return { pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" as const }, projectThreads: { projects: [] }, sidebar: legacy.data };
  }

  const composite = (await acceptComposite(response)).data;
  return { pinnedThreadLayout: composite.pinnedThreadLayout, projectThreads: composite.projectThreads, sidebar: composite.sidebar };
}

export async function openWorkbenchGlobalThreadStateObservation({
  installCatalog,
  request,
}: {
  installCatalog: (catalog: WorkbenchProjectsPayload) => void | Promise<unknown>;
  request: (version: 4 | 5 | 6 | 7) => Promise<unknown>;
}) {
  let response: unknown;
  for (const version of [7, 6, 5, 4] as const) {
    try {
      response = await request(version);
      break;
    } catch (error) {
      const code = error instanceof WorkbenchDaemonRequestError ? error.code as unknown : null;
      if (version === 4 || code !== "invalidThreadStateMutation") throw error;
    }
  }
  const parsed = WorkbenchGlobalThreadStateOpenResultSchema.safeParse(response);
  if (!parsed.success) {
    reportClientSchemaError("Repaired Workbench global thread-state open response", parsed.error);
  }
  const conformed = conformWorkbenchGlobalThreadStateOpenResult(response).data;
  await installCatalog(conformed.catalog);
  return {
    homeThreadDisplayOrder: "homeThreadDisplayOrder" in conformed ? conformed.homeThreadDisplayOrder : null,
    pinnedThreadLayout: conformed.pinnedThreadLayout,
    projectSidebars: conformed.projectSidebars,
  };
}

export function describeGlobalThreadStateOpenFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown global thread-state failure.";
  return `Unable to open all-project threads through workbench/thread-state/global/open: ${message}`.slice(0, 500);
}

export async function WorkbenchClient(
  bindings: WorkbenchBindings & {
    clientStateController?: WorkbenchClientStateController;
    dom?: WorkbenchDomSurfaces | null;
  } = {},
): Promise<MountedWorkbenchClient> {
  const { ...workbenchBindings } = bindings;

  const coordinatorLifecycle = new LifecycleScope();
  let explorerStateChangeScheduled = false;
  let lastEmittedExplorerSnapshot: ExplorerSnapshot | null = null;
  let reportStatusMessage = (_message: string) => {};
  let activeRoute: WorkbenchRoute = workbenchBindings.initialRoute ?? createHomeRoute();
  let activeRouteGeneration = 0;
  let coordinateAcceptedIntent: (event: WorkbenchAcceptedIntent) => Promise<void> = async (_event) => {
    throw new Error("The thread sidebar coordinator is not ready.");
  };
  const threadClient = WorkbenchThreadClient({
    updateThreadStateWithAcceptance: request => updateThreadStateWithAcceptance(request),
    getProjectById: (projectId) => projectClient.getSnapshot().projects.find(project => project.id === projectId),
    resolveThreadIdentity: (request) => threadIdentity.resolve(request),
    clientStateController: workbenchBindings.clientStateController,
    onStatusMessage: (message) => {
      reportStatusMessage(message);
    },
    onThreadStarted: (thread) => {
      if (!isWorkbenchRouteOwnerOfThread(activeRoute, thread.id, thread.isDraft)) {
        return;
      }
      emitExplorerStateChange();
    },
    publishAcceptedIntent: (event) => coordinateAcceptedIntent(event),
  });
  const daemon = new WorkbenchDaemonClient({
    onNotification: (listener) => threadClient.onWorkbenchNotification(listener),
    onReconnect: (listener) => threadClient.onReconnect(listener),
    request: async (method, params) => await threadClient.requestWorkbench(method, params),
  });
  const threadIdentity = new ThreadIdentityController(async (request) => {
    const { data } = await daemon.request("thread/identity/resolve", request);
    if (data) workbenchBindings.clientStateController?.rememberThreadIdentityAlias(data.projectId, request.threadId, data.threadId);
    return data;
  });
  coordinatorLifecycle.addUnsubscribe(() => threadIdentity.dispose());
  const daemonRuntime = new WorkbenchDaemonRuntimeClient({
    request: async (method, params) => await threadClient.requestWorkbench(method, params),
  });
  const projectClient = WorkbenchProjectClient({
    clientStateController: workbenchBindings.clientStateController,
    onError: (message) => reportStatusMessage(message),
    transport: {
      createEntry: async (projectId, parentPath, name, type) => WorkbenchCreateEntryResultSchema.parse(await threadClient.requestWorkbench("workbench/thread-state/project/entry/create", { name, parentPath, projectId, type })),
      deleteFile: async (projectId, filePath, options) => WorkbenchDeleteFileResultSchema.parse(await threadClient.requestWorkbench("workbench/thread-state/project/file/delete", { confirmUntracked: options.confirmUntracked, path: filePath, projectId })),
      readCatalog: async () => await daemon.request("project/catalog/read", {}),
      refresh: async (projectId) => { await threadClient.requestWorkbench("workbench/thread-state/project/refresh", { projectId }); },
    },
  });
  let threadSidebarSnapshot: WorkbenchThreadSidebarSnapshot | null = null;
  let selectedPinnedThreadDraft: WorkbenchThreadDraft | null = null;
  const threadSidebarClient = new ThreadSidebarClient({
    onChange: (snapshot) => {
      threadSidebarSnapshot = snapshot;
      daemonRuntime.acceptLegacy(snapshot?.reloadDirt ? {
        dirtyScopes: snapshot.reloadDirt.dirtyScopes,
        error: snapshot.reloadDirt.error ?? null,
        pendingScopes: snapshot.reloadDirt.pendingScopes,
      } : null);
      installCurrentThreadStateSources(snapshot);
      emitExplorerStateChange();
    },
    transport: {
      close: async (projectId) => { await threadClient.requestWorkbench("workbench/thread-state/close", { projectId }); },
      closeGlobal: async () => { await threadClient.requestWorkbench("workbench/thread-state/global/close", {}); },
      deleteDraft: async (projectId, draftId, clientUpdatedAt) => {
        const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(await threadClient.requestWorkbench("workbench/thread-state/draft/delete", { clientUpdatedAt, draftId, projectId }));
        if (!parsed.success) {
          reportClientSchemaError("Rejected Workbench draft deletion response", parsed.error);
          throw new Error("The draft deletion response was invalid.");
        }
        if (!parsed.data.accepted) throw new Error("The draft could not be deleted.");
      },
      moveDraft: async (sourceProjectId, destinationProjectId, draftId) => {
        const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(await threadClient.requestWorkbench("workbench/thread-state/draft/move", {
          destinationProjectId,
          draftId,
          sourceProjectId,
        }));
        if (!parsed.success) {
          reportClientSchemaError("Rejected Workbench draft move response", parsed.error);
          throw new Error("The draft move response was invalid.");
        }
        if (!parsed.data.accepted) throw new Error("The draft could not be moved to the selected project.");
      },
      open: async (projectId) => await openWorkbenchThreadStateObservation({
        acceptProject: projectClient.accept,
        installCatalog: projectClient.installCatalog,
        projectId,
        request: async (params) => await threadClient.requestWorkbench("workbench/thread-state/open", params),
      }),
      openGlobal: async () => await openWorkbenchGlobalThreadStateObservation({
        installCatalog: projectClient.installCatalog,
        request: async (version) => await threadClient.requestWorkbench("workbench/thread-state/global/open", { version }),
      }),
      upsertDraft: async (projectId, draft, folderId) => {
        const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(await threadClient.requestWorkbench("workbench/thread-state/draft/upsert", { draft: serializeLegacyThreadDraft(draft), folderId, projectId }));
        if (!parsed.success) {
          reportClientSchemaError("Rejected Workbench draft mutation response", parsed.error);
          throw new Error("The draft mutation response was invalid.");
        }
        if (!parsed.data.accepted) throw new Error("The thread folder no longer accepts this draft.");
      },
    },
  });
  function installCurrentThreadStateSources(
    activeProjectSnapshot = threadSidebarClient.getSnapshot(),
  ) {
    threadClient.installThreadStateSources({
      activeProjectSnapshot,
    });
  }
  coordinateAcceptedIntent = async (event) => {
    await threadSidebarClient.acceptIntent({
      ...(event.draftId ? { draftId: event.draftId } : {}),
      identity: { harness: event.harness, threadId: event.threadId },
      projectId: event.projectId,
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
    if (notification.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD) {
      daemonRuntime.acceptUpdate(notification.params);
      return;
    }
    if (notification.method === "workbench/thread-state/updated") {
      if (notification.params && typeof notification.params === "object"
        && "updateKind" in notification.params && notification.params.updateKind === "threadObservation") return;
      const parsed = WorkbenchThreadStateSnapshotSchema.safeParse(notification.params);
      if (!parsed.success) {
        reportClientSchemaError("Repaired workbench thread-state update", parsed.error);
      }
      const conformed = conformWorkbenchThreadStateSnapshot(notification.params).data;
      if (!conformed) return;
      if ("updateKind" in conformed) {
        if (conformed.updateKind === "project") projectClient.accept(conformed);
        else if (conformed.updateKind === "homeThreadDisplayOrder") threadSidebarClient.acceptHomeThreadDisplayOrder(conformed);
        else if (conformed.updateKind === "projectThreadSidebar") threadSidebarClient.acceptProjectThreadSidebar(conformed);
        else if (conformed.updateKind === "projectThreadSummary") threadSidebarClient.acceptProjectThreadSummary(conformed);
        else if (conformed.updateKind === "pinnedThreadLayout") threadSidebarClient.acceptPinnedThreadLayout(conformed);
        else if (conformed.updateKind === "activity") threadSidebarClient.acceptActivity(conformed);
        else if (conformed.updateKind === "threadStateDelta") threadSidebarClient.acceptDelta(conformed);
      } else {
        threadSidebarClient.accept(conformed);
      }
      return;
    }
    projectClient.resetObservation();
    void threadSidebarClient.reopen().then(async () => {
      if (coordinatorLifecycle.isDisposed) return;
      threadClient.threadObservations.reset();
      await threadClient.recoverThreadControllers();
    }).catch(error => reportConnectionRecoveryFailure("Unable to restore thread observation admission.", error));
  }));
  const initialThreadSnapshot = threadClient.getSnapshot();
  const sessionState = SessionState({
    currentThread: initialThreadSnapshot.currentThread,
    currentThreadId: initialThreadSnapshot.currentThreadId,
  });
  const createThreadRuntimeSnapshot = (
    snapshot = threadClient.getSnapshot(),
  ): WorkbenchThreadRuntimeSnapshot => ({
    ...snapshot,
    currentThread: sessionState.currentThread,
    currentThreadId: sessionState.currentThreadId,
  });
  const threadRuntime = WorkbenchThreadRuntimeStoreController(createThreadRuntimeSnapshot(initialThreadSnapshot));
  const draftStore = FileDraftStore(
    () => projectClient.getSnapshot().currentProjectId,
    emitExplorerStateChange,
    workbenchBindings.clientStateController,
    (message) => reportStatusMessage(message),
  );
  const mountedFilePanelClients = new Set<ReturnType<typeof WorkbenchFilePanelClient>>();
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
    if (previousProjectId !== snapshot.currentProjectId) {
      installCurrentThreadStateSources();
    }
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
      if (isWorkbenchRouteOwnerOfThread(activeRoute, nextThreadId, snapshot.currentThread?.isDraft)) {
        applyCurrentThreadSelection(snapshot.currentThread);
      }
    }

    threadRuntime.accept(createThreadRuntimeSnapshot(snapshot));

    if (
      lastSnapshot.currentThreadId !== snapshot.currentThreadId
      || lastSnapshot.subagents !== snapshot.subagents
      || lastSnapshot.threads !== snapshot.threads
      || lastSnapshot.threadsError !== snapshot.threadsError
    ) {
      emitExplorerStateChange();
    }
  }));
  const reportConnectionRecoveryFailure = (summary: string, error: unknown) => {
    const detail = error instanceof Error ? error.message.slice(0, 500) : "Unknown connection recovery failure.";
    console.error(summary, detail);
    reportStatusMessage(`${summary} ${detail}`);
  };
  const recoverConnection = async (continuity: WorkbenchConnectionContinuity) => {
    projectClient.resetObservation();
    if (continuity === "lost") {
      daemonRuntime.resetConnection();
      threadClient.resetConnectionState();
    }
    await daemonRuntime.open();
    await threadSidebarClient.reopen();
    if (coordinatorLifecycle.isDisposed) return;
    threadClient.threadObservations.reset();
    if (continuity === "lost") {
      await applyRoute(activeRoute);
    }
    await threadClient.recoverThreadControllers();
    if (activeRoute.view === "thread") await refreshRateLimits();
    const fileRefreshes = await Promise.allSettled(
      [...mountedFilePanelClients].map(async (client) => await client.refreshCurrentFileFromDiskIfSafe()),
    );
    const failedFileRefresh = fileRefreshes.find((result) => result.status === "rejected");
    if (failedFileRefresh?.status === "rejected") {
      reportConnectionRecoveryFailure("Unable to refresh a file during connection recovery.", failedFileRefresh.reason);
    }
  };
  const connectionRecovery = new WorkbenchConnectionRecoveryController({
    onError: (continuity, error) => {
      reportConnectionRecoveryFailure(
        continuity === "lost"
          ? "Unable to rebuild Workbench state after reconnecting."
          : "Unable to refresh Workbench state after resuming.",
        error,
      );
    },
    recover: recoverConnection,
  });
  coordinatorLifecycle.addUnsubscribe(threadClient.onReconnect(() => {
    threadIdentity.reset();
    return connectionRecovery.recoverAfterConnectionLoss();
  }));
  coordinatorLifecycle.addUnsubscribe(() => connectionRecovery.dispose());

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
      threadRuntime.accept(createThreadRuntimeSnapshot());
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
      subagents: threadSnapshot.subagents,
      threads: threadSnapshot.threads,
      isProjectLoading: projectSnapshot.isLoading,
      isThreadsLoading: threadSnapshot.isLoading,
      changes: projectSnapshot.changes,
      currentPath: activeFilePath,
      currentThreadId: sessionState.currentThreadId,
      expandedDirectories: projectSnapshot.expandedDirectories,
      locallyModifiedPaths: getLocallyModifiedPaths(),
      threadsError: threadSnapshot.threadsError,
      fontSize: readInitialEditorFontSize(workbenchBindings.clientStateController),
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

  function applyCurrentThreadSelection(thread: ThreadPayload | null) {
    if (
      areThreadPayloadsEquivalent(sessionState.currentThread, thread)
      && sessionState.currentThreadId === (thread?.id ?? "")
    ) {
      return false;
    }

    const changed = sessionState.setCurrentThreadSelection(thread);
    if (changed) {
      threadRuntime.accept(createThreadRuntimeSnapshot());
    }
    return changed;
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

  function applyDraftEntryToCurrentView(
    entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>,
    options: { project?: WorkbenchProjectOption } = {},
  ) {
    const draft = {
      ...threadClient.createThread(entry.draft.composerSettings.harness, entry.draft.draftId, options),
      agentPath: entry.draft.composerSettings.agentPath,
      model: entry.draft.composerSettings.model || null,
      reasoningEffort: entry.draft.composerSettings.reasoningEffort,
      serviceTier: entry.draft.composerSettings.serviceTier,
    };
    applyThreadPayloadToCurrentView(draft);
    emitExplorerStateChange();
  }

  function cloneThreadDraft(draft: WorkbenchThreadDraft) {
    return structuredClone(draft);
  }

  function isPinnedContextTargetMatch(
    requested: NonNullable<WorkbenchRoute["threadTarget"]>,
    admitted: NonNullable<WorkbenchRoute["threadTarget"]>,
  ) {
    return requested.kind === admitted.kind
      && getWorkbenchThreadTargetRootId(requested) === getWorkbenchThreadTargetRootId(admitted)
      && getWorkbenchThreadTargetSelectedId(requested) === getWorkbenchThreadTargetSelectedId(admitted);
  }

  async function readPinnedThreadContext(projectId: string, target: NonNullable<WorkbenchRoute["threadTarget"]>) {
    const parsed = WorkbenchPinnedThreadContextResultSchema.safeParse(
      await threadClient.requestWorkbench("workbench/thread-state/pin/open", { projectId, target }),
    );
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench pinned thread context response", parsed.error);
      return { ok: false as const, error: "The pinned thread context response was invalid." };
    }
    const context = parsed.data.context;
    if (!context || context.projectId !== projectId || !isPinnedContextTargetMatch(target, context.target)) {
      return { ok: false as const, error: "This pinned thread is missing, snoozed, or no longer pinned." };
    }
    return { ok: true as const, context };
  }

  async function admitPinnedTitleAction(projectId: string, identity: { harness: WorkbenchHarness; threadId: string }) {
    const observed = threadSidebarClient.getSnapshot();
    if (!observed || observed.projectId === projectId) return;
    const isForeignPin = threadSidebarClient.getProjectThreadSummaries().projects
      .find((project) => project.projectId === projectId)?.pinnedThreads.some((entry) => (
        entry.entryKind === "thread" && entry.identity.harness === identity.harness && entry.identity.threadId === identity.threadId
      ));
    if (!isForeignPin) return;
    const result = await readPinnedThreadContext(projectId, { kind: "provider", ...identity, threadId: ThreadReferenceSchema.parse(identity.threadId) });
    if (!result.ok) throw new Error(result.error);
  }

  async function openThread(
    threadId: string,
    {
      harness,
      project,
      source = "open",
      isCurrent = () => true,
    }: {
      harness?: WorkbenchHarness;
      project?: WorkbenchProjectOption;
      source?: "open" | "reload";
      isCurrent?: () => boolean;
    } = {},
  ): Promise<WorkbenchRouteLoadResult> {
    if (threadClient.isDraftThreadId(threadId)) {
      const draftThread = threadClient.createThread(harness ?? readInitialHarness(workbenchBindings.clientStateController), threadId, { project });
      applyThreadPayloadToCurrentView(draftThread);
      emitExplorerStateChange();
      return { ok: true };
    }

    const outcome = await threadClient.openThread(threadId, { harness, project, source, isCurrent });
    if (!isCurrent()) return { ok: false };
    if (outcome.kind === "failure") {
      return {
        error: `Unable to open ${outcome.failure.harness} thread ${threadId}: ${outcome.failure.message}`,
        ok: false,
      };
    }
    if (outcome.kind === "superseded") return { ok: false };

    applyThreadPayloadToCurrentView(outcome.payload, `Read thread ${new Date(outcome.payload.updatedAt * 1000).toLocaleString()}`);
    emitExplorerStateChange();
    return { ok: true };
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
      reportStatusMessage("The file was deleted, but its persisted Workbench draft could not be removed from app storage.");
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
      && activeRoute.threadId === route.threadId
      && activeRoute.threadOwnerProjectId === route.threadOwnerProjectId
      && areDeeplyEqual(activeRoute.threadTarget, route.threadTarget);
  }

  async function ensureRouteProject(route: WorkbenchRoute) {
    const previousProjectId = projectClient.getSnapshot().currentProjectId;
    if (!route.projectId) {
      try {
        await threadSidebarClient.openGlobal();
      } catch (error) {
        if (previousProjectId) await threadSidebarClient.open(previousProjectId);
        return describeGlobalThreadStateOpenFailure(error);
      }
      projectClient.enterNoProject();
    } else {
      const rollbackSelection = projectClient.beginProjectSelection(route.projectId);
      if (!await threadSidebarClient.open(route.projectId)) {
        rollbackSelection?.();
        if (previousProjectId && previousProjectId !== route.projectId) await threadSidebarClient.open(previousProjectId);
        return `Project not found or unavailable: ${route.projectId}`;
      }
    }

    const nextProjectId = projectClient.getSnapshot().currentProjectId;
    if (nextProjectId && workbenchBindings.clientStateController) {
      void workbenchBindings.clientStateController.put({
        daemonRegistrationId: workbenchBindings.clientStateController.daemonRegistrationId,
        kind: "lastLaunchTarget",
        projectId: nextProjectId,
      }).catch((error: Error) => reportStatusMessage(error.message));
    }
    if (nextProjectId && previousProjectId !== nextProjectId) {
      await draftStore.hydratePersistedDrafts();
    }

    return "";
  }

  async function applyRouteOwned(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    activeRoute = route;
    selectedPinnedThreadDraft = null;
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
    try {
      const clientState = workbenchBindings.clientStateController;
      const projectRoute = clientState ? {
        ...route,
        projectId: route.projectId ? ProjectIdSchema.parse(clientState.resolveProjectId(route.projectId)) : route.projectId,
        threadOwnerProjectId: route.threadOwnerProjectId
          ? ProjectIdSchema.parse(clientState.resolveProjectId(route.threadOwnerProjectId)) : route.threadOwnerProjectId,
      } : route;
      const canonicalRoute = await threadIdentity.resolveRoute(projectRoute);
      if (!isRouteGenerationActive(route, routeGeneration)) return { ok: false };
      // Project addresses are a navigation concern, not a reason to redirect.
      // Keep the current generation while applying its canonical internal scope.
      route = projectRoute;
      activeRoute = projectRoute;
      if (route.view === "thread") {
        const projectId = route.threadOwnerProjectId || route.projectId;
        const references = new Set(workbenchBindings.clientStateController?.getSnapshot().records.flatMap((record) => (
          (record.kind === "composerDraft" || record.kind === "questionnaireDraft") && record.projectId === projectId ? [record.threadId] : []
        )));
        const resolvedDrafts = await Promise.allSettled([...references].map((threadId) => threadIdentity.resolve({
          allowProviderAdmission: false,
          threadId: ThreadReferenceSchema.parse(threadId),
          projectId: projectId || undefined,
        })));
        if (!isRouteGenerationActive(route, routeGeneration)) return { ok: false };
        if (resolvedDrafts.some((result) => result.status === "rejected")) {
          reportStatusMessage("Some saved draft identities could not be resolved. Their stored drafts remain unchanged.");
        }
      }
      if (!isSameWorkbenchRoute(route, canonicalRoute)) return { ok: true, canonicalRoute };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Unable to resolve thread identity." };
    }

    if (route.view === "home" || route.view === "project" || route.view === "settings" || route.view === "mosaic") {
      activeFilePath = "";
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      clearCurrentSelectionView();
      emitExplorerStateChange();
      void hydrateProjectSidebarData(route, routeGeneration);
      if (route.view === "mosaic") threadClient.activateThreadControllers();
      return { ok: true };
    }

    if (route.view === "file") {
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      void hydrateProjectSidebarData(route, routeGeneration);
      const didOpen = await openFile(route.filePath);
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return didOpen ? { ok: true } : { error: `File not found: ${route.filePath}`, ok: false };
    }

    if (route.view === "thread") {
      void hydrateProjectSidebarData(route, routeGeneration);
      const target = route.threadTarget ?? { kind: "provider" as const, threadId: ThreadReferenceSchema.parse(route.threadId) };
      const ownerProjectId = route.threadOwnerProjectId || route.projectId;
      const isHomeThread = !route.projectId;
      const isForeignPin = !isHomeThread && ownerProjectId !== route.projectId;
      let ownerProject = (isHomeThread || isForeignPin)
        ? projectClient.getSnapshot().projects.find((project) => project.id === ownerProjectId)
        : undefined;
      let ownerEntries: readonly WorkbenchThreadSidebarEntry[] = isHomeThread
        ? threadSidebarClient.getProjectThreadSidebars().projects.find(({ projectId }) => projectId === ownerProjectId)?.entries ?? []
        : [];
      if ((isHomeThread || isForeignPin) && !ownerProject) {
        threadClient.clearThreadSelection();
        applyCurrentThreadSelection(null);
        return { error: `Thread project not found: ${ownerProjectId}`, ok: false };
      }
      if (isForeignPin) {
        const result = await readPinnedThreadContext(ownerProjectId, target);
        if (!result.ok) {
          threadClient.clearThreadSelection();
          applyCurrentThreadSelection(null);
          return { error: result.error, ok: false };
        }
        ownerEntries = result.context.entries;
      }
      if (target.kind === "new") {
        if (isForeignPin) {
          return { error: "Pinned routes cannot open a new thread.", ok: false };
        }
        const draft = threadClient.createThread("codex", DraftIdSchema.parse(crypto.randomUUID()), {
          project: ownerProject,
        });
        applyThreadPayloadToCurrentView(draft);
        emitExplorerStateChange();
        return { ok: true };
      }
      if (target.kind === "draft") {
        const entries = isHomeThread || isForeignPin ? ownerEntries : threadSidebarSnapshot?.entries ?? [];
        const entry = entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === target.draftId);
        if (!entry || entry.entryKind !== "draft") {
          threadClient.clearThreadSelection();
          applyCurrentThreadSelection(null);
          return { error: "This draft is missing or belongs to another project.", ok: false };
        }
        selectedPinnedThreadDraft = isHomeThread || isForeignPin ? cloneThreadDraft(entry.draft) : null;
        threadSidebarClient.receiveDraft(entry.draft);
        applyDraftEntryToCurrentView(entry, { project: ownerProject });
        return { ok: true };
      }
      const rootThreadId = target.kind === "subagent" ? target.parentThreadId : target.threadId;
      const openResult = await openThread(rootThreadId, {
        harness: target.harness,
        project: ownerProject,
        isCurrent: () => isRouteGenerationActive(route, routeGeneration),
      });
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return openResult;
    }

    return { error: "Unknown route.", ok: false };
  }

  async function applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    let result: WorkbenchRouteLoadResult = { ok: false };
    let generation: number | undefined;
    await threadSidebarClient.guardNavigation(async () => {
      generation = activeRouteGeneration + 1;
      result = await applyRouteOwned(route);
    });
    if (route.view === "thread" && activeRouteGeneration === generation && !result.ok && result.error) {
      const target = route.threadTarget ?? { kind: "provider" as const, threadId: ThreadReferenceSchema.parse(route.threadId) };
      if (target.kind !== "new") {
        const owner = route.threadOwnerProjectId || route.projectId;
        const projectId = workbenchBindings.clientStateController?.resolveProjectId(owner) ?? owner;
        threadClient.getThreadController(projectId, target.kind === "subagent"
          ? { kind: "provider", threadId: target.parentThreadId } : target).fail(new Error(result.error));
      }
    }
    return result;
  }

  async function updateThreadStateWithAcceptance(request: Parameters<WorkbenchControls["updateThreadState"]>[0]) {
    if (request.method === "workbench/thread-state/title/dismiss") {
      await admitPinnedTitleAction(request.projectId, request.identity);
    }
    const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(await threadClient.requestWorkbench(request.method, request));
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench thread state mutation response", parsed.error);
      throw new Error("The thread state mutation response was invalid.");
    }
    return parsed.data.accepted;
  }

  const controls: MountedWorkbenchControls = {
    applyRoute,
    daemon,
    createFilePanelClient: (surfaces, filePanelOptions = {}) => {
      const panelLifecycle = new LifecycleScope();
      const client = WorkbenchFilePanelClient({
        ...filePanelOptions,
        clearThreadSelection: () => {
          threadClient.clearThreadSelection();
          applyCurrentThreadSelection(null);
        },
        draftStore,
        fileTransport: {
          read: async (projectId, path) => await daemon.request("project/file/read", { path, projectId }),
          reset: async (projectId, path, expectedMtimeMs, force) => await daemon.request("project/file/reset", { expectedMtimeMs, force, path, projectId }),
          save: async (projectId, path, content, expectedMtimeMs, force) => await daemon.request("project/file/save", { content, expectedMtimeMs, force, path, projectId }),
        },
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
      }, panelLifecycle);
      mountedFilePanelClients.add(client);
      panelLifecycle.addUnsubscribe(() => mountedFilePanelClients.delete(client));
      return client;
    },
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
    deleteThreadDraft: async (draftId, projectId) => {
      const selectedDraft = selectedPinnedThreadDraft;
      const ownerProjectId = projectId ?? (selectedDraft?.draftId === draftId ? selectedDraft.projectId : undefined);
      await threadSidebarClient.delete(draftId, Date.now(), ownerProjectId);
      if (selectedPinnedThreadDraft?.draftId === draftId && selectedPinnedThreadDraft.projectId === ownerProjectId) selectedPinnedThreadDraft = null;
    },
    editThreadDraft: (draft, options) => {
      threadSidebarClient.edit(draft, options);
      if (selectedPinnedThreadDraft?.draftId === draft.draftId && selectedPinnedThreadDraft.projectId === draft.projectId) {
        selectedPinnedThreadDraft = cloneThreadDraft(draft);
      }
    },
    flushThreadDraft: (projectId, draftId) => threadSidebarClient.flushDraft(projectId, draftId),
    getSelectedThreadDraft: () => {
      if (!selectedPinnedThreadDraft) return null;
      const draft = threadSidebarClient.getDraft(selectedPinnedThreadDraft.projectId, selectedPinnedThreadDraft.draftId);
      return draft ? cloneThreadDraft(draft) : null;
    },
    listModels: threadClient.listModels,
    moveThreadDraft: async (sourceProjectId, destinationProjectId, draftId) => {
      await threadSidebarClient.moveDraft(sourceProjectId, destinationProjectId, draftId);
      if (selectedPinnedThreadDraft?.draftId === draftId && selectedPinnedThreadDraft.projectId === sourceProjectId) {
        selectedPinnedThreadDraft = { ...selectedPinnedThreadDraft, projectId: destinationProjectId };
      }
    },
    readThread,
    daemonRuntime,
    refreshRateLimits,
    sendThreadMessage,
    setThreadTitle: async (request) => {
      const projectId = request.projectId ?? (activeRoute.view === "thread"
        ? activeRoute.threadOwnerProjectId || activeRoute.projectId
        : projectClient.getSnapshot().currentProjectId);
      if (!projectId) throw new Error("A project must be selected before renaming a thread.");
      await admitPinnedTitleAction(projectId, { harness: request.harness, threadId: request.threadId });
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
      threadClient.applyAcceptedThreadTitle(parsed.data.identity.threadId, parsed.data.identity.harness, parsed.data.title);
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
      await updateThreadStateWithAcceptance(request);
    },
    updateThreadStateWithAcceptance,
  };

  await daemonRuntime.open().catch((error: unknown) => {
    console.error(
      "Unable to observe Workbench daemon reload dirt.",
      error instanceof Error ? error.message.slice(0, 500) : "Unknown reload observation failure.",
    );
  });
  emitExplorerStateChange();
  await applyRoute(activeRoute);
  if (sessionState.currentThreadId || activeRoute.view === "thread") {
    void refreshRateLimits();
  }
  connectionRecovery.start();
  return {
    controls,
    dispose: () => {
      threadSidebarClient.bestEffortFlush();
      void threadSidebarClient.close();
      daemonRuntime.dispose();
      projectClient.dispose();
      threadClient.dispose();
      coordinatorLifecycle.dispose();
    },
    threadRuntime,
    threadSidebar: threadSidebarClient,
    threadTextPresentation: threadClient.textPresentation,
    getThreadController: threadClient.getThreadController,
  };
}
