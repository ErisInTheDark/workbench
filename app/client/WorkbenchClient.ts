/*
 * Exports:
 * - areExplorerSnapshotsEquivalent: compare visible explorer facts without thread activity timestamps.
 * - MountedWorkbenchClient: rendering, editor and interaction owners for the mounted workspace.
 * - WorkbenchClient: bind app facts to views and warm source-scoped provider models on observed demand.
 */
import type {
  ExplorerSnapshot, WorkbenchBindings, WorkbenchControls, WorkbenchLogicalThreadRow,
  WorkbenchProjectOption, WorkbenchRouteLoadResult, ThreadPayload, WorkbenchHarness,
  WorkbenchThreadSidebarStore, WorkbenchThreadRuntimeStore,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ThreadReferenceSchema,
  WorkbenchThreadIdSchema, type DaemonId, type DraftId, type ProjectId,
} from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import {
  createHomeRoute, createLogicalThreadRoute, createLogicalExistingThreadRoute,
  createLogicalProjectRoute, getWorkbenchMosaicThreadRootIds,
  getWorkbenchThreadTargetRootId, isSameWorkbenchRoute, withProjectSelection, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import {
  WorkbenchThreadStateMutationResultSchema, WorkbenchThreadTitleMutationResultSchema,
  type WorkbenchThreadStateRequest,
} from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchCreateEntryResultSchema, WorkbenchDeleteFileResultSchema } from "workbench-shared/workbench/project/project-state";
import type { WorkspaceObservation, WorkspaceProjectReference } from "workbench-shared/workbench/workspace/workspace-observation";
import { preferredLogicalLaunchLocation } from "workbench-shared/workbench/project/workbench-project-projection";
import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import frontendJavaScriptGeneration from "workbench-shared/frontend-generation";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type WorkbenchWorkspaceClient from "./workbench/app/WorkbenchWorkspaceClient";
import type WorkbenchAppRpcClient from "./workbench/app/WorkbenchAppRpcClient";
import WorkbenchNetworkClient from "./workbench/app/WorkbenchNetworkClient";
import WorkbenchPresentationClient from "./workbench/state/WorkbenchPresentationClient";
import type WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController";
import type { ClientDraftIdentity } from "./workbench/state/draft-persistence";
import FileDraftStore from "./workbench/state/FileDraftStore";
import LifecycleScope from "./workbench/state/LifecycleScope";
import { DEFAULT_EDITOR_FONT_SIZE } from "./workbench/state/workbench-settings";
import WorkbenchProjectClient from "./workbench/WorkbenchProjectClient";
import WorkbenchThreadClient, { type WorkbenchThreadProject } from "./workbench/WorkbenchThreadClient";
import { WorkbenchModelReadSupersededError } from "./workbench/WorkbenchAccountClient";
import WorkbenchFilePanelClient, { type WorkbenchFilePanelClientOptions } from "./workbench/WorkbenchFilePanelClient";
import WorkbenchNavigationController from "./workbench/WorkbenchNavigationController";
import WorkbenchProjectNavigation from "./workbench/navigation/workbench-project-navigation";
import WorkbenchRouteIntentController from "./workbench/navigation/WorkbenchRouteIntentController";
import WorkbenchDaemonRuntimeClient from "./workbench/WorkbenchDaemonRuntimeClient";
import WorkbenchProjectFileIndexStore from "./workbench/project/WorkbenchProjectFileIndexStore";
import WorkbenchThreadRuntimeStoreController from "./workbench/WorkbenchThreadRuntimeStore";
import ThreadSidebarClient from "./workbench/thread/ThreadSidebarClient";
import type ThreadTextPresentationController from "./workbench/thread/ThreadTextPresentationController";
import WorkbenchVoiceClient from "./workbench/voice/WorkbenchVoiceClient";
import type { WorkbenchDomSurfaces, WorkbenchEditorDomSurfaces } from "./workbench/workbench-dom";

type ThreadClient = ReturnType<typeof WorkbenchThreadClient>;
type QueryHandle<K extends WorkspaceObservation["kind"]> = {
  getSnapshot(): import("./workbench/app/WorkbenchWorkspaceClient").WorkspaceQuerySnapshot<K>;
  release(): void;
};
type ViewContext = {
  daemonId: DaemonId;
  daemon: WorkbenchDaemonClient;
  threads: ThreadClient;
  project: WorkbenchThreadProject;
  assetSource: { kind: "source"; daemonId: DaemonId };
};
type MountedControls = WorkbenchControls & {
  createFilePanelClient(surfaces: WorkbenchEditorDomSurfaces,
    options?: Partial<Omit<WorkbenchFilePanelClientOptions,
      "clearThreadSelection" | "draftStore" | "emitExplorerStateChange" | "expandProjectPath"
      | "fileTransport" | "getProjectChangeSummary" | "getProjectId" | "refreshProject" | "surfaces">>
      & { location?: ProjectLocationReference }): ReturnType<typeof WorkbenchFilePanelClient>;
};

export interface MountedWorkbenchClient {
  networkClient: WorkbenchNetworkClient;
  presentationClient: WorkbenchPresentationClient;
  workspace: WorkbenchWorkspaceClient;
  navigation: WorkbenchNavigationController;
  projectNavigator: WorkbenchProjectNavigation;
  routeIntents: WorkbenchRouteIntentController;
  voice: WorkbenchVoiceClient;
  getThreadController: ThreadClient["getThreadController"];
  threadOwnerFor(threadId: string): {
    daemonId: DaemonId; projectId: ProjectId; hostname: string; rootPath: string; displayPath: string;
  } | null;
  threadDraftIdentityFor(threadId: string): ClientDraftIdentity | null;
  threadContextFor(threadId: string): (ViewContext & { registrationId: string | null }) | null;
  launchContextFor(location: ProjectLocationReference): ViewContext | null;
  draftContextFor(draftId: string): ViewContext | null;
  draftLocationFor(draftId: string): ProjectLocationReference | null;
  projectFileIndexStore: WorkbenchProjectFileIndexStore;
  projectSourceErrors: { getSnapshot(): string; subscribe(listener: () => void): () => void };
  selectBrowseLocation(logicalProjectId: string, location: ProjectLocationReference): Promise<void>;
  controls: MountedControls;
  dispose(): void;
  threadRuntime: WorkbenchThreadRuntimeStore;
  threadSidebar: WorkbenchThreadSidebarStore;
  threadTextPresentation: ThreadTextPresentationController;
  threadTextPresentationFor(threadId: string): ThreadTextPresentationController | null;
}

