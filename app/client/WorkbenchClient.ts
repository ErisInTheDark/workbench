/*
 * Exports:
 * - areExplorerSnapshotsEquivalent: compare root-visible explorer semantics while excluding sidebar-only activity ordering.
 * - openWorkbenchThreadStateObservation: negotiate project sidebar bootstrap versions.
 * - openWorkbenchGlobalThreadStateObservation: negotiate global sidebar bootstrap versions.
 * - describeGlobalThreadStateOpenFailure: describe bounded global-open transport failures.
 * - MountedWorkbenchClient: provider-facing controls, thread runtime, sidebar store, and disposal boundary.
 * - WorkbenchClient: compose browser domain owners, DOM/editor adapters, bridge recovery, and explorer publication.
 */

import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import WorkbenchAppLifetimeClient from "./workbench/app/WorkbenchAppLifetimeClient";
import WorkbenchNetworkClient from "./workbench/app/WorkbenchNetworkClient";
import WorkbenchPresentationClient from "./workbench/state/WorkbenchPresentationClient";
import WorkbenchDaemonSession from "./workbench/WorkbenchDaemonSession";
import WorkbenchDaemonSessions from "./workbench/WorkbenchDaemonSessions";
import WorkbenchThreadRouter from "./workbench/WorkbenchThreadRouter";
import { projectLogicalProjects, projectLogicalSummaries, projectLogicalThreadRows } from "./workbench/WorkbenchProjectProjection";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getCurrentTurn } from "workbench-shared/workbench/thread/thread-runtime-state";
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
    WorkbenchThreadIntent,
    ThreadSummary,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { WORKBENCH_RELOAD_DIRT_UPDATED_METHOD } from "workbench-shared/workbench/daemon-reload";