export function areExplorerSnapshotsEquivalent(left: ExplorerSnapshot | null, right: ExplorerSnapshot) {
  if (!left) return false;
  const visible = (snapshot: ExplorerSnapshot) => ({
    ...snapshot,
    threads: snapshot.threads.map(({ updatedAt: _activity, ...thread }) => thread)
      .sort((a, b) => `${a.harness}/${a.id}`.localeCompare(`${b.harness}/${b.id}`)),
    subagents: snapshot.subagents.map(({ lastActivityAt: _activity, ...thread }) => thread)
      .sort((a, b) => `${a.harness}/${a.threadId}`.localeCompare(`${b.harness}/${b.threadId}`)),
  });
  return areDeeplyEqual(visible(left), visible(right));
}

function sameLocation(left: ProjectLocationReference | null | undefined, right: ProjectLocationReference | null | undefined) {
  return left?.daemonId === right?.daemonId && left?.projectId === right?.projectId;
}

export function WorkbenchClient(bindings: WorkbenchBindings & {
  workspace: WorkbenchWorkspaceClient;
  appRpc?: WorkbenchAppRpcClient | null;
  clientStateController?: WorkbenchClientStateController;
  dom?: WorkbenchDomSurfaces | null;
}): MountedWorkbenchClient {
  const { workspace, clientStateController: state } = bindings;
  const lifetime = new LifecycleScope();
  const presentation = new WorkbenchPresentationClient({ workspace });
  const network = new WorkbenchNetworkClient({ workspace });
  const daemon = workspace.daemon();
  const runtime = new WorkbenchDaemonRuntimeClient({ workspace });
  const voice = new WorkbenchVoiceClient(daemon,
    `/assets/voice-capture.js?v=${frontendJavaScriptGeneration}`, state);
  const initialRoute = bindings.initialRoute ?? createHomeRoute();
  let browseLocation: ProjectLocationReference | null = null;
  let draftLocation: ProjectLocationReference | null = null;
  let draftRoute: WorkbenchRoute | null = null;
  let lastLoadedRoute: WorkbenchRoute | null = null;
  let activePath = "";
  let disposed = false;
  let scheduled = false;
  let lastExplorer: ExplorerSnapshot | null = null;
  let tree: QueryHandle<"projectTree"> | null = null;
  let rows: QueryHandle<"projectThreads"> | null = null;
  let previousRows: QueryHandle<"projectThreads"> | null = null;
  let rowSelection: WorkspaceProjectReference[] | null | undefined;
  const owners = new Map<string, QueryHandle<"threadOwner">>();
  const renderers = new Map<DaemonId, ThreadClient>();
  const warmedOpenCodeSources = new Map<DaemonId, number>();
  const localDraftLocations = new Map<string, ProjectLocationReference>();
  const fileDrafts = new Map<string, ReturnType<typeof FileDraftStore>>();
  const panels = new Set<ReturnType<typeof WorkbenchFilePanelClient>>();
  const factListeners = new Set<() => void>();
  const warn = (message: string, error?: unknown) => console.warn(message,
    error instanceof Error ? error.message.slice(0, 512) : error === undefined ? "" : "Workspace operation failed.");
  const projects = workspace.observe({ kind: "projects" }, factsChanged);
  const groups = workspace.observe({ kind: "projectGroups" }, factsChanged);
  const projectFacts = () => projects.getSnapshot().value?.data;
  const registrationFor = (daemonId: DaemonId) =>
    state?.getSnapshot().registrations.find(item => item.daemonId === daemonId)?.id ?? "";
  const folder = (location: ProjectLocationReference | null | undefined) => {
    if (!location) return undefined;
    const facts = projectFacts();
    return facts?.projects.flatMap(item => item.locations).find(item =>
      sameLocation(item.target, location))?.project
      ?? facts?.projects.flatMap(item => item.observedLocations ?? []).find(item =>
        item.daemonId === location.daemonId && item.projectId === location.projectId)?.project
      ?? facts?.observedProjects.flatMap(item => item.locations).find(item =>
        sameLocation(item.location, location))?.project;
  };
  const locationForThread = (id: string) => {
    const value = owners.get(id)?.getSnapshot().value?.data;
    if (value) return value.phase === "current" ? value.location : null;
    const matches = visibleRows()?.rows.filter(row =>
      row.entry.entryKind !== "draft" && row.entry.identity.threadId === id) ?? [];
    const first = matches[0]?.location;
    return first && matches.every(row => sameLocation(row.location, first)) ? first : null;
  };
  const threadProject = (location: ProjectLocationReference | null | undefined): WorkbenchThreadProject | undefined => {
    const current = folder(location);
    if (current || !location) return current;
    const remembered = projectFacts()?.projects.flatMap(project => project.locations)
      .find(item => sameLocation(item.target, location));
    return remembered ? { id: location.projectId, name: remembered.name,
      rootPath: remembered.rootPath, roots: [] } : undefined;
  };
  const operationScope = () => {
    const location = draftLocation ?? browseLocation;
    return location ? { kind: "folder" as const, location } : undefined;
  };
  let threadClient: ThreadClient;
  const initialThreadClient = createRenderer(null, false);
  threadClient = initialThreadClient;
  const threadRuntime = WorkbenchThreadRuntimeStoreController(threadClient.getSnapshot());
  observeRenderer(initialThreadClient);

  function observeRenderer(client: ThreadClient) {
    lifetime.addUnsubscribe(client.subscribe(snapshot => {
      if (client === threadClient) threadRuntime.accept(snapshot);
      emit();
    }));
  }

  function createRenderer(location: ProjectLocationReference | null, observe = true) {
    const client = WorkbenchThreadClient({
      workspace, clientStateController: state, ...(location ? { location } : {}),
      observeProviderEvents: location !== null,
      getProjectForThread: id => threadProject(locationForThread(id) ?? localDraftLocations.get(id)),
      getProjectById: id => catalogueFor(location?.daemonId).data.find(project => project.id === id),
      resolveThreadIdentity: async request => (await daemon.threads.resolveIdentity(request)).data,
      updateThreadStateWithAcceptance: request => mutateThread(request),
      onStatusMessage: message => warn(message), onThreadStarted: () => emit(),
    });
    const source = location ? projectFacts()?.sources.find(source => source.daemonId === location.daemonId) : null;
    if (source) client.acceptSourceGeneration(source.generation);
    if (observe) observeRenderer(client);
    return client;
  }

  function rendererFor(location: ProjectLocationReference) {
    let client = renderers.get(location.daemonId);
    if (!client) {
      client = createRenderer(location);
      renderers.set(location.daemonId, client);
    }
    return client;
  }

  function warmOpenCode(location: ProjectLocationReference) {
    const source = projectFacts()?.sources.find(item => item.daemonId === location.daemonId);
    if (!source || source.connection !== "current"
      || warmedOpenCodeSources.get(location.daemonId) === source.generation) return;
    warmedOpenCodeSources.set(location.daemonId, source.generation);
    void rendererFor(location).listModels("opencode").catch(error => {
      if (error instanceof WorkbenchModelReadSupersededError) return;
      if (!disposed && projectFacts()?.sources.find(item => item.daemonId === location.daemonId)?.generation === source.generation) {
        warn("Unable to warm OpenCode models.", error);
      }
    });
  }

  function rendererForThread(id: string) {
    const location = locationForThread(id) ?? localDraftLocations.get(id);
    return location ? renderers.get(location.daemonId) ?? threadClient : threadClient;
  }

  function selectRenderer(location: ProjectLocationReference) {
    const next = rendererFor(location);
    if (threadClient === next) return next;
    threadClient = next;
    threadRuntime.accept(next.getSnapshot());
    return next;
  }

  function prepareMosaicRenderers(node: WorkbenchRoute["mosaicNode"]) {
    if (!node) return;
    if (node.type === "split") {
      for (const child of node.children) prepareMosaicRenderers(child);
      return;
    }
    const location = node.target.source?.location;
    if (location && node.target.kind === "thread"
      && (node.target.target.kind === "new" || node.target.target.kind === "draft")) warmOpenCode(location);
    if (location && threadProject(location)) rendererFor(location);
  }
  const projectClient = WorkbenchProjectClient({
    clientStateController: state,
    onError: message => warn(message),
    transport: {
      readCatalog: async () => catalogueFor(browseLocation?.daemonId),
      refresh: async projectId => {
        await workspace.request("project/tree/refresh", { projectId }, requiredFolderScope());
      },
      createEntry: async (projectId, parentPath, name, type) =>
        WorkbenchCreateEntryResultSchema.parse(await workspace.request(
          "project/entry/create", { projectId, parentPath, name, type }, requiredFolderScope())),
      deleteFile: async (projectId, path, options) =>
        WorkbenchDeleteFileResultSchema.parse(await workspace.request(
          "project/file/delete", { projectId, path, ...options }, requiredFolderScope())),
    },
  });
  const projectNavigator = new WorkbenchProjectNavigation(
    projectClient.getSnapshot().projects,
    state?.getProjectAliases() ?? [],
    projectFacts()?.projects ?? [],
    id => locationForThread(id),
  );
  function refreshProjectNavigator() {
    const daemonId = network.snapshot().snapshot?.daemon?.daemonId ?? null;
    projectNavigator.update(
      projectClient.getSnapshot().projects,
      state?.getProjectAliases() ?? [],
      projectFacts()?.projects ?? [],
      daemonId ? {
        daemonId: DaemonIdSchema.parse(daemonId),
        hostname: projectFacts()?.sources.find(item => item.daemonId === daemonId)?.hostname ?? daemonId,
      } : null,
    );
  }
  const sidebar = new ThreadSidebarClient({
    onChange: snapshot => {
      if (browseLocation) rendererFor(browseLocation).installThreadStateSources({ activeProjectSnapshot: snapshot });
      emit();
    },
    remove: async (_projectId, draftId) => presentation.removeDraft(draftId),
    move: async (_source, destination, draftId) => {
      const saved = presentation.draft(draftId);
      const location = browseLocation;
      if (!saved || !location || location.projectId !== destination) {
        throw new Error("Choose a concrete destination folder before moving the draft.");
      }
      const logical = logicalFor(location);
      if (!logical) throw new Error("The destination folder is not registered.");
      await presentation.putDraft({ ...saved, logicalProjectId: logical.id, target: location });
    },
  });
  const navigation = new WorkbenchNavigationController(initialRoute, { load: loadRoute });
  const routeIntents = new WorkbenchRouteIntentController({
    apply: route => navigation.applyRoute(route),
    onError: error => warn("Navigation failed.", error),
  });
  const projectFileIndexStore = new WorkbenchProjectFileIndexStore(async location =>
    workspace.daemon({ kind: "folder", location }).projects.fileIndex({ projectId: location.projectId }));

  function logicalFor(location: ProjectLocationReference) {
    return projectFacts()?.projects.find(project => project.locations.some(item =>
      sameLocation(item.target, location)) || project.observedLocations?.some(item =>
      item.daemonId === location.daemonId && item.projectId === location.projectId));
  }

  function catalogueFor(daemonId?: DaemonId) {
    const candidates = [
      ...(projectFacts()?.projects.flatMap(project => project.locations.flatMap(item =>
        item.daemonId === daemonId && item.project ? [item.project] : [])) ?? []),
      ...(projectFacts()?.observedProjects.flatMap(project => project.locations.flatMap(item =>
        item.location.daemonId === daemonId ? [item.project] : [])) ?? []),
    ];
    return { data: [...new Map(candidates.map(item => [item.id, item])).values()], rootPath: "" };
  }

  function requiredFolderScope() {
    if (!browseLocation) throw new Error("Choose a folder before editing files.");
    return { kind: "folder" as const, location: browseLocation };
  }

  function retainOwners(ids: readonly string[]) {
    const wanted = new Set(ids);
    for (const [id, interest] of owners) if (!wanted.has(id)) {
      interest.release();
      owners.delete(id);
    }
    for (const id of wanted) if (!owners.has(id)) {
      owners.set(id, workspace.observe({ kind: "threadOwner", threadId: ThreadReferenceSchema.parse(id) }, () => {
        const location = locationForThread(id);
        if (location) rendererFor(location);
        factsChanged();
      }));
    }
  }

  function selectRows(selection: WorkspaceProjectReference[] | null) {
    if (rowSelection !== undefined && areDeeplyEqual(rowSelection, selection)) return;
    const next = workspace.observe({ kind: "projectThreads", projects: selection }, factsChanged);
    const retained = usableRows(rows) ? rows : previousRows;
    if (rows && rows !== retained) rows.release();
    if (previousRows && previousRows !== retained) previousRows.release();
    rowSelection = selection;
    rows = next;
    previousRows = retained;
    retirePreviousRows();
  }

  function retirePreviousRows() {
    if (!previousRows || !rows) return;
    const current = rows.getSnapshot();
    if (!usableRows(rows) && current.phase !== "failed" && current.phase !== "unavailable") return;
    previousRows.release();
    previousRows = null;
  }

  function usableRows(handle: QueryHandle<"projectThreads"> | null) {
    const snapshot = handle?.getSnapshot();
    return snapshot?.phase === "current" || snapshot?.phase === "stale"
      ? snapshot.value?.data ?? null : null;
  }

  function visibleRows() {
    return usableRows(rows) ?? previousRows?.getSnapshot().value?.data
      ?? rows?.getSnapshot().value?.data ?? null;
  }

  function selectRowsForRoute(route: WorkbenchRoute) {
    if (groups.getSnapshot().phase === "failed") {
      selectRows(null);
      return;
    }
    const selectedLogicalIds = [...new Set([
      ...(route.logical ? route.selectedProjectIds ?? [] : []),
      route.logical?.threadOwnerProjectId,
    ].filter((id): id is NonNullable<typeof id> => Boolean(id)))];
    const root = route.view === "thread" && route.threadTarget
      && (route.threadTarget.kind === "provider" || route.threadTarget.kind === "subagent")
      ? getWorkbenchThreadTargetRootId(route.threadTarget) : null;
    const ownerFact = root ? owners.get(root)?.getSnapshot().value?.data : null;
    const selectedRows: WorkspaceProjectReference[] = selectedLogicalIds.map(projectId => ({
      kind: "logical", projectId: LogicalProjectIdSchema.parse(projectId),
    }));
    if (selectedRows.length && ownerFact?.phase === "current") {
      if (ownerFact.logicalProjectId && !selectedLogicalIds.includes(ownerFact.logicalProjectId)) {
        selectedRows.push({ kind: "logical", projectId: ownerFact.logicalProjectId });
      } else if (!ownerFact.logicalProjectId) {
        selectedRows.push({ kind: "location", location: ownerFact.location });
      }
    }
    const explicit = projectNavigator.folderForRoute(route) ?? route.logical?.browseLocation ?? route.logical?.location;
    selectRows(selectedRows.length ? selectedRows : explicit ? [{ kind: "location", location: explicit }] : null);
  }

  function selectFolder(location: ProjectLocationReference | null) {
    if (sameLocation(browseLocation, location)) return;
    tree?.release();
    tree = null;
    projectClient.enterNoProject();
    browseLocation = location;
    if (!location) { emit(); return; }
    rendererFor(location);
    projectClient.bindDaemonRegistration(registrationFor(location.daemonId));
    void projectClient.installCatalog(catalogueFor(location.daemonId)).catch(error => warn("Project facts could not be displayed.", error));
    projectClient.beginProjectSelection(location.projectId);
    let treeGeneration = "";
    tree = workspace.observe({ kind: "projectTree", location }, () => {
      const fact = tree?.getSnapshot();
      if (fact?.value?.data) {
        const generation = `${fact.value.generation}/${fact.value.sourceGeneration}`;
        if (treeGeneration !== generation) {
          treeGeneration = generation;
          projectClient.resetObservation();
        }
        projectClient.accept(fact.value.data);
      }
      factsChanged();
    });
    const snapshot = tree.getSnapshot();
    if (snapshot.value?.data) projectClient.accept(snapshot.value.data);
    emit();
  }

  function factsChanged() {
    if (disposed) return;
    retirePreviousRows();
    refreshProjectNavigator();
    const sources = projectFacts()?.sources ?? [];
    const present = new Set(sources.map(source => source.daemonId));
    for (const daemonId of warmedOpenCodeSources.keys()) if (!present.has(daemonId)) warmedOpenCodeSources.delete(daemonId);
    for (const source of sources) renderers.get(source.daemonId)?.acceptSourceGeneration(source.generation);
    if (browseLocation) {
      void projectClient.installCatalog(catalogueFor(browseLocation.daemonId))
        .catch(error => warn("Project facts could not be displayed.", error));
    }
    const route = navigation.getSnapshot().route;
    selectRowsForRoute(route);
    if (route.view === "thread" && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft")) {
      const target = route.threadTarget;
      const location = draftLocation ?? route.logical?.browseLocation ?? route.logical?.location
        ?? (target.kind === "draft" ? presentation.draft(target.draftId)?.target ?? localDraftLocations.get(target.draftId) : null);
      if (location) warmOpenCode(location);
    }
    const observedRows = visibleRows();
    sidebar.acceptFacts(browseLocation, observedRows);
    for (const row of observedRows?.rows ?? []) {
      if (row.entry.entryKind === "thread" && row.entry.identity.harness === "opencode"
        && !row.entry.lifecycle.settled) warmOpenCode(row.location);
    }
    prepareMosaicRenderers(route.mosaicNode);
    routeIntents.factsChanged();
    for (const listener of factListeners) listener();
    emit();
  }

  function fileDraftStoreFor(location: ProjectLocationReference) {
    const registrationId = registrationFor(location.daemonId);
    const key = `${location.daemonId}/${location.projectId}`;
    let store = fileDrafts.get(key);
    if (!store) {
      store = FileDraftStore(() => location.projectId, emit, state,
        message => warn(message), () => registrationFor(location.daemonId) || registrationId);
      fileDrafts.set(key, store);
      void store.hydratePersistedDrafts().catch(error => warn("File drafts could not load.", error));
    }
    return store;
  }

  function emit() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const project = projectClient.getSnapshot();
      const threads = threadClient.getSnapshot();
      const facts = projectFacts();
      const fontSize = state?.records("globalPreference").find(item => item.preference.key === "editorFontSize");
      const rowData = visibleRows();
      const logicalRows = rowData?.rows.filter(
        (item): item is WorkbenchLogicalThreadRow => item.logicalProjectId !== null) ?? [];
      const snapshot: ExplorerSnapshot = {
        ...project, browseLocation, currentPath: activePath,
        workspaceProjects: facts, workspaceThreads: rowData ?? undefined,
        workspaceProjectGroups: groups.getSnapshot().value?.data,
        workspaceProjectGroupsPhase: groups.getSnapshot().phase,
        logicalProjects: facts?.projects ?? [], logicalSummaries: facts?.summaries ?? {},
        logicalThreads: logicalRows,
        subagents: threads.subagents, threads: threads.threads,
        isProjectLoading: !!browseLocation && (!tree?.getSnapshot().value?.data || project.isLoading),
        isThreadsLoading: !!rows && !rows.getSnapshot().value,
        threadsError: rows?.getSnapshot().failure ?? threads.threadsError,
        currentThreadId: threads.currentThreadId,
        locallyModifiedPaths: browseLocation ? fileDraftStoreFor(browseLocation).getLocallyModifiedPaths() : [],
        fontSize: fontSize?.preference.key === "editorFontSize" ? fontSize.preference.value : DEFAULT_EDITOR_FONT_SIZE,
      };
      if (areExplorerSnapshotsEquivalent(lastExplorer, snapshot)) return;
      lastExplorer = snapshot;
      bindings.onExplorerStateChange?.(snapshot);
    });
  }

  function createDraft(location: ProjectLocationReference, harness: WorkbenchHarness,
    options: { select?: boolean; threadId?: DraftId } = {}) {
    const project = threadProject(location);
    if (!project) throw new Error("The draft folder's metadata is not available yet.");
    const renderer = options.select === false ? rendererFor(location) : selectRenderer(location);
    const draft = renderer.createThread(harness, options.threadId, { ...options, project });
    localDraftLocations.set(draft.id, location);
    if (options.select !== false) draftLocation = location;
    emit();
    return draft;
  }

  async function loadRoute(route: WorkbenchRoute,
    context: { isCurrent(): boolean; signal: AbortSignal }): Promise<WorkbenchRouteLoadResult> {
    if (route.view === "invalid") return { ok: false, error: route.error };
    // A folder-scope change re-scopes the sidebar without reloading the open view.
    if (lastLoadedRoute && isSameWorkbenchRoute(
      { ...lastLoadedRoute, folderAddress: undefined }, { ...route, folderAddress: undefined })) {
      selectFolder(projectNavigator.folderForRoute(route) ?? route.logical?.browseLocation ?? route.logical?.location ?? null);
      return { ok: true };
    }
    const result = await loadView(route, context);
    if (result.ok) lastLoadedRoute = route;
    return result;
  }

  async function loadView(route: WorkbenchRoute,
    context: { isCurrent(): boolean; signal: AbortSignal }): Promise<WorkbenchRouteLoadResult> {
    const target = route.threadTarget;
    if (route.view !== "thread" || target?.kind !== "new" && target?.kind !== "draft") draftRoute = null;
    const root = target && (target.kind === "provider" || target.kind === "subagent")
      ? getWorkbenchThreadTargetRootId(target) : null;
    retainOwners(route.mosaicNode ? [...getWorkbenchMosaicThreadRootIds(route.mosaicNode)] : root ? [root] : []);
    const logicalId = route.logical?.projectId;
    const explicit = route.logical?.browseLocation ?? route.logical?.location;
    // The url folder owns the browse scope; the draft channel keeps its own folder intent.
    const browseFolder = projectNavigator.folderForRoute(route) ?? null;
    selectRowsForRoute(route);
    if (route.view === "home" || route.view === "project" && route.selectedProjectIds?.length !== 1
      || route.view === "settings" && route.settingsScope === "global"
      || route.view === "stats") {
      selectFolder(browseFolder);
      draftLocation = null;
      activePath = "";
      threadClient.clearThreadSelection();
      return { ok: true };
    }
    const facts = projectFacts();
    if (!facts) return { ok: false, pending: true };
    const logical = facts.projects.find(item => item.id === (logicalId ?? route.logical?.threadOwnerProjectId));
    const saved = target?.kind === "draft" ? presentation.draft(target.draftId) : null;
    const draftRouteTarget = route.view === "thread" && (target?.kind === "new" || target?.kind === "draft");
    const browseTarget = explicit ?? (logical?.locations.length === 1 ? logical.locations[0]!.target : null);
    let location = draftRouteTarget
      ? explicit ?? saved?.target ?? (logical && presentation.snapshot().data
        ? preferredLogicalLaunchLocation(logical, presentation.snapshot().data!) : null)
      : browseTarget;
    if (!location && draftRouteTarget && logical) location = logical.locations.find(item => item.project)?.target
      ?? logical.locations[0]?.target ?? null;
    // Historical physical routes are resolved from app facts, never guessed across sources.
    if (!location && route.projectId) {
      const candidates = facts.projects.flatMap(item => item.locations).filter(item => item.target.projectId === route.projectId);
      if (candidates.length === 1) location = candidates[0]!.target;
      else if (candidates.length > 1) return { ok: false, error: "This old project address names more than one daemon folder." };
    }
    if (draftRouteTarget && location) warmOpenCode(location);
    if (route.view === "mosaic") {
      // Each pane consumes its own owner and transcript facts. A slow pane cannot block its siblings.
      selectFolder(browseFolder ?? location);
      prepareMosaicRenderers(route.mosaicNode);
      return { ok: true };
    }
    if (root && target && (target.kind === "provider" || target.kind === "subagent")) {
      const owner = owners.get(root)?.getSnapshot();
      const data = owner?.value?.data;
      if (!data || data.phase === "pending") return { ok: false, pending: true };
      if (data.phase !== "current") return { ok: false, error: data.failure ?? "The thread owner is unavailable." };
      if (route.logical?.threadOwnerProjectId && data.logicalProjectId !== route.logical.threadOwnerProjectId) {
        return { ok: false, error: "The thread does not belong to the linked project." };
      }
      if (route.logical?.legacyOwnerLocation && !sameLocation(route.logical.legacyOwnerLocation, data.location)) {
        return { ok: false, error: "The legacy thread address does not match its owner." };
      }
      const project = threadProject(data.location);
      if (!project) return { ok: false, pending: true };
      selectFolder(browseFolder ?? (route.logical ? browseTarget : location ?? data.location));
      selectRenderer(data.location);
      draftLocation = null;
      const outcome = await threadClient.openThread(data.identity.threadId, {
        harness: data.identity.harness, project, isCurrent: context.isCurrent,
      });
      if (!context.isCurrent() || outcome.kind === "superseded") return { ok: false };
      if (outcome.kind === "failure") return { ok: false, error: outcome.failure.message };
      activePath = "";
      const canonical = {
        ...withProjectSelection(createLogicalExistingThreadRoute(logicalId ?? null,
          target?.kind === "provider" ? { ...target, harness: data.identity.harness } : target!, null),
          route.selectedProjectIds),
        folderAddress: route.folderAddress,
      };
      emit();
      return { ok: true, ...(isSameWorkbenchRoute(route, canonical) ? {} : { canonicalRoute: canonical }) };
    }
    if (!location && logical && route.view === "project") {
      selectFolder(browseFolder);
      activePath = "";
      threadClient.clearThreadSelection();
      return { ok: true };
    }
    if (!location || !(draftRouteTarget ? threadProject(location) : folder(location))) {
      const pending = facts.catalogues.some(item => item.phase === "pending" || item.phase === "stale");
      return pending ? { ok: false, pending: true }
        : { ok: false, error: "No folder metadata is available for this project." };
    }
    if (logical && !logical.locations.some(item => sameLocation(item.target, location))
      && !logical.observedLocations?.some(item => item.daemonId === location!.daemonId && item.projectId === location!.projectId)) {
      return { ok: false, error: "The chosen folder does not belong to this project." };
    }
    selectFolder(browseFolder ?? (draftRouteTarget ? browseTarget : location));
    activePath = route.view === "file" ? route.filePath : "";
    if (route.view === "thread" && target && (target.kind === "new" || target.kind === "draft")) {
      if (target.kind === "draft" && !saved) {
        return presentation.snapshot().data ? { ok: false, error: "The saved draft is unavailable." }
          : { ok: false, pending: true };
      }
      if (saved && explicit && !sameLocation(saved.target, explicit)) {
        return { ok: false, error: "The draft address does not match its saved folder." };
      }
      const current = threadClient.getSnapshot().currentThread;
      const sameDraft = current?.isDraft && sameLocation(localDraftLocations.get(current.id), location)
        && (target.kind === "draft" ? current.id === target.draftId : draftRoute?.threadTarget?.kind === "new");
      const draft = sameDraft ? current : createDraft(location,
        saved?.selection.settings.harness ?? defaultProviderKey,
        { threadId: target.kind === "draft" ? target.draftId : undefined });
      if (saved) threadClient.setCurrentThreadComposerSettings(draft.id, saved.selection.settings);
      draftLocation = location;
      draftRoute = route;
      const registered = logicalFor(location);
      if (registered) {
        const viewedProjectId = route.logical?.threadOwnerProjectId ? route.logical.projectId : logicalId ?? registered.id;
        const canonical = withProjectSelection(createLogicalThreadRoute(viewedProjectId, registered.id,
          saved ? null : browseTarget, saved ? { kind: "draft", draftId: DraftIdSchema.parse(saved.id) } : target),
          route.selectedProjectIds);
        return { ok: true, ...(isSameWorkbenchRoute(route, canonical) ? {} : { canonicalRoute: canonical }) };
      }
      return { ok: true };
    }
    draftLocation = null;
    threadClient.clearThreadSelection();
    emit();
    if (route.view === "project" && !logicalId) {
      const registered = logicalFor(location);
      if (registered) return { ok: true, canonicalRoute: createLogicalProjectRoute(registered.id, location) };
    }
    return { ok: true };
  }

  async function mutateThread(request: WorkbenchThreadStateRequest) {
    const response = await workspace.request(request.method, request);
    const parsed = WorkbenchThreadStateMutationResultSchema.safeParse(response);
    if (!parsed.success) {
      reportClientSchemaError("Rejected workspace thread mutation", parsed.error);
      throw new Error("The app returned invalid thread mutation data.");
    }
    return parsed.data.accepted;
  }

  async function threadAction(threadId: Parameters<WorkbenchControls["threadAction"]>[0],
    intent: Parameters<WorkbenchControls["threadAction"]>[1]) {
    const result = WorkbenchThreadStateMutationResultSchema.safeParse(await workspace.rpc.requestRaw({
      method: "workspace/thread/action", params: { threadId, intent },
    }));
    if (!result.success) {
      reportClientSchemaError("Rejected workspace thread action", result.error);
      throw new Error("The app returned invalid action data.");
    }
    return result.data.accepted;
  }

  const controls: MountedControls = {
    daemon,
    applyRoute: route => navigation.applyRoute(route),
    daemonRuntime: runtime,
    refreshProjectCatalog: async () => { await workspace.daemon(operationScope()).projects.catalog(); },
    createThreadDraft: (harness, options) => {
      const location = draftLocation ?? browseLocation;
      if (!location) throw new Error("Choose a draft folder.");
      return createDraft(location, harness, options);
    },
    createThreadDraftAt: createDraft,
    getSelectedThreadDraft: () => navigation.readPinnedDraft((projectId, draftId) =>
      sidebar.getDraft(ProjectIdSchema.parse(projectId), DraftIdSchema.parse(draftId))),
    readThread: (id, ...args) => rendererForThread(id).readThread(id, ...args),
    sendThreadMessage: async (thread, input, options = {}) => {
      if (!thread.isDraft) return rendererForThread(thread.id).sendThreadMessage(thread, input, options);
      const saved = presentation.draft(thread.id);
      if (!saved) throw new Error("Save this draft before starting it.");
      const route = navigation.getSnapshot().route;
      const launched = await workspace.launchDraft(saved.id, saved.revision, options);
      // The applied identity comes from the launch: a saved snapshot can predate the linked profile's provider.
      const harness = launched.harness ?? saved.selection.settings.harness;
      try {
        options.onThreadLaunched?.({ id: WorkbenchThreadIdSchema.parse(launched.threadId), harness });
      } catch (error) {
        warn("The thread started, but its view could not be selected.", error);
      }
      if (!options.onThreadLaunched && options.selectThread !== false && navigation.getSnapshot().route === route) {
        routeIntents.request(withProjectSelection(createLogicalExistingThreadRoute(route.logical?.projectId ?? null,
          { kind: "provider", threadId: ThreadReferenceSchema.parse(launched.threadId), harness },
          route.logical?.browseLocation ?? null), route.selectedProjectIds));
      }
      return null;
    },
    compactThread: thread => rendererForThread(thread.id).compactThread(thread),
    stopThread: thread => rendererForThread(thread.id).stopThread(thread),
    threadAction,
    setThreadTitle: async request => {
      const { data: owner } = await daemon.threads.resolveIdentity({ threadId: ThreadReferenceSchema.parse(request.threadId) });
      if (!owner) throw new Error("The thread owner is unavailable.");
      const response = await workspace.request("workbench/thread-state/title/set", {
        identity: { harness: request.harness, threadId: request.threadId },
        projectId: owner.projectId, title: request.title,
      });
      const parsed = WorkbenchThreadTitleMutationResultSchema.safeParse(response);
      if (!parsed.success) {
        reportClientSchemaError("Rejected workspace thread title", parsed.error);
        throw new Error("Invalid thread title response.");
      }
      rendererForThread(request.threadId).applyAcceptedThreadTitle(parsed.data.identity.threadId, parsed.data.identity.harness, parsed.data.title);
      return parsed.data.title;
    },
    threadGoals: {
      clear: id => rendererForThread(id).threadGoals.clear(id),
      getSnapshot: id => rendererForThread(id).threadGoals.getSnapshot(id),
      load: id => rendererForThread(id).threadGoals.load(id),
      refresh: id => rendererForThread(id).threadGoals.refresh(id),
      subscribe: (id, listener) => rendererForThread(id).threadGoals.subscribe(id, listener),
      updateObjective: (id, objective) => rendererForThread(id).threadGoals.updateObjective(id, objective),
    },
    submitPendingUserInputRequest: (id, ...args) => rendererForThread(id).submitPendingUserInputRequest(id, ...args),
    listModels: (...args) => threadClient.listModels(...args),
    refreshRateLimits: () => threadClient.refreshRateLimits(),
    setEditorFontSize: () => {},
    setCurrentThreadModel: (id, model) => rendererForThread(id).setCurrentThreadModel(id, model),
    setCurrentThreadAgent: (id, agent) => rendererForThread(id).setCurrentThreadAgent(id, agent),
    setCurrentThreadComposerSettings: (id, settings) => rendererForThread(id).setCurrentThreadComposerSettings(id, settings),
    setCurrentThreadReasoningEffort: (id, effort) => rendererForThread(id).setCurrentThreadReasoningEffort(id, effort),
    setCurrentThreadServiceTier: (id, tier) => rendererForThread(id).setCurrentThreadServiceTier(id, tier),
    setDraftThreadHarness: harness => threadClient.setDraftThreadHarness(harness),
    setDraftThreadHarnessAt: (location, harness) => rendererFor(location).setDraftThreadHarness(harness),
    toggleDirectory: path => { projectClient.toggleDirectory(path); },
    updateThreadState: async request => { await mutateThread(request); },
    updateThreadStateWithAcceptance: mutateThread,
    createEntry: (...args) => projectClient.createEntry(...args),
    deleteFile: async (path, options) => {
      const location = browseLocation;
      const result = await projectClient.deleteFile(path, options);
      if (!result.confirmationRequired && location) {
        try { await fileDraftStoreFor(location).clearBuffer(path); }
        catch (error) { warn("File deleted, but its editor draft could not be removed.", error); }
        if (activePath === path) activePath = "";
        emit();
      }
      return result;
    },
    deleteThreadDraft: (id, projectId) => sidebar.delete(id, Date.now(), projectId),
    moveThreadDraft: (source, destination, id) => sidebar.moveDraft(source, destination, id),
    deletePresentationDraft: id => presentation.removeDraft(id),
    retargetPresentationDraft: async (id, target, logicalProjectId) => {
      const draft = presentation.draft(id);
      if (!draft || draft.phase !== "unsent") throw new Error("The unsent draft is unavailable.");
      // Saving a known destination does not require a live daemon. Launch validates capabilities.
      await presentation.putDraft({ ...draft, target,
        logicalProjectId: logicalProjectId ?? draft.logicalProjectId, updatedAt: Date.now() });
    },
    setPresentationDraftPriority: (...args) => presentation.setDraftPriority(...args),
    savePresentationProjectLayout: (...args) => presentation.saveProjectLayout(...args),
    savePresentationHomeLayout: (...args) => presentation.saveHomeLayout(...args),
    savePresentationHomeAndProjectLayouts: (...args) => presentation.saveHomeAndProjectLayouts(...args),
    updatePresentationProjectLayout: (...args) => presentation.updateProjectLayout(...args),
    updatePresentationHomeLayout: intent => presentation.updateHomeLayout(intent),
    updatePresentationPinnedLayout: (...args) => presentation.updatePinnedLayout(...args),
    createFilePanelClient: (surfaces, options = {}) => {
      const { location = browseLocation, ...panelOptions } = options;
      if (!location) throw new Error("Choose a folder before opening an editor.");
      const operations = workspace.daemon({ kind: "folder", location });
      const panelLifetime = new LifecycleScope();
      const client = WorkbenchFilePanelClient({
        ...panelOptions, surfaces, draftStore: fileDraftStoreFor(location),
        clearThreadSelection: () => { threadClient.clearThreadSelection(); },
        emitExplorerStateChange: emit,
        expandProjectPath: path => {
          if (sameLocation(location, browseLocation)) projectClient.expandPath(path);
        },
        getProjectChangeSummary: path => sameLocation(location, browseLocation)
          ? projectClient.getSnapshot().changes[path] ?? null : null,
        getProjectId: () => location.projectId,
        refreshProject: async () => {
          await workspace.request("project/tree/refresh", { projectId: location.projectId }, { kind: "folder", location });
        },
        fileTransport: {
          read: (projectId, path) => operations.projects.files.read({ projectId, path }),
          reset: (projectId, path, expectedMtimeMs, force) => operations.projects.files.reset({ projectId, path, expectedMtimeMs, force }),
          save: (projectId, path, content, expectedMtimeMs, force) => operations.projects.files.save({ projectId, path, content, expectedMtimeMs, force }),
        },
      }, panelLifetime);
      panels.add(client);
      panelLifetime.addUnsubscribe(() => panels.delete(client));
      return client;
    },
  };

  const draftLocationFor = (id: string) => presentation.draft(id)?.target ?? localDraftLocations.get(id) ?? null;
  const launchContextFor = (location: ProjectLocationReference): ViewContext | null => {
    const project = threadProject(location);
    const renderer = renderers.get(location.daemonId);
    return project && renderer ? { daemonId: location.daemonId, daemon: workspace.daemon({ kind: "folder", location }),
      project, threads: renderer,
      assetSource: { kind: "source", daemonId: location.daemonId } } : null;
  };
  const threadOwnerFor: MountedWorkbenchClient["threadOwnerFor"] = id => {
    const location = locationForThread(id);
    if (!location) return null;
    const project = folder(location);
    const hostname = projectFacts()?.sources.find(item => item.daemonId === location.daemonId)?.hostname ?? location.daemonId;
    const displayPath = projectFacts()?.projects.flatMap(item => item.locations)
      .find(item => sameLocation(item.target, location))?.displayPath ?? project?.name ?? location.projectId;
    return { ...location, hostname, rootPath: project?.rootPath ?? "",
      displayPath };
  };
  lifetime.addUnsubscribe(projectClient.subscribe(() => {
    refreshProjectNavigator();
    emit();
  }));
  lifetime.addUnsubscribe(presentation.subscribe(factsChanged));
  if (state) lifetime.addUnsubscribe(state.subscribe(factsChanged));
  presentation.start();
  void network.start().catch(error => warn("Network settings could not start.", error));
  void runtime.open().catch(error => warn("Runtime observation could not start.", error));
  threadClient.activateThreadControllers();
  emit();

  return {
    workspace, networkClient: network, presentationClient: presentation,
    navigation, projectNavigator, routeIntents, controls, voice, projectFileIndexStore,
    projectSourceErrors: {
      getSnapshot: () => [projects.getSnapshot().failure,
        ...(projectFacts()?.catalogues.map(item => item.failure) ?? []),
        rows?.getSnapshot().failure, tree?.getSnapshot().failure].filter(Boolean).join(" "),
      subscribe: listener => { factListeners.add(listener); return () => { factListeners.delete(listener); }; },
    },
    threadRuntime, threadSidebar: sidebar,
    get threadTextPresentation() { return threadClient.textPresentation; },
    threadTextPresentationFor: id => rendererForThread(id).textPresentation,
    getThreadController: (projectId, target) => {
      const id = target.kind === "draft" ? target.draftId
        : target.kind === "subagent" ? target.parentThreadId : target.threadId;
      const location = locationForThread(id) ?? localDraftLocations.get(id);
      return rendererForThread(id).getThreadController(location?.projectId ?? projectId, target);
    },
    threadOwnerFor,
    threadDraftIdentityFor: id => {
      const owner = threadOwnerFor(id);
      const registration = owner && registrationFor(owner.daemonId);
      return owner && registration ? { daemonRegistrationId: registration,
        projectId: ProjectIdSchema.parse(owner.projectId), threadId: ThreadReferenceSchema.parse(id) } : null;
    },
    threadContextFor: id => {
      const owner = threadOwnerFor(id);
      if (!owner) return null;
      const context = launchContextFor({ daemonId: owner.daemonId, projectId: ProjectIdSchema.parse(owner.projectId) });
      return context ? { ...context, daemon: workspace.daemon({ kind: "thread", threadId: id }),
        registrationId: registrationFor(owner.daemonId) || null } : null;
    },
    launchContextFor, draftLocationFor,
    draftContextFor: id => { const location = draftLocationFor(id); return location ? launchContextFor(location) : null; },
    selectBrowseLocation: async (logicalProjectId, location) => {
      if (logicalFor(location)?.id !== logicalProjectId) throw new Error("The folder does not belong to this project.");
      selectFolder(location);
    },
    dispose: () => {
      disposed = true;
      projects.release();
      groups.release();
      rows?.release();
      previousRows?.release();
      tree?.release();
      for (const owner of owners.values()) owner.release();
      for (const panel of panels) panel.dispose();
      navigation.dispose();
      routeIntents.dispose();
      void sidebar.dispose().then(() => presentation.dispose());
      network.close();
      runtime.dispose();
      voice.dispose();
      projectFileIndexStore.dispose();
      projectClient.dispose();
      for (const renderer of new Set([initialThreadClient, ...renderers.values()])) renderer.dispose();
      renderers.clear();
      lifetime.dispose();
      factListeners.clear();
    },
  };
}