import {
    createHomeRoute,
    createLogicalProjectRoute,
    createLogicalExistingThreadRoute,
    createLogicalMosaicRoute,
    createLogicalThreadRoute,
    getWorkbenchThreadTargetRootId,
    getWorkbenchThreadTargetSelectedId,
    isWorkbenchRouteOwnerOfThread,
    isSameWorkbenchRoute,
    type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchMosaicNode } from "workbench-shared/workbench/navigation/workbench-mosaic-route";
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
import { DaemonIdSchema, DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchThreadIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import WorkbenchThreadRuntimeStoreController from "./workbench/WorkbenchThreadRuntimeStore";
import WorkbenchNavigationController from "./workbench/WorkbenchNavigationController";
import WorkbenchConnectionRecoveryController, { type WorkbenchConnectionContinuity } from "./workbench/WorkbenchConnectionRecoveryController";
import WorkbenchDaemonRuntimeClient from "./workbench/WorkbenchDaemonRuntimeClient";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchVoiceClient from "./workbench/voice/WorkbenchVoiceClient";
import frontendJavaScriptGeneration from "workbench-shared/frontend-generation";
import ThreadIdentityController from "./workbench/thread/ThreadIdentityController";
import { WorkbenchCreateEntryResultSchema, WorkbenchDeleteFileResultSchema } from "workbench-shared/workbench/project/project-state";
import ThreadSidebarClient, { openWorkbenchGlobalThreadStateObservation, openWorkbenchThreadStateObservation } from "./workbench/thread/ThreadSidebarClient";
import ThreadLaunchController from "./workbench/thread/ThreadLaunchController";
import { ThreadMessageNotSentError } from "./workbench/thread/thread-message-submission";
export { openWorkbenchGlobalThreadStateObservation, openWorkbenchThreadStateObservation } from "./workbench/thread/ThreadSidebarClient";
import { serializeLegacyThreadDraft } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchPinnedThreadContextResultSchema, WorkbenchThreadSidebarSnapshotSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadTitleMutationResultSchema, type WorkbenchThreadSidebarEntry, type WorkbenchThreadSidebarSnapshot, type WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import {
  getWorkbenchThreadDisplayKey, getWorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayThreadKey } from "workbench-shared/workbench/thread/thread-display-layout";
import type { WorkbenchProjectThreadSidebars, WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import { getTurnRenderSignature } from "./workbench/thread/thread-item-signature";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { areWorkbenchAgentPathsEqual } from "workbench-shared/workbench/agent-paths";

type MountedWorkbenchControls = WorkbenchControls & {
  createFilePanelClient: (
    surfaces: WorkbenchEditorDomSurfaces,
    options?: Partial<Omit<WorkbenchFilePanelClientOptions, "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath" | "fileTransport" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">> & {
      location?: ProjectLocationReference;
    },
  ) => ReturnType<typeof WorkbenchFilePanelClient>;
};

export interface MountedWorkbenchClient {
  networkClient?: WorkbenchNetworkClient;
  presentationClient?: WorkbenchPresentationClient;
  daemonSessions?: WorkbenchDaemonSessions;
  voice?: WorkbenchVoiceClient;
  getThreadController: (...args: Parameters<ReturnType<typeof WorkbenchThreadClient>["getThreadController"]>) =>
    ReturnType<ReturnType<typeof WorkbenchThreadClient>["getThreadController"]> | null;
  threadOwnerFor: (threadId: string) => {
    daemonId: DaemonId;
    projectId: string;
    hostname: string;
    rootPath: string;
  } | null;
  threadContextFor: (threadId: string) => {
    daemonId: DaemonId;
    daemon: WorkbenchDaemonClient;
    threads: ReturnType<typeof WorkbenchThreadClient>;
    project: WorkbenchProjectOption;
    assetOrigin: string | null;
    registrationId: string;
  } | null;
  launchContextFor: (location: ProjectLocationReference) => {
    daemonId: DaemonId;
    daemon: WorkbenchDaemonClient;
    threads: ReturnType<typeof WorkbenchThreadClient>;
    project: WorkbenchProjectOption;
    assetOrigin: string | null;
  } | null;
  draftContextFor: (draftId: string) => ReturnType<MountedWorkbenchClient["launchContextFor"]>;
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
    : defaultProviderKey;
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

  return left.configuredDiscoveryRootPath === right.configuredDiscoveryRootPath
    && left.currentProjectId === right.currentProjectId
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
    && (left.logicalProjects === right.logicalProjects || areDeeplyEqual(left.logicalProjects, right.logicalProjects))
    && (left.logicalSummaries === right.logicalSummaries || areDeeplyEqual(left.logicalSummaries, right.logicalSummaries))
    && (left.logicalThreads === right.logicalThreads || areDeeplyEqual(left.logicalThreads, right.logicalThreads))
    && (left.roots === right.roots || areDeeplyEqual(left.roots, right.roots))
    && (left.tree === right.tree || areDeeplyEqual(left.tree, right.tree))
    && areSubagentSummaryCollectionsEquivalent(left.subagents, right.subagents)
    && areThreadSummaryCollectionsEquivalent(left.threads, right.threads)
    && (left.changes === right.changes || areDeeplyEqual(left.changes, right.changes))
    && (left.expandedDirectories === right.expandedDirectories || areDeeplyEqual(left.expandedDirectories, right.expandedDirectories))
    && (left.locallyModifiedPaths === right.locallyModifiedPaths || areDeeplyEqual(left.locallyModifiedPaths, right.locallyModifiedPaths));
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
  let networkClient: WorkbenchNetworkClient | undefined;
  let presentationClient: WorkbenchPresentationClient | undefined;
  let daemonSessions: WorkbenchDaemonSessions | undefined;
  let attachedSession: WorkbenchDaemonSession | undefined;
  const initialRoute = workbenchBindings.initialRoute ?? createHomeRoute();
  let navigation: WorkbenchNavigationController;
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
      if (!isWorkbenchRouteOwnerOfThread(navigation?.getSnapshot().route ?? initialRoute, thread.id, thread.isDraft)) {
        return;
      }
      emitExplorerStateChange();
    },
    publishAcceptedIntent: (event) => coordinateAcceptedIntent(event),
  });
  let activeThreadClient = threadClient;
  let activePeerSession: WorkbenchDaemonSession | null = null;
  let unsubscribeActivePeer: (() => void) | null = null;
  let activeBrowsePeerSession: WorkbenchDaemonSession | null = null;
  let unsubscribeActiveBrowsePeer: (() => void) | null = null;
  const appLifetime = new WorkbenchAppLifetimeClient({
    available: available => threadClient.setAppAvailable(available),
    status: message => reportStatusMessage(message),
  });
  coordinatorLifecycle.addUnsubscribe(() => appLifetime.dispose());
  try { await appLifetime.start(); }
  catch (error) { threadClient.dispose(); coordinatorLifecycle.dispose(); throw error; }
  const daemon = new WorkbenchDaemonClient({
    onDisconnect: listener => threadClient.onDisconnect(listener),
    onNotification: (listener) => threadClient.onWorkbenchNotification(listener),
    onReconnect: (listener) => threadClient.onReconnect(listener),
    request: async (method, params) => await threadClient.requestWorkbench(method, params),
  });
  const voice = new WorkbenchVoiceClient(daemon, `/assets/voice-capture.js?v=${frontendJavaScriptGeneration}`, workbenchBindings.clientStateController);
  coordinatorLifecycle.addUnsubscribe(() => voice.dispose());
  const threadIdentity = new ThreadIdentityController(async (request) => {
    const { data } = await daemon.threads.resolveIdentity(request);
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
      readCatalog: async () => await daemon.projects.catalog(),
      refresh: async (projectId) => { await threadClient.requestWorkbench("workbench/thread-state/project/refresh", { projectId }); },
    },
  });
  let activeProjectClient = projectClient;
  const threadRouter = new WorkbenchThreadRouter({
    presentation: () => presentationClient?.snapshot().data ?? null,
    rows: () => getExplorerSnapshot().logicalThreads ?? [],
    daemons: () => {
      const attachedId = networkClient?.snapshot().snapshot?.daemon?.daemonId
        ?? workbenchBindings.clientStateController?.getSnapshot().registrations
          .find(registration => registration.kind === "local")?.daemonId;
      return [
        ...(attachedId ? [{
          daemonId: DaemonIdSchema.parse(attachedId), daemon, threads: threadClient,
          ready: () => !coordinatorLifecycle.isDisposed,
        }] : []),
        ...(daemonSessions?.list().map(session => ({
          daemonId: session.getSnapshot().daemonId,
          daemon: session.daemon, threads: session.threads,
          ready: () => session.getSnapshot().phase === "ready"
            && daemonSessions?.get(session.getSnapshot().daemonId) === session,
        })) ?? []),
      ];
    },
    onWarning: message => reportStatusMessage(message),
  });
  coordinatorLifecycle.addUnsubscribe(() => threadRouter.dispose());
  let threadSidebarSnapshot: WorkbenchThreadSidebarSnapshot | null = null;
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
      threadSidebarClient.acceptDaemonUpdate(notification.params, projectClient.accept);
      return;
    }
    if (notification.method !== "workbench/thread-state/reset") return;
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
    snapshot = activeThreadClient.getSnapshot(),
  ): WorkbenchThreadRuntimeSnapshot => ({
    ...snapshot,
    currentThread: sessionState.currentThread,
    currentThreadId: sessionState.currentThreadId,
  });
  const threadRuntime = WorkbenchThreadRuntimeStoreController(createThreadRuntimeSnapshot(initialThreadSnapshot));
  const fileDraftStores = new Map<string, ReturnType<typeof FileDraftStore>>();
  function fileDraftStoreFor(projectId: string, registrationId: string) {
    const key = `${registrationId}:${projectId}`;
    let store = fileDraftStores.get(key);
    if (!store) {
      store = FileDraftStore(
        () => projectId, emitExplorerStateChange, workbenchBindings.clientStateController,
        message => reportStatusMessage(message), () => registrationId,
      );
      fileDraftStores.set(key, store);
      void store.hydratePersistedDrafts().catch(error => reportStatusMessage(
        error instanceof Error ? error.message.slice(0, 512) : "File drafts could not be loaded.",
      ));
    }
    return store;
  }
  const activeFileDraftStore = () => fileDraftStoreFor(
    activeProjectClient.getSnapshot().currentProjectId,
    activeBrowsePeerSession?.getSnapshot().registrationId
      ?? workbenchBindings.clientStateController?.daemonRegistrationId ?? "",
  );
  navigation = new WorkbenchNavigationController(initialRoute, {
    activateThreadControllers: () => threadClient.activateThreadControllers(),
    applyDraft: (entry, project) => applyDraftEntryToCurrentView(entry, { project }),
    clearSelection: () => {
      clearCurrentSelectionView();
      threadClient.clearThreadSelection();
      applyCurrentThreadSelection(null);
      emitExplorerStateChange();
    },
    createDraft: (project) => {
      const draft = threadClient.createThread(defaultProviderKey, DraftIdSchema.parse(crypto.randomUUID()), { project });
      applyThreadPayloadToCurrentView(draft);
      emitExplorerStateChange();
    },
    ensureProject: route => ensureRouteProject(route),
    failThread: (projectId, target, error) => {
      threadClient.getThreadController(
        projectId,
        target.kind === "subagent"
          ? { kind: "provider", threadId: target.parentThreadId }
          : target,
      ).fail(new Error(error));
    },
    getLocalEntries: () => threadSidebarSnapshot?.entries ?? [],
    getProject: projectId => projectClient.getSnapshot().projects.find(project => project.id === projectId),
    getProjectEntries: projectId => threadSidebarClient.getProjectThreadSidebars().projects
      .find(project => project.projectId === projectId)?.entries ?? [],
    guardNavigation: apply => threadSidebarClient.guardNavigation(apply),
    hydrateSidebar: (route, generation) => {
      void hydrateProjectSidebarData(route, generation);
    },
    openFile: filePath => openFile(filePath),
    openLogicalRoute: (route, isCurrent) => openLogicalRoute(route, isCurrent),
    openThread: (threadId, options) => openThread(threadId, options),
    readPinnedContext: (projectId, target) => readPinnedThreadContext(projectId, target),
    receiveDraft: draft => threadSidebarClient.receiveDraft(draft),
    reportStatus: message => reportStatusMessage(message),
    resolveDraftReferences: async (projectId) => {
      const references = new Set(workbenchBindings.clientStateController?.getSnapshot().records.flatMap(record => (
        (record.kind === "composerDraft" || record.kind === "questionnaireDraft") && record.projectId === projectId
          ? [record.threadId]
          : []
      )));
      const resolved = await Promise.allSettled([...references].map(threadId => threadIdentity.resolve({
        allowProviderAdmission: false,
        projectId: projectId || undefined,
        threadId: ThreadReferenceSchema.parse(threadId),
      })));
      return resolved.some(result => result.status === "rejected");
    },
    resolveProjectId: projectId => workbenchBindings.clientStateController?.resolveProjectId(projectId) ?? projectId,
    resolveRoute: route => threadIdentity.resolveRoute(route),
  });
  coordinatorLifecycle.addUnsubscribe(() => navigation.dispose());
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
      void activeFileDraftStore().hydratePersistedDrafts();
    }
    emitExplorerStateChange();
  }));

  let previousThreadSnapshot = initialThreadSnapshot;
  coordinatorLifecycle.addUnsubscribe(threadClient.subscribe((snapshot) => {
    const lastSnapshot = previousThreadSnapshot;
    previousThreadSnapshot = snapshot;
    if (activeThreadClient !== threadClient) return;

    if (
      !areThreadPayloadsEquivalent(lastSnapshot.currentThread, snapshot.currentThread)
      || lastSnapshot.currentThreadId !== snapshot.currentThreadId
    ) {
      const nextThreadId = snapshot.currentThread?.id ?? snapshot.currentThreadId;
      const route = navigation.getSnapshot().route;
      if (isWorkbenchRouteOwnerOfThread(route, nextThreadId, snapshot.currentThread?.isDraft,
        route.logical?.location ?? undefined)) {
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
  const refreshProjectCatalogRoute = async (reapplyCurrentRoute: boolean) => {
    const removedSelectedProject = await projectClient.refreshCatalog();
    await attachedSession?.refresh();
    const route = navigation.getSnapshot().route;
    const routeProjectId = route.projectId
      ? workbenchBindings.clientStateController?.resolveProjectId(route.projectId) ?? route.projectId
      : "";
    const removedRouteProject = Boolean(routeProjectId)
      && !projectClient.getSnapshot().projects.some(project => project.id === routeProjectId);
    if (removedSelectedProject || removedRouteProject) {
      await navigation.applyRoute(createHomeRoute());
    } else if (reapplyCurrentRoute) {
      await navigation.applyRoute(route);
    }
    emitExplorerStateChange();
    return removedSelectedProject || removedRouteProject;
  };
  const recoverConnection = async (continuity: WorkbenchConnectionContinuity) => {
    projectClient.resetObservation();
    if (continuity === "lost") {
      daemonRuntime.resetConnection();
      threadClient.resetConnectionState();
    }
    await daemonRuntime.open();
    const wentHome = await refreshProjectCatalogRoute(false);
    if (!wentHome) await threadSidebarClient.reopen();
    if (coordinatorLifecycle.isDisposed) return;
    threadClient.threadObservations.reset();
    if (continuity === "lost" && !wentHome) {
      await navigation.applyRoute(navigation.getSnapshot().route);
    }
    await threadClient.recoverThreadControllers();
    if (navigation.getSnapshot().route.view === "thread") await refreshRateLimits();
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
    for (const filePath of activeFileDraftStore().getLocallyModifiedPaths()) {
      modifiedPaths.add(filePath);
    }

    return Array.from(modifiedPaths).sort((left, right) => left.localeCompare(right));
  }

  function getExplorerSnapshot(): ExplorerSnapshot {
    const projectSnapshot = activeProjectClient.getSnapshot();
    const attachedProjectSnapshot = projectClient.getSnapshot();
    const threadSnapshot = activeThreadClient.getSnapshot();
    const presentation = presentationClient?.snapshot().data;
    const catalogs = new Map<DaemonId, readonly WorkbenchProjectOption[]>();
    const summaries = new Map<DaemonId, WorkbenchProjectThreadSummaries>();
    const sidebars = new Map<DaemonId, WorkbenchProjectThreadSidebars>();
    const attachedId = workbenchBindings.clientStateController?.getSnapshot().registrations
      .find(registration => registration.kind === "local")?.daemonId;
    if (attachedId && (!attachedSession || attachedSession.getSnapshot().phase === "ready")) {
      catalogs.set(attachedId, attachedProjectSnapshot.projects);
      summaries.set(attachedId, threadSidebarClient.getProjectThreadSummaries());
      sidebars.set(attachedId, threadSidebarClient.getProjectThreadSidebars());
    }
    for (const session of daemonSessions?.list() ?? []) {
      if (session.getSnapshot().phase !== "ready") continue;
      const projects = session.projects?.getSnapshot().projects;
      if (projects) catalogs.set(session.getSnapshot().daemonId, projects);
      const peerSummaries = session.sidebar?.getProjectThreadSummaries();
      if (peerSummaries) summaries.set(session.getSnapshot().daemonId, peerSummaries);
      const projectSidebars = session.sidebar?.getProjectThreadSidebars();
      if (projectSidebars) sidebars.set(session.getSnapshot().daemonId, projectSidebars);
    }
    const logicalProjects = presentation ? projectLogicalProjects(presentation, catalogs) : undefined;
    return {
      root: projectSnapshot.root,
      configuredDiscoveryRootPath: projectSnapshot.configuredDiscoveryRootPath,
      currentProjectId: projectSnapshot.currentProjectId,
      projects: projectSnapshot.projects,
      ...(logicalProjects && presentation ? {
        logicalProjects,
        logicalSummaries: Object.fromEntries(projectLogicalSummaries(logicalProjects, summaries)),
        logicalThreads: projectLogicalThreadRows(logicalProjects, sidebars, presentation),
      } : {}),
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

  function selectBrowsePeer(session: WorkbenchDaemonSession | null) {
    if (activeBrowsePeerSession === session) return;
    unsubscribeActiveBrowsePeer?.();
    activeBrowsePeerSession = session;
    activeProjectClient = session?.projects ?? projectClient;
    activeFilePath = "";
    void activeFileDraftStore().hydratePersistedDrafts().catch(error => reportStatusMessage(
      error instanceof Error ? error.message.slice(0, 512) : "File drafts could not be loaded.",
    ));
    if (session) {
      let observedProjectId = session.projects?.getSnapshot().currentProjectId ?? "";
      unsubscribeActiveBrowsePeer = session.projects?.subscribe(snapshot => {
        if (activeBrowsePeerSession !== session) return;
        const changed = observedProjectId !== snapshot.currentProjectId;
        observedProjectId = snapshot.currentProjectId;
        if (activePeerSession === session) {
          session.threads.setProjectContext({
            projectId: snapshot.currentProjectId, root: snapshot.root,
            rootPath: snapshot.rootPath, roots: snapshot.roots,
          });
        }
        if (changed) void activeFileDraftStore().hydratePersistedDrafts().catch(error => reportStatusMessage(
          error instanceof Error ? error.message.slice(0, 512) : "File drafts could not be loaded.",
        ));
        emitExplorerStateChange();
      }) ?? null;
    } else {
      unsubscribeActiveBrowsePeer = null;
    }
    emitExplorerStateChange();
  }

  function selectActivePeer(session: WorkbenchDaemonSession | null, syncBrowse = true) {
    if (syncBrowse) selectBrowsePeer(session);
    if (activePeerSession === session) return;
    const previous = activePeerSession;
    unsubscribeActivePeer?.();
    unsubscribeActivePeer = null;
    activePeerSession = session;
    if (previous && previous !== session && previous !== activeBrowsePeerSession) {
      void previous.observeProject(null).catch(error => reportStatusMessage(
        error instanceof Error ? error.message.slice(0, 512) : "The peer thread list could not return to global observation.",
      ));
    }
    activeThreadClient = session?.threads ?? threadClient;
    sessionState.setCurrentThreadSelection(null);
    if (session) {
      unsubscribeActivePeer = session.threads.subscribe(snapshot => {
        if (activePeerSession !== session) return;
        const route = navigation.getSnapshot().route;
        const location = route.logical?.legacyOwnerLocation ?? route.logical?.location;
        const nextThreadId = snapshot.currentThread?.id ?? snapshot.currentThreadId;
        if (location && isWorkbenchRouteOwnerOfThread(route, nextThreadId,
          snapshot.currentThread?.isDraft, location)) {
          applyCurrentThreadSelection(snapshot.currentThread);
        }
        threadRuntime.accept(createThreadRuntimeSnapshot(snapshot));
        emitExplorerStateChange();
      });
    }
    threadRuntime.accept(createThreadRuntimeSnapshot());
    emitExplorerStateChange();
  }
  coordinatorLifecycle.addUnsubscribe(() => unsubscribeActivePeer?.());
  coordinatorLifecycle.addUnsubscribe(() => unsubscribeActiveBrowsePeer?.());

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
    activeProjectClient.toggleDirectory(path);
  }

  async function refreshRateLimits() {
    await activeThreadClient.refreshRateLimits();
  }

  function hydrateProjectSidebarData(route: WorkbenchRoute, generation: number, options: { block?: boolean } = {}) {
    void options;
    if (navigation.isCurrent(route, generation)) emitExplorerStateChange();
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
    if (navigation.getSnapshot().route.logical) {
      return await threadRouter.withThread(threadId, async (owner, source) =>
        await source.threads.readThread(owner.id, owner.harness, options));
    }
    return await activeThreadClient.readThread(threadId, harness, options);
  }

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    options: WorkbenchSendThreadMessageOptions = {},
  ) {
    let owner = activeThreadClient;
    const route = navigation.getSnapshot().route;
    if (!thread.isDraft && route.logical) {
      const payload = await threadRouter.withThread(thread.id, async (resolved, source) => {
        if (thread.harness !== resolved.harness) throw new Error("Thread harness does not match its UUID owner.");
        return await source.threads.sendThreadMessage(thread, input, options);
      });
      if (payload && route.view === "thread" && route.threadId === thread.id
        && navigation.getSnapshot().route === route && options.selectThread !== false) {
        applyThreadPayloadToCurrentView(payload, "Sent message.");
      }
      emitExplorerStateChange();
      return payload;
    }
    if (thread.isDraft && route.logical) {
      const location = draftLocationFor(thread.id);
      const presentation = presentationClient;
      if (!location || !presentation) {
        throw new Error("The saved draft has no concrete daemon folder.");
      }
      const source = threadRouter.sourceFor(location.daemonId);
      if (!source) throw new Error("The draft's daemon is unavailable.");
      owner = source.threads;
      const currentLocation = presentation.draft(thread.id)?.target;
      if (!currentLocation || currentLocation.daemonId !== location.daemonId
        || currentLocation.projectId !== location.projectId) {
        throw new Error("The saved draft target changed before launch.");
      }
      const saved = presentation.draft(thread.id);
      if (!saved) throw new Error("The saved draft is unavailable.");
      if (saved.phase === "unsent") await validateDraftDestination(saved, location);
      if (navigation.getSnapshot().route !== route
        || presentation.draft(thread.id)?.target.daemonId !== location.daemonId
        || presentation.draft(thread.id)?.target.projectId !== location.projectId) {
        throw new ThreadMessageNotSentError();
      }
      const attachedId = networkClient?.snapshot().snapshot?.daemon?.daemonId;
      const launch = new ThreadLaunchController({
        presentation,
        daemon: target => {
          if (target.daemonId === attachedId) return daemon;
          const session = daemonSessions?.get(target.daemonId);
          return session?.getSnapshot().phase === "ready" ? session.daemon : null;
        },
      });
      const threadId = await launch.launch(thread.id, input, options);
      const peer = daemonSessions?.get(location.daemonId);
      const project = peer
        ? peer.projects?.getSnapshot().projects.find(item => item.id === location.projectId)
        : projectClient.getSnapshot().projects.find(item => item.id === location.projectId);
      if (!project) throw new Error("The launched thread's folder is unavailable.");
      const outcome = await owner.openThread(threadId, {
        harness: thread.harness, project,
        isCurrent: () => navigation.getSnapshot().route === route,
      });
      if (outcome.kind === "failure") throw outcome.failure;
      if (outcome.kind === "superseded") return null;
      options.onThreadCreated?.(outcome.payload);
      options.onThreadMaterialized?.(outcome.payload);
      if (route.view === "thread" && navigation.getSnapshot().route === route
        && options.selectThread !== false) {
        applyThreadPayloadToCurrentView(outcome.payload, "Started thread.");
      }
      emitExplorerStateChange();
      return outcome.payload;
    }
    let createdThreadId = "";
    let payload: ThreadPayload | null;
    try {
      payload = await owner.sendThreadMessage(thread, input, {
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
    const payload = navigation.getSnapshot().route.logical && !thread.isDraft
      ? await threadRouter.withThread(thread.id, async (_owner, source) =>
        await source.threads.stopThread(thread))
      : await activeThreadClient.stopThread(thread);
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
    const createdPath = await activeProjectClient.createEntry(parentPath, name, type);

    reportStatusMessage(`Created ${createdPath}`);

    return createdPath;
  }

  async function deleteFile(filePath: string, options: { confirmUntracked?: boolean } = {}): Promise<DeleteFileResponse> {
    const result = await activeProjectClient.deleteFile(filePath, options);
    if (result.confirmationRequired) {
      return result;
    }

    try {
      await activeFileDraftStore().clearBuffer(filePath);
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
    const payload = navigation.getSnapshot().route.logical && !thread.isDraft
      ? await threadRouter.withThread(thread.id, async (_owner, source) =>
        await source.threads.compactThread(thread))
      : await activeThreadClient.compactThread(thread);
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

  async function openLogicalRoute(route: WorkbenchRoute, isCurrent: () => boolean): Promise<WorkbenchRouteLoadResult> {
    const address = route.logical;
    const presentation = presentationClient?.snapshot().data;
    if (!address || !presentation) return { ok: false, error: "Project presentation state is unavailable." };
    const existingTarget = route.view === "thread" && route.threadTarget
      && (route.threadTarget.kind === "provider" || route.threadTarget.kind === "subagent")
      ? route.threadTarget : null;
    let existingOwner: Awaited<ReturnType<typeof threadRouter.resolve>> | null = null;
    if (existingTarget) {
      try {
        existingOwner = await threadRouter.resolve(existingTarget.kind === "subagent"
          ? existingTarget.parentThreadId : existingTarget.threadId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Thread owner resolution failed." };
      }
      if (!isCurrent()) return { ok: false };
      if (existingOwner.kind !== "thread") return { ok: false, error: "This route does not name an existing thread." };
      if (address.legacyOwnerLocation
        && (address.legacyOwnerLocation.daemonId !== existingOwner.location.daemonId
          || address.legacyOwnerLocation.projectId !== existingOwner.location.projectId)) {
        return { ok: false, error: "The legacy thread address does not match its owner." };
      }
      if (address.threadOwnerProjectId && address.threadOwnerProjectId !== existingOwner.logicalProjectId) {
        return { ok: false, error: "The thread does not belong to the linked project." };
      }
    }
    const ownerId = existingOwner?.logicalProjectId
      ?? (route.view === "thread" ? address.threadOwnerProjectId : address.projectId);
    if (!ownerId || !presentation.projects.some(project => project.id === ownerId)) {
      return { ok: false, error: "This project identity is unavailable." };
    }
    if (address.projectId && !presentation.projects.some(project => project.id === address.projectId)) {
      return { ok: false, error: "The selected project identity is unavailable." };
    }
    let selectedBrowse = address.projectId
      ? presentation.locations.find(item =>
        item.logicalProjectId === address.projectId
        && item.target.daemonId === address.browseLocation?.daemonId
        && item.target.projectId === address.browseLocation?.projectId)
        ?? presentation.locations.find(item => item.logicalProjectId === address.projectId)
      : null;
    if (address.browseLocation && (!selectedBrowse
      || selectedBrowse.target.daemonId !== address.browseLocation.daemonId
      || selectedBrowse.target.projectId !== address.browseLocation.projectId)) {
      return { ok: false, error: "The browse folder does not belong to the selected project." };
    }
    const availableSource = async (target: { daemonId: DaemonId; projectId: string }) => {
      const attachedId = networkClient?.snapshot().snapshot?.daemon?.daemonId
        ?? workbenchBindings.clientStateController?.getSnapshot().registrations.find(item => item.kind === "local")?.daemonId;
      if (target.daemonId === attachedId) {
        if (!attachedSession) return null;
        await attachedSession.start();
        if (attachedSession.getSnapshot().phase !== "ready") await attachedSession.refresh();
        return attachedSession.getSnapshot().phase === "ready"
          ? { project: projectClient, threads: threadClient, session: null as WorkbenchDaemonSession | null }
          : null;
      }
      const session = daemonSessions?.get(target.daemonId) ?? null;
      if (session) {
        await session.start();
        if (session.getSnapshot().phase !== "ready") await session.refresh();
      }
      return session?.getSnapshot().phase === "ready" && session.projects
        ? { project: session.projects, threads: session.threads, session } : null;
    };
    const importAttachedLayouts = () => {
      void attachedSession?.importAvailableLayouts().catch(error => {
        if (coordinatorLifecycle.isDisposed || error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Attached layout import could not finish:",
          error instanceof Error
            ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512)
            : "Unknown error.");
      });
    };
    if (route.view === "mosaic" && route.mosaicNode) {
      const resolvePane = async (node: WorkbenchMosaicNode): Promise<WorkbenchMosaicNode> => {
        if (node.type === "split") {
          return { ...node, children: await Promise.all(node.children.map(resolvePane)) };
        }
        const pane = node.target;
        if (pane.kind === "file" || pane.target.kind === "new" || pane.target.kind === "draft") {
          const location = pane.source?.location;
          if (!location || !presentation.locations.some(item =>
            item.logicalProjectId === pane.source?.logicalProjectId
            && item.target.daemonId === location.daemonId
            && item.target.projectId === location.projectId)) {
            throw new Error("A mosaic pane has no registered daemon folder.");
          }
          const paneSource = await availableSource(location);
          if (!paneSource) throw new Error("A mosaic pane's daemon is unavailable.");
          if (pane.kind === "thread" && pane.target.kind === "draft") {
            const draftId = pane.target.draftId;
            const saved = presentation.drafts.find(item => item.id === draftId
              && (item.phase === "unsent" || item.phase === "submitting"));
            if (saved && (saved.target.daemonId !== location.daemonId
              || saved.target.projectId !== location.projectId
              || saved.logicalProjectId !== pane.source?.logicalProjectId)) {
              throw new Error("The mosaic draft address does not match its saved target.");
            }
            if (!paneSource.threads.hasThread(draftId)) {
              if (!saved) throw new Error("The mosaic draft is unavailable.");
              const project = paneSource.project.getSnapshot().projects.find(item =>
                item.id === location.projectId);
              if (!project) throw new Error("The mosaic draft's folder is unavailable.");
              paneSource.threads.createThread(
                saved.selection.settings?.harness ?? defaultProviderKey,
                draftId, { project, select: false },
              );
            }
          }
          return node;
        }
        const id = pane.target.kind === "subagent" ? pane.target.parentThreadId : pane.target.threadId;
        const resolved = await threadRouter.resolve(id);
        if (resolved.kind !== "thread") throw new Error("A mosaic thread UUID belongs to a draft.");
        if (pane.source && (pane.source.location?.daemonId !== resolved.location.daemonId
          || pane.source.location.projectId !== resolved.location.projectId
          || pane.source.logicalProjectId !== resolved.logicalProjectId)) {
          throw new Error("The legacy mosaic thread address does not match its owner.");
        }
        return pane.source ? { ...node, target: { ...pane, source: undefined } } : node;
      };
      try {
        const canonical = await resolvePane(route.mosaicNode);
        if (!isCurrent()) return { ok: false };
        emitExplorerStateChange();
        const canonicalRoute = createLogicalMosaicRoute(ownerId, canonical);
        return isSameWorkbenchRoute(route, canonicalRoute) ? { ok: true }
          : { ok: true, canonicalRoute };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Mosaic owner resolution failed." };
      }
    }
    const locations = presentation.locations.filter(item => item.logicalProjectId === ownerId);
    const draftTargetId = route.view === "thread" && route.threadTarget?.kind === "draft"
      ? route.threadTarget.draftId : null;
    const savedDraft = draftTargetId
      ? presentation.drafts.find(draft => draft.id === draftTargetId
        && draft.logicalProjectId === ownerId
        && (draft.phase === "unsent" || draft.phase === "submitting")) ?? null
      : null;
    if (route.view === "thread" && route.threadTarget?.kind === "draft" && !savedDraft) {
      return { ok: false, error: "This unsent draft is unavailable." };
    }
    if (savedDraft && address.location
      && (savedDraft.target.daemonId !== address.location.daemonId
        || savedDraft.target.projectId !== address.location.projectId)) {
      return { ok: false, error: "The legacy draft address does not match its saved target." };
    }
    const requestedTarget = existingOwner?.location ?? savedDraft?.target ?? address.location;
    const requestedLocation = requestedTarget
      ? locations.find(item => item.target.daemonId === requestedTarget.daemonId
        && item.target.projectId === requestedTarget.projectId) ?? null
      : null;
    if (requestedTarget && !requestedLocation) {
      return { ok: false, error: "The selected daemon folder does not belong to this project." };
    }
    let location = requestedLocation;
    let source: Awaited<ReturnType<typeof availableSource>> = null;
    const canChooseLocation = route.view === "project"
      || route.view === "thread" && route.threadTarget?.kind === "new";
    for (const candidate of requestedLocation ? [requestedLocation] : canChooseLocation ? locations : []) {
      source = await availableSource(candidate.target);
      if (!isCurrent()) return { ok: false };
      if (source) { location = candidate; break; }
    }
    if (!location) {
      if (!canChooseLocation) {
        return { ok: false, error: "This route needs a concrete daemon folder." };
      }
      selectActivePeer(null);
      projectClient.enterNoProject();
      applyCurrentThreadSelection(null);
      emitExplorerStateChange();
      return { ok: true };
    }
    if (!source) return { ok: false, error: "The selected daemon folder is unavailable." };
    if (existingTarget) {
      const project = source.project.getSnapshot().projects.find(item =>
        item.id === location.target.projectId);
      if (!project) return { ok: false, error: "The thread's folder is unavailable." };
      let browseSource: Awaited<ReturnType<typeof availableSource>> = null;
      const browseCandidates = address.browseLocation
        ? selectedBrowse ? [selectedBrowse] : []
        : presentation.locations.filter(item => item.logicalProjectId === address.projectId);
      for (const candidate of browseCandidates) {
        const candidateSource = await availableSource(candidate.target);
        if (!isCurrent()) return { ok: false };
        if (candidateSource && await candidateSource.project.selectProjectStrict(candidate.target.projectId)) {
          if (!isCurrent()) return { ok: false };
          selectedBrowse = candidate;
          browseSource = candidateSource;
          break;
        }
      }
      if (address.browseLocation && !browseSource) {
        return { ok: false, error: "The selected browse folder is unavailable." };
      }
      if (!browseSource) selectedBrowse = null;
      if (source.session) await source.session.observeProject(null);
      else if (!await threadSidebarClient.openGlobal()) {
        return { ok: false, error: "The global thread observation could not open." };
      }
      if (!source.session) importAttachedLayouts();
      if (!isCurrent()) return { ok: false };
      selectActivePeer(source.session, false);
      selectBrowsePeer(browseSource?.session ?? null);
      if (!selectedBrowse) projectClient.enterNoProject();
      source.threads.setProjectContext({
        projectId: project.id, root: project.name || project.id,
        rootPath: project.rootPath, roots: project.roots,
      });
      const threadId = existingTarget.kind === "subagent"
        ? existingTarget.parentThreadId : existingTarget.threadId;
      const outcome = await source.threads.openThread(threadId, {
        harness: existingTarget.harness, project, isCurrent,
      });
      if (!isCurrent() || outcome.kind === "superseded") return { ok: false };
      if (outcome.kind === "failure") return { ok: false, error: outcome.failure.message };
      applyThreadPayloadToCurrentView(outcome.payload);
      emitExplorerStateChange();
      const canonicalRoute = createLogicalExistingThreadRoute(address.projectId, existingTarget,
        selectedBrowse?.target ?? null);
      return isSameWorkbenchRoute(route, canonicalRoute) ? { ok: true }
        : { ok: true, canonicalRoute };
    }
    const selected = await source.project.selectProjectStrict(location.target.projectId);
    if (!selected || !isCurrent()) return selected
      ? { ok: false } : { ok: false, error: "The selected daemon folder is unavailable." };
    if (source.session) await source.session.observeProject(null);
    else if (!await threadSidebarClient.openGlobal()) {
      return { ok: false, error: "The global thread observation could not open." };
    }
    if (!source.session) importAttachedLayouts();
    if (!isCurrent()) return { ok: false };
    selectActivePeer(source.session);
    const project = source.project.getSnapshot().projects.find(item => item.id === location.target.projectId);
    if (!project) return { ok: false, error: "The selected project folder is missing." };
    source.threads.setProjectContext({
      projectId: project.id, root: project.name || project.id,
      rootPath: project.rootPath, roots: project.roots,
    });
    if (route.view === "project") {
      applyCurrentThreadSelection(null);
      emitExplorerStateChange();
      return address.location ? { ok: true }
        : { ok: true, canonicalRoute: createLogicalProjectRoute(ownerId, location.target) };
    }
    if (route.view === "thread" && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft")) {
      const draftId = DraftIdSchema.parse(savedDraft?.id ?? crypto.randomUUID());
      const draftThread = source.threads.createThread(
        savedDraft?.selection.settings?.harness ?? defaultProviderKey,
        draftId,
        { project },
      );
      applyThreadPayloadToCurrentView(draftThread);
      emitExplorerStateChange();
      const locationMatches = address.location?.daemonId === location.target.daemonId
        && address.location?.projectId === location.target.projectId;
      const canonicalRoute = createLogicalThreadRoute(address.projectId, ownerId,
        savedDraft ? null : location.target,
        savedDraft ? { kind: "draft", draftId } : { kind: "new" });
      return (savedDraft ? isSameWorkbenchRoute(route, canonicalRoute) : locationMatches)
        ? { ok: true } : {
        ok: true,
        canonicalRoute,
      };
    }
    if (route.view === "git") {
      applyCurrentThreadSelection(null);
      emitExplorerStateChange();
      return { ok: true };
    }
    if (route.view === "file") {
      applyCurrentThreadSelection(null);
      activeFilePath = route.filePath;
      emitExplorerStateChange();
      return { ok: true };
    }
    return { ok: false, error: "This logical route is not ready for navigation." };
  }

  function draftLocationFor(draftId: string): ProjectLocationReference | null {
    const saved = presentationClient?.draft(draftId);
    if (saved) return saved.target;
    const visit = (node: WorkbenchMosaicNode | null): ProjectLocationReference | null => {
      if (!node) return null;
      if (node.type === "split") {
        for (const child of node.children) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      }
      return node.target.kind === "thread"
        && node.target.target.kind === "draft"
        && node.target.target.draftId === draftId
        ? node.target.source?.location ?? null : null;
    };
    return visit(navigation.getSnapshot().route.mosaicNode);
  }

  async function ensureRouteProject(route: WorkbenchRoute) {
    selectActivePeer(null);
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
    if (attachedSession) void attachedSession.importAvailableLayouts().catch(error =>
      reportStatusMessage(error instanceof Error ? error.message.slice(0, 512)
        : "Legacy layout import could not run."));

    const nextProjectId = projectClient.getSnapshot().currentProjectId;
    if (nextProjectId && workbenchBindings.clientStateController) {
      void workbenchBindings.clientStateController.put({
        daemonRegistrationId: workbenchBindings.clientStateController.daemonRegistrationId,
        kind: "lastLaunchTarget",
        projectId: nextProjectId,
      }).catch((error: Error) => reportStatusMessage(error.message));
    }
    if (nextProjectId && previousProjectId !== nextProjectId) {
      await activeFileDraftStore().hydratePersistedDrafts();
    }

    return "";
  }

  async function applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    return await navigation.applyRoute(route);
  }

  async function updateThreadStateWithAcceptance(request: Parameters<WorkbenchControls["updateThreadState"]>[0]) {
    const owner = activeThreadClient;
    const sidebar = activePeerSession?.sidebar ?? threadSidebarClient;
    if (request.method === "workbench/thread-state/title/dismiss" && !activePeerSession) {
      await admitPinnedTitleAction(request.projectId, request.identity);
    }
    const response = await owner.requestWorkbench(request.method, request);
    if (request.method === "workbench/thread-state/refresh") {
      const parsed = WorkbenchThreadSidebarSnapshotSchema.safeParse(response);
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench thread state refresh response", parsed.error);
        throw new Error("The thread state refresh response was invalid.");
      }
      sidebar?.accept(parsed.data);
      return true;
    }
    const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(response);
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench thread state mutation response", parsed.error);
      throw new Error("The thread state mutation response was invalid.");
    }
    return parsed.data.accepted;
  }

  async function threadAction(threadId: string, intent: WorkbenchThreadIntent): Promise<boolean> {
    return await threadRouter.withThread(threadId, async (owner, source) => {
      if (intent.kind === "stop") {
        const thread = await source.threads.readThread(owner.id, owner.harness);
        if (!thread) throw new Error("The owning daemon could not read this thread.");
        await source.threads.stopThread(thread);
        return true;
      }
      const projectId = owner.location.projectId;
      const identity = { harness: owner.harness, threadId: WorkbenchThreadIdSchema.parse(owner.id) };
      const untilOwner = intent.kind === "snoozeUntil"
        ? await threadRouter.resolve(intent.targetThreadId) : null;
      if (untilOwner && (untilOwner.kind !== "thread"
        || untilOwner.location.daemonId !== owner.location.daemonId)) {
        throw new Error("Dependent snooze needs two threads on the same daemon.");
      }
      const request: WorkbenchThreadStateRequest = intent.kind === "snoozeUntil" && untilOwner?.kind === "thread"
        ? { method: "workbench/thread-state/snooze/until", identity, projectId,
          target: { identity: { harness: untilOwner.harness,
            threadId: WorkbenchThreadIdSchema.parse(untilOwner.id) },
          projectId: untilOwner.location.projectId } }
        : intent.kind === "priority"
        ? { method: "workbench/thread-state/priority/set", priority: intent.priority, projectId,
          sourceKey: getThreadDisplayThreadKey(owner.harness, identity.threadId) }
        : intent.kind === "pin"
          ? { method: "workbench/thread-state/pin/set", identity, projectId, pinned: intent.pinned }
        : intent.kind === "snooze"
          ? { method: "workbench/thread-state/snooze/set", identity, projectId, snoozed: intent.snoozed }
          : intent.kind === "archive"
            ? { method: "workbench/thread-state/archive/set", identity, projectId, archived: intent.archived }
            : intent.kind === "status"
              ? { method: "workbench/thread-state/status/set", identity, projectId, status: intent.status }
              : intent.kind === "restore"
                ? { method: "workbench/thread-state/restore", identity, projectId }
                : { method: "workbench/thread-state/settle", identity, projectId };
      const response = await source.threads.requestWorkbench(request.method, request);
      const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(response);
      if (!parsed.success) {
        reportClientSchemaError("Rejected UUID-routed thread mutation response", parsed.error);
        throw new Error("The owning daemon returned invalid thread mutation data.");
      }
      return parsed.data.accepted;
    });
  }

  function clientForThreadMutation(threadId: string) {
    const route = navigation.getSnapshot().route;
    if (!route.logical || route.view === "thread"
      && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft")) {
      return activeThreadClient;
    }
    const owner = threadRouter.known(threadId);
    const draftLocation = owner?.kind === "draft" ? owner.location : draftLocationFor(threadId);
    if (draftLocation) {
      const source = threadRouter.sourceFor(draftLocation.daemonId);
      if (!source) throw new Error("The draft's daemon is unavailable.");
      return source.threads;
    }
    if (owner?.kind !== "thread") throw new Error("The thread's UUID owner is unavailable.");
    const source = threadRouter.sourceFor(owner.location.daemonId);
    if (!source) throw new Error("The thread's daemon is unavailable.");
    return source.threads;
  }

  async function validateDraftDestination(
    draft: NonNullable<ReturnType<WorkbenchPresentationClient["draft"]>>,
    target: Parameters<WorkbenchControls["retargetPresentationDraft"]>[1],
  ) {
    const registered = presentationClient?.snapshot().data?.locations.find(location =>
      location.target.daemonId === target.daemonId && location.target.projectId === target.projectId);
    if (registered?.logicalProjectId !== draft.logicalProjectId) {
      throw new Error("That folder belongs to another project identity.");
    }
    const attachedId = networkClient?.snapshot().snapshot?.daemon?.daemonId;
    const peer = daemonSessions?.get(target.daemonId);
    const destination = target.daemonId === attachedId ? daemon
      : peer?.getSnapshot().phase === "ready" ? peer.daemon : null;
    if (!destination) throw new Error("The destination daemon is unavailable.");
    const settings = draft.selection.settings;
    const models = (await destination.models.list(settings.harness)).data
      .filter(model => model.policyState !== "disabled");
    if (!models.length || settings.model && !models.some(model => model.id === settings.model)) {
      throw new Error("The destination daemon does not support this draft's model.");
    }
    const selection = draft.selection;
    if (selection.kind === "profile") {
      const profile = (await destination.profiles.read()).profiles.find(item =>
        item.id === selection.profileId);
      if (!profile || profile.scope.kind === "project" && profile.scope.projectId !== target.projectId) {
        throw new Error("The destination daemon does not have this draft's linked profile. Choose Custom before moving it.");
      }
      if (profile.harness !== settings.harness || profile.model !== settings.model
        || !areWorkbenchAgentPathsEqual(profile.agentPath, settings.agentPath)
        || profile.agentSource !== settings.agentSource
        || profile.reasoningEffort !== settings.reasoningEffort
        || profile.serviceTier !== settings.serviceTier
        || (profile.contextWindowTokens ?? null) !== (settings.contextWindowTokens ?? null)) {
        throw new Error("The destination profile differs from this draft's saved settings. Choose Custom before moving it.");
      }
    }
    if (settings.agentPath) {
      const agents = (await destination.agents.list({ projectId: target.projectId })).data ?? [];
      if (!agents.some(agent => areWorkbenchAgentPathsEqual(agent.path, settings.agentPath))) {
        throw new Error("The destination folder does not have this draft's selected agent.");
      }
    }
  }

  const controls: MountedWorkbenchControls = {
    applyRoute,
    daemon,
    refreshProjectCatalog: async () => {
      await refreshProjectCatalogRoute(true);
    },
    createFilePanelClient: (surfaces, filePanelOptions = {}) => {
      const panelLifecycle = new LifecycleScope();
      const { location, ...panelOptions } = filePanelOptions;
      const registered = !location || presentationClient?.snapshot().data?.locations.some(item =>
        item.target.daemonId === location.daemonId && item.target.projectId === location.projectId);
      if (!registered) throw new Error("This file panel has no registered daemon folder.");
      const source = location ? threadRouter.sourceFor(location.daemonId) : null;
      if (location && !source) throw new Error("The file panel's daemon is unavailable.");
      const peer = location ? daemonSessions?.get(location.daemonId) : activeBrowsePeerSession;
      const sourceProjects = location
        ? peer?.projects ?? projectClient : activeProjectClient;
      const sourceDaemon = source?.daemon ?? activeBrowsePeerSession?.daemon ?? daemon;
      const sourceProjectId = location?.projectId ?? sourceProjects.getSnapshot().currentProjectId;
      const registrationId = peer?.getSnapshot().registrationId
        ?? workbenchBindings.clientStateController?.daemonRegistrationId ?? "";
      const client = WorkbenchFilePanelClient({
        ...panelOptions,
        clearThreadSelection: () => {
          if (location) return;
          activeThreadClient.clearThreadSelection();
          applyCurrentThreadSelection(null);
        },
        draftStore: fileDraftStoreFor(sourceProjectId, registrationId),
        fileTransport: {
          read: async (projectId, path) => await sourceDaemon.projects.files.read({ path, projectId }),
          reset: async (projectId, path, expectedMtimeMs, force) => await sourceDaemon.projects.files.reset({ expectedMtimeMs, force, path, projectId }),
          save: async (projectId, path, content, expectedMtimeMs, force) => await sourceDaemon.projects.files.save({ content, expectedMtimeMs, force, path, projectId }),
        },
        emitExplorerStateChange,
        expandProjectPath: (filePath) => {
          if (sourceProjects.getSnapshot().currentProjectId === sourceProjectId) {
            sourceProjects.expandPath(filePath);
          }
        },
        getProjectChangeSummary: (path) => sourceProjects.getSnapshot().currentProjectId === sourceProjectId
          ? sourceProjects.getSnapshot().changes[path] ?? null : null,
        getProjectId: () => sourceProjectId,
        refreshProject: async () => {
          if (sourceProjects.getSnapshot().currentProjectId === sourceProjectId) {
            await sourceProjects.refreshProject();
          } else {
            await (source?.threads ?? activeThreadClient).requestWorkbench(
              "workbench/thread-state/project/refresh", { projectId: sourceProjectId },
            );
          }
        },
        surfaces,
      }, panelLifecycle);
      mountedFilePanelClients.add(client);
      panelLifecycle.addUnsubscribe(() => mountedFilePanelClients.delete(client));
      return client;
    },
    createThreadDraft: (harness, draftOptions = {}) => {
      const draftThread = activeThreadClient.createThread(harness, draftOptions.threadId, {
        select: draftOptions.select,
      });
      if (draftOptions.select !== false) {
        applyThreadPayloadToCurrentView(draftThread);
      }
      emitExplorerStateChange();
      return draftThread;
    },
    createThreadDraftAt: (location, harness, draftOptions = {}) => {
      const registered = presentationClient?.snapshot().data?.locations.some(item =>
        item.target.daemonId === location.daemonId && item.target.projectId === location.projectId);
      if (!registered) throw new Error("The selected launch folder is not registered.");
      const source = threadRouter.sourceFor(location.daemonId);
      if (!source) throw new Error("The selected launch daemon is unavailable.");
      const peer = daemonSessions?.get(location.daemonId);
      const project = peer
        ? peer.projects?.getSnapshot().projects.find(item => item.id === location.projectId)
        : projectClient.getSnapshot().projects.find(item => item.id === location.projectId);
      if (!project) throw new Error("The selected launch folder is unavailable.");
      const draft = source.threads.createThread(harness, draftOptions.threadId, {
        project, select: draftOptions.select,
      });
      emitExplorerStateChange();
      return draft;
    },
    createEntry,
    deleteFile,
    deleteThreadDraft: async (draftId, projectId) => {
      const selectedDraft = navigation.getSnapshot().selectedPinnedThreadDraft;
      const ownerProjectId = projectId ?? (selectedDraft?.draftId === draftId ? selectedDraft.projectId : undefined);
      await threadSidebarClient.delete(draftId, Date.now(), ownerProjectId);
      if (ownerProjectId) navigation.clearPinnedDraft(ownerProjectId, draftId);
    },
    editThreadDraft: (draft, options) => {
      threadSidebarClient.edit(draft, options);
      navigation.updatePinnedDraft(draft);
    },
    flushThreadDraft: (projectId, draftId) => threadSidebarClient.flushDraft(projectId, draftId),
    getSelectedThreadDraft: () => navigation.readPinnedDraft(
      (projectId, draftId) => threadSidebarClient.getDraft(ProjectIdSchema.parse(projectId), DraftIdSchema.parse(draftId)),
    ),
    listModels: (harness, options) => activeThreadClient.listModels(harness, options),
    moveThreadDraft: async (sourceProjectId, destinationProjectId, draftId) => {
      await threadSidebarClient.moveDraft(sourceProjectId, destinationProjectId, draftId);
      navigation.movePinnedDraft(sourceProjectId, destinationProjectId, draftId);
    },
    readThread,
    daemonRuntime,
    refreshRateLimits,
    sendThreadMessage,
    setThreadTitle: async (request) => {
      const activeRoute = navigation.getSnapshot().route;
      if (activeRoute.logical) {
        return await threadRouter.withThread(request.threadId, async (resolved, source) => {
          const parsed = WorkbenchThreadTitleMutationResultSchema.safeParse(
            await source.threads.requestWorkbench("workbench/thread-state/title/set", {
              identity: { harness: resolved.harness, threadId: WorkbenchThreadIdSchema.parse(resolved.id) },
              projectId: resolved.location.projectId, title: request.title,
            }),
          );
          if (!parsed.success) {
            reportClientSchemaError("Rejected UUID-routed thread title response", parsed.error);
            throw new Error("The owning daemon returned invalid thread title data.");
          }
          if (parsed.data.identity.threadId !== resolved.id
            || parsed.data.identity.harness !== resolved.harness) {
            throw new Error("The title response did not match the owning thread.");
          }
          source.threads.applyAcceptedThreadTitle(
            parsed.data.identity.threadId, parsed.data.identity.harness, parsed.data.title,
          );
          return parsed.data.title;
        });
      }
      const projectId = request.projectId ?? (activeRoute.view === "thread"
        ? (activeRoute.threadOwnerProjectId || activeRoute.projectId)
        : activeProjectClient.getSnapshot().currentProjectId);
      if (!projectId) throw new Error("A project must be selected before renaming a thread.");
      if (!activePeerSession) await admitPinnedTitleAction(projectId, { harness: request.harness, threadId: request.threadId });
      const owner = activeThreadClient;
      const parsed = WorkbenchThreadTitleMutationResultSchema.safeParse(await owner.requestWorkbench("workbench/thread-state/title/set", {
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
      owner.applyAcceptedThreadTitle(parsed.data.identity.threadId, parsed.data.identity.harness, parsed.data.title);
      return parsed.data.title;
    },
    compactThread,
    stopThread,
    threadAction,
    threadGoals: {
      clear: threadId => activeThreadClient.threadGoals.clear(threadId),
      getSnapshot: threadId => activeThreadClient.threadGoals.getSnapshot(threadId),
      load: threadId => activeThreadClient.threadGoals.load(threadId),
      refresh: threadId => activeThreadClient.threadGoals.refresh(threadId),
      subscribe: (threadId, listener) => activeThreadClient.threadGoals.subscribe(threadId, listener),
      updateObjective: (threadId, objective) => activeThreadClient.threadGoals.updateObjective(threadId, objective),
    },
    deletePresentationDraft: async draftId => {
      if (!presentationClient) throw new Error("App draft presentation state is unavailable.");
      await presentationClient.removeDraft(draftId);
    },
    retargetPresentationDraft: async (draftId, target) => {
      const presentation = presentationClient;
      const draft = presentation?.draft(draftId);
      if (!presentation || !draft || draft.phase !== "unsent") {
        throw new Error("The unsent draft is unavailable.");
      }
      await validateDraftDestination(draft, target);
      await presentation.putDraft({
        id: draft.id, logicalProjectId: draft.logicalProjectId, target,
        prompt: draft.prompt, selection: draft.selection, updatedAt: Date.now(),
      });
    },
    setPresentationDraftPriority: async (draftId, priority) => {
      if (!presentationClient) throw new Error("App presentation state is unavailable.");
      await presentationClient.setDraftPriority(draftId, priority);
    },
    savePresentationProjectLayout: async (logicalProjectId, rows, displayOrder) => {
      if (!presentationClient) throw new Error("App presentation state is unavailable.");
      await presentationClient.saveProjectLayout(logicalProjectId, rows, displayOrder);
    },
    savePresentationHomeLayout: async (rows, displayOrder) => {
      if (!presentationClient) throw new Error("App presentation state is unavailable.");
      await presentationClient.saveHomeLayout(rows, displayOrder);
    },
    savePresentationHomeAndProjectLayouts: async (logicalProjectId, rows, projectOrder, homeOrder) => {
      if (!presentationClient) throw new Error("App presentation state is unavailable.");
      await presentationClient.saveHomeAndProjectLayouts(logicalProjectId, rows, projectOrder, homeOrder);
    },
    updatePresentationProjectLayout: async (logicalProjectId, rows, intent, homeOrder) => {
      if (!presentationClient) throw new Error("App presentation state is unavailable.");
      const source = intent.kind === "rename" ? null : rows.find(row =>
        row.logicalProjectId === logicalProjectId
        && getWorkbenchThreadDisplayKey(row.entry) === intent.sourceKey);
      let nextRows = rows;
      if (source && intent.kind !== "rename"
        && getWorkbenchThreadDisplaySection(source.entry) !== intent.section) {
        if (intent.section === "settled" || source.entry.entryKind === "subagent"
          || source.entry.metadata.archived) {
          throw new Error("This thread cannot move to that section.");
        }
        const priority = intent.section;
        if (source.entry.entryKind === "draft") {
          await presentationClient.setDraftPriority(source.entry.draft.draftId, {
            pinned: priority === "pinned", snoozed: priority === "snoozed",
          });
        } else {
          const accepted = await threadAction(source.entry.identity.threadId,
            { kind: "priority", priority });
          if (!accepted) throw new Error("The source daemon rejected this priority change.");
        }
        nextRows = rows.map(row => row !== source || row.entry.entryKind === "subagent" ? row : {
          ...row, entry: {
            ...row.entry, metadata: {
              archived: false as const, pinned: priority === "pinned", snoozed: priority === "snoozed",
            },
          },
        });
      }
      await presentationClient.updateProjectLayout(logicalProjectId, nextRows, intent, homeOrder);
    },
    updatePresentationPinnedLayout: async (rows, intent) => {
      if (!presentationClient) throw new Error("App presentation state is unavailable.");
      const source = intent.kind === "rename" ? null : rows.find(row =>
        getProjectQualifiedThreadDisplayKey(row.logicalProjectId,
          getWorkbenchThreadDisplayKey(row.entry)) === intent.sourceKey);
      let nextRows = rows;
      if (source && getWorkbenchThreadDisplaySection(source.entry) !== "pinned") {
        if (source.entry.entryKind === "subagent" || source.entry.metadata.archived) {
          throw new Error("This thread cannot be pinned here.");
        }
        if (source.entry.entryKind === "draft") {
          await presentationClient.setDraftPriority(source.entry.draft.draftId, {
            pinned: true, snoozed: false,
          });
        } else {
          const accepted = await threadAction(source.entry.identity.threadId,
            { kind: "priority", priority: "pinned" });
          if (!accepted) throw new Error("The source daemon rejected this pin.");
        }
        nextRows = rows.map(row => row !== source || row.entry.entryKind === "subagent" ? row : {
          ...row, entry: { ...row.entry, metadata: {
            archived: false as const, pinned: true, snoozed: false,
          } },
        });
      }
      await presentationClient.updatePinnedLayout(nextRows, intent);
    },
    submitPendingUserInputRequest: (threadId, response, options) =>
      clientForThreadMutation(threadId).submitPendingUserInputRequest(threadId, response, options),
    setEditorFontSize: (fontSize) => {
      void fontSize;
    },
    setCurrentThreadModel: (threadId, model) => {
      clientForThreadMutation(threadId).setCurrentThreadModel(threadId, model);
    },
    setCurrentThreadAgent: (threadId, agentPath) => {
      clientForThreadMutation(threadId).setCurrentThreadAgent(threadId, agentPath);
    },
    setCurrentThreadComposerSettings: (threadId, settings) => {
      clientForThreadMutation(threadId).setCurrentThreadComposerSettings(threadId, settings);
    },
    setCurrentThreadReasoningEffort: (threadId, effort) => {
      clientForThreadMutation(threadId).setCurrentThreadReasoningEffort(threadId, effort);
    },
    setCurrentThreadServiceTier: (threadId, serviceTier) => {
      clientForThreadMutation(threadId).setCurrentThreadServiceTier(threadId, serviceTier);
    },
    setDraftThreadHarness: (harness) => {
      activeThreadClient.setDraftThreadHarness(harness);
    },
    setDraftThreadHarnessAt: (location, harness) => {
      const registered = presentationClient?.snapshot().data?.locations.some(item =>
        item.target.daemonId === location.daemonId && item.target.projectId === location.projectId);
      if (!registered) throw new Error("The draft's daemon folder is not registered.");
      const source = threadRouter.sourceFor(location.daemonId);
      if (!source) throw new Error("The draft's daemon is unavailable.");
      source.threads.setDraftThreadHarness(harness);
    },
    toggleDirectory,
    updateThreadState: async (request) => {
      await updateThreadStateWithAcceptance(request);
    },
    updateThreadStateWithAcceptance,
  };

  coordinatorLifecycle.addUnsubscribe(daemonRuntime.subscribeServerReloadCompleted(() => {
    void refreshProjectCatalogRoute(true).catch(error => {
      reportConnectionRecoveryFailure("Unable to refresh projects after daemon reload.", error);
    });
  }));
  await daemonRuntime.open().catch((error: unknown) => {
    console.error(
      "Unable to observe Workbench daemon reload dirt.",
      error instanceof Error ? error.message.slice(0, 500) : "Unknown reload observation failure.",
    );
  });
  emitExplorerStateChange();
  const appState = workbenchBindings.clientStateController;
  if (appState && appState.daemonRegistrationId !== "memory") {
    networkClient = new WorkbenchNetworkClient();
    presentationClient = new WorkbenchPresentationClient();
    const network = networkClient;
    const presentation = presentationClient;
    daemonSessions = new WorkbenchDaemonSessions({
      network: {
        snapshot: () => network.snapshot().snapshot,
        subscribe: network.subscribe,
      },
      createSession: options => new WorkbenchDaemonSession({
        ...options, appState, presentation,
        onError: message => reportStatusMessage(message),
      }),
      onError: message => reportStatusMessage(message),
    });
    const sessions = daemonSessions;
    const reconcileAttachedSession = () => {
      const identity = network.snapshot().snapshot?.daemon;
      if (!identity) return;
      if (attachedSession) {
        if (attachedSession.getSnapshot().daemonId !== identity.daemonId) {
          reportStatusMessage("The attached daemon changed during this browser session. Reload the app to switch owners.");
        }
        return;
      }
      attachedSession = new WorkbenchDaemonSession({
        daemonId: DaemonIdSchema.parse(identity.daemonId),
        hostname: identity.hostname,
        attached: { threads: threadClient, daemon, projects: projectClient, sidebar: threadSidebarClient },
        appState, presentation,
        onError: message => reportStatusMessage(message),
      });
      coordinatorLifecycle.addUnsubscribe(attachedSession.subscribe(emitExplorerStateChange));
      void attachedSession.start().catch(error => {
        reportStatusMessage(error instanceof Error ? error.message.slice(0, 512)
          : "The attached daemon session could not start.");
      });
    };
    coordinatorLifecycle.addUnsubscribe(presentation.subscribe(emitExplorerStateChange));
    coordinatorLifecycle.addUnsubscribe(sessions.subscribe(() => {
      threadRouter.invalidateUnavailable();
      emitExplorerStateChange();
    }));
    coordinatorLifecycle.addUnsubscribe(network.subscribe(reconcileAttachedSession));
    coordinatorLifecycle.addUnsubscribe(() => {
      sessions.dispose();
      network.close();
      presentation.dispose();
    });
    sessions.start();
    const networkStart = network.start();
    const presentationRead = presentation.refresh().catch(error => {
      reportStatusMessage(error instanceof Error ? error.message.slice(0, 512)
        : "App presentation state could not be read.");
    });
    if (initialRoute.logical) await Promise.all([networkStart, presentationRead]);
  }
  const initialRouteResult = await applyRoute(navigation.getSnapshot().route);
  if (!initialRouteResult.ok && initialRouteResult.error
    && navigation.getSnapshot().route.logical && navigation.getSnapshot().route.view === "thread") {
    console.warn(`Initial Workbench route could not open: ${
      initialRouteResult.error.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512)
    }`);
  }
  if (sessionState.currentThreadId || navigation.getSnapshot().route.view === "thread") {
    void refreshRateLimits();
  }
  connectionRecovery.start();
  const launchContextFor: MountedWorkbenchClient["launchContextFor"] = location => {
    const registered = presentationClient?.snapshot().data?.locations.some(item =>
      item.target.daemonId === location.daemonId && item.target.projectId === location.projectId);
    if (!registered) return null;
    const source = threadRouter.sourceFor(location.daemonId);
    if (!source) return null;
    const peer = daemonSessions?.get(location.daemonId);
    const project = peer
      ? peer.projects?.getSnapshot().projects.find(item => item.id === location.projectId)
      : projectClient.getSnapshot().projects.find(item => item.id === location.projectId);
    if (!project) return null;
    return { daemonId: location.daemonId, daemon: source.daemon, threads: source.threads,
      project, assetOrigin: peer ? daemonSessions?.httpOrigin(location.daemonId) ?? null : null };
  };
  return {
    networkClient,
    presentationClient,
    daemonSessions,
    voice,
    controls,
    dispose: () => {
      threadSidebarClient.bestEffortFlush();
      void threadSidebarClient.close();
      daemonRuntime.dispose();
      if (attachedSession) attachedSession.dispose();
      else {
        projectClient.dispose();
        threadClient.dispose();
      }
      coordinatorLifecycle.dispose();
    },
    threadRuntime,
    get threadSidebar() { return activeBrowsePeerSession?.sidebar ?? threadSidebarClient; },
    get threadTextPresentation() { return activeThreadClient.textPresentation; },
    getThreadController: (projectId, target) => {
      if (target.kind === "draft") {
        const location = draftLocationFor(target.draftId);
        if (location) {
          const source = threadRouter.sourceFor(location.daemonId);
          return source?.threads.getThreadController(location.projectId, target) ?? null;
        }
      }
      if (!navigation.getSnapshot().route.logical
        || target.kind !== "provider" && target.kind !== "subagent") {
        return activeThreadClient.getThreadController(projectId, target);
      }
      const id = target.kind === "subagent" ? target.parentThreadId : target.threadId;
      try {
        const owner = threadRouter.known(id);
        if (owner?.kind !== "thread") return null;
        const source = threadRouter.sourceFor(owner.location.daemonId);
        if (!source) return null;
        return source.threads.getThreadController(owner.location.projectId, {
          ...target, harness: owner.harness,
        });
      } catch (error) {
        reportStatusMessage(error instanceof Error ? error.message.slice(0, 512)
          : "Thread owner resolution failed.");
        return null;
      }
    },
    threadOwnerFor: threadId => {
      try {
        const owner = threadRouter.known(threadId);
        const presentation = presentationClient?.snapshot().data;
        const retained = presentation?.members.filter(member =>
          member.kind === "thread" && member.thread?.threadId === threadId
          && member.thread.location) ?? [];
        const retainedLocations = new Map(retained.map(member => [
          `${member.thread!.location.daemonId}/${member.thread!.location.projectId}`,
          member.thread!.location,
        ]));
        if (retainedLocations.size > 1) throw new Error("Thread UUID has conflicting saved owners.");
        if (owner?.kind === "thread" && retainedLocations.size) {
          const retainedLocation = retainedLocations.values().next().value!;
          if (retainedLocation.daemonId !== owner.location.daemonId
            || retainedLocation.projectId !== owner.location.projectId) {
            throw new Error("Thread UUID has conflicting observed and saved owners.");
          }
        }
        const location = owner?.kind === "thread"
          ? owner.location : retainedLocations.values().next().value;
        if (!location) return null;
        return {
          daemonId: location.daemonId, projectId: location.projectId,
          hostname: presentation?.daemons.find(item =>
            item.id === location.daemonId)?.hostname ?? location.daemonId,
          rootPath: presentation?.locations.find(item =>
            item.target.daemonId === location.daemonId
            && item.target.projectId === location.projectId)?.rootPath
            ?? location.projectId,
        };
      } catch (error) {
        reportStatusMessage(error instanceof Error ? error.message.slice(0, 512)
          : "Thread owner metadata is conflicting.");
        return null;
      }
    },
    threadContextFor: threadId => {
      try {
        const owner = threadRouter.known(threadId);
        if (owner?.kind !== "thread") return null;
        const source = threadRouter.sourceFor(owner.location.daemonId);
        if (!source) return null;
        const peer = daemonSessions?.get(owner.location.daemonId);
        const project = peer
          ? peer.projects?.getSnapshot().projects.find(item => item.id === owner.location.projectId)
          : projectClient.getSnapshot().projects.find(item => item.id === owner.location.projectId);
        if (!project) return null;
        const registrationId = peer?.getSnapshot().registrationId
          ?? (peer ? null : workbenchBindings.clientStateController?.daemonRegistrationId);
        if (!registrationId) return null;
        return { daemonId: owner.location.daemonId, daemon: source.daemon, threads: source.threads, project,
          assetOrigin: peer ? daemonSessions?.httpOrigin(owner.location.daemonId) ?? null : null,
          registrationId };
      } catch (error) {
        reportStatusMessage(error instanceof Error ? error.message.slice(0, 512)
          : "Thread context lookup failed.");
        return null;
      }
    },
    launchContextFor,
    draftContextFor: draftId => {
      const location = draftLocationFor(draftId);
      if (!location) return null;
      return launchContextFor(location);
    },
  };
}
