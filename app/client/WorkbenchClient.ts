/*
 * Exports:
 * - areExplorerSnapshotsEquivalent: compare explorer snapshots structurally.
 * - WorkbenchLocationOwner: a thread or draft's daemon folder plus its host and path labels.
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
  WorkbenchThreadIdSchema, type DaemonId, type DraftId, type LogicalProjectId,
} from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import {
  createHomeRoute, createLogicalThreadRoute, createLogicalExistingThreadRoute,
  createLogicalProjectRoute, createLogicalMosaicRoute, createMosaicRoute, getWorkbenchMosaicThreadRootIds,
  createThreadRoute, getWorkbenchThreadTargetRootId, isSameWorkbenchRoute, isWorkbenchRouteOwnerOfThread,
  withProjectSelection, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import {
  WorkbenchThreadStateMutationResultSchema, WorkbenchThreadTitleMutationResultSchema,
  type WorkbenchThreadStateRequest,
} from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchDeleteFileResultSchema } from "workbench-shared/workbench/project/project-state";
import { isMarkdownFile } from "workbench-shared/workbench/project/tree-utils";
import type {
  WorkspaceProjectReference, WorkspaceQuery, WorkspaceThreadMember, WorkspaceThreadPlacement,
} from "workbench-shared/workbench/workspace/workspace-observation";
import { WorkspaceThreadActionResultSchema } from "workbench-shared/workbench/workspace/workspace-commands";
import {
  materializeWorkspaceThreadRow, preferredLogicalLaunchLocation, preferredSelectedLaunchTarget,
  projectPresentationDraftRow, type WorkbenchProjectedThreadRow,
} from "workbench-shared/workbench/project/workbench-project-projection";
import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import frontendJavaScriptGeneration from "workbench-shared/frontend-generation";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type WorkbenchWorkspaceClient from "./workbench/app/WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle } from "./workbench/app/WorkbenchWorkspaceClient";
import type WorkbenchAppRpcClient from "./workbench/app/WorkbenchAppRpcClient";
import WorkbenchNetworkClient from "./workbench/app/WorkbenchNetworkClient";
import WorkbenchPresentationClient from "./workbench/state/WorkbenchPresentationClient";
import type WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController";
import type { ClientDraftIdentity } from "./workbench/state/draft-persistence";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import WorkbenchFileStore from "./workbench/file/WorkbenchFileStore";
import type { TextFileDocumentPort } from "./workbench/file/TextFileDocumentController";
import LifecycleScope from "./workbench/state/LifecycleScope";
import { DEFAULT_EDITOR_FONT_SIZE } from "./workbench/state/workbench-settings";
import WorkbenchProjectClient from "./workbench/WorkbenchProjectClient";
import WorkbenchThreadClient, { type WorkbenchThreadProject } from "./workbench/WorkbenchThreadClient";
import { WorkbenchModelReadSupersededError } from "./workbench/WorkbenchAccountClient";
import WorkbenchNavigationController from "./workbench/WorkbenchNavigationController";
import WorkbenchProjectNavigation from "./workbench/navigation/workbench-project-navigation";
import WorkbenchRouteIntentController from "./workbench/navigation/WorkbenchRouteIntentController";
import WorkbenchDaemonRuntimeClient from "./workbench/WorkbenchDaemonRuntimeClient";
import WorkbenchProjectFileIndexStore from "./workbench/project/WorkbenchProjectFileIndexStore";
import ProjectFactsStore from "./workbench/project/ProjectFactsStore";
import WorkbenchThreadRuntimeStoreController from "./workbench/WorkbenchThreadRuntimeStore";
import ThreadSidebarClient from "./workbench/thread/ThreadSidebarClient";
import ThreadSummaryStore from "./workbench/thread/ThreadSummaryStore";
import type ThreadTextPresentationController from "./workbench/thread/ThreadTextPresentationController";
import WorkbenchVoiceClient from "./workbench/voice/WorkbenchVoiceClient";

type ThreadClient = ReturnType<typeof WorkbenchThreadClient>;
type QueryHandle<K extends WorkspaceQuery["kind"]> = WorkspaceQueryHandle<K>;
type ViewContext = {
  daemonId: DaemonId;
  daemon: WorkbenchDaemonClient;
  threads: ThreadClient;
  project: WorkbenchThreadProject;
  assetSource: { kind: "source"; daemonId: DaemonId };
};
/** Where a thread or draft runs: its daemon folder with the host and path labels views show for it. */
export type WorkbenchLocationOwner = ProjectLocationReference & { hostname: string; rootPath: string; displayPath: string };
type MountedControls = WorkbenchControls & {
  createTextFileDocumentPort(path: string, location?: ProjectLocationReference | null): TextFileDocumentPort;
  /** Create a new file holding `content`; rejects when the path already exists. */
  createTextFile(path: string, content: string, location?: ProjectLocationReference | null): Promise<void>;
  /** Start an unsaved new file at `path` in the browsed folder; nothing is written until it is saved under a name. */
  createFileDraft(path: string, content: string): void;
  /** Drop the browsed folder's draft at `path`, such as an unsaved new file. */
  discardFileDraft(path: string): Promise<void>;
};

export interface MountedWorkbenchClient {
  files: WorkbenchFileStore;
  networkClient: WorkbenchNetworkClient;
  presentationClient: WorkbenchPresentationClient;
  workspace: WorkbenchWorkspaceClient;
  navigation: WorkbenchNavigationController;
  projectNavigator: WorkbenchProjectNavigation;
  routeIntents: WorkbenchRouteIntentController;
  voice: WorkbenchVoiceClient;
  getThreadStore: ThreadClient["getThreadStore"];
  threadOwnerFor(threadId: string): WorkbenchLocationOwner | null;
  locationOwnerFor(location: ProjectLocationReference): WorkbenchLocationOwner;
  threadDraftIdentityFor(threadId: string): ClientDraftIdentity | null;
  threadContextFor(threadId: string): (ViewContext & { registrationId: string | null }) | null;
  launchContextFor(location: ProjectLocationReference): ViewContext | null;
  draftContextFor(draftId: string): ViewContext | null;
  draftLocationFor(draftId: string): ProjectLocationReference | null;
  projectFileIndexStore: WorkbenchProjectFileIndexStore;
  projectFacts: ProjectFactsStore;
  projectSourceErrors: { getSnapshot(): string; subscribe(listener: () => void): () => void };
  /** Hear any fact or view change, batched once per task; readers re-derive what they need and compare. */
  subscribeChanges(listener: () => void): () => void;
  selectBrowseLocation(logicalProjectId: string, location: ProjectLocationReference): Promise<void>;
  /** Re-read one daemon's project catalogue, then the app presentation that maps its folders to logical projects. */
  refreshInstallationProjects(daemonId: DaemonId): Promise<PresentationSnapshot>;
  controls: MountedControls;
  dispose(): void;
  threadRuntime: WorkbenchThreadRuntimeStore;
  threadSidebar: WorkbenchThreadSidebarStore;
  /** Per-thread summaries every thread display leases, batched into one workspace observation; absent where nothing observes them. */
  threadSummaries?: ThreadSummaryStore;
  threadTextPresentation: ThreadTextPresentationController;
  threadTextPresentationFor(threadId: string): ThreadTextPresentationController | null;
}

export function areExplorerSnapshotsEquivalent(left: ExplorerSnapshot | null, right: ExplorerSnapshot) {
  return left !== null && areDeeplyEqual(left, right);
}

function sameLocation(left: ProjectLocationReference | null | undefined, right: ProjectLocationReference | null | undefined) {
  return left?.daemonId === right?.daemonId && left?.projectId === right?.projectId;
}

export function WorkbenchClient(bindings: WorkbenchBindings & {
  workspace: WorkbenchWorkspaceClient;
  appRpc?: WorkbenchAppRpcClient | null;
  clientStateController?: WorkbenchClientStateController;
}): MountedWorkbenchClient {
  const { workspace, clientStateController: state } = bindings;
  const lifetime = new LifecycleScope();
  const presentation = new WorkbenchPresentationClient({ workspace });
  const retargetPresentationDraft = async (
    id: DraftId, target: ProjectLocationReference, logicalProjectId?: LogicalProjectId,
  ) => {
    const draft = presentation.draft(id);
    if (!draft || draft.phase !== "unsent") throw new Error("The unsent draft is unavailable.");
    await presentation.putDraft({
      id: draft.id,
      logicalProjectId: logicalProjectId ?? draft.logicalProjectId,
      target,
      prompt: draft.prompt,
      references: draft.references,
      selection: draft.selection,
      updatedAt: Date.now(),
    });
  };
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
  let disposed = false;
  let scheduled = false;
  let lastExplorer: ExplorerSnapshot | null = null;
  let tree: QueryHandle<"projectTree"> | null = null;
  let rows: QueryHandle<"projectThreads"> | null = null;
  let previousRows: QueryHandle<"projectThreads"> | null = null;
  let rowSelection: WorkspaceProjectReference[] | null | undefined;
  /** Archived rows are observed only while a view shows them, for the current row selection. */
  let archived: { handle: QueryHandle<"archivedThreads">; limit: number; selection: WorkspaceProjectReference[] | null } | null = null;
  let archivedLimit: number | null = null;
  const owners = new Map<string, QueryHandle<"threadOwner">>();
  const renderers = new Map<DaemonId, ThreadClient>();
  const warmedOpenCodeSources = new Map<DaemonId, number>();
  const localThreadLocations = new Map<string, ProjectLocationReference>();
  const factListeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();
  const warn = (message: string, error?: unknown) => console.warn(message,
    error instanceof Error ? error.message.slice(0, 512) : error === undefined ? "" : "Workspace operation failed.");
  const threadSummaries = new ThreadSummaryStore(workspace);
  /** Summary leases for every listed thread member; a landing summary fills in its sidebar row. */
  const memberLeases = new Map<string, () => void>();
  const projectFactsStore = new ProjectFactsStore(workspace, factsChanged);
  const projectFacts = projectFactsStore.getData;
  const registrationFor = (daemonId: DaemonId) =>
    state?.getSnapshot().registrations.find(item => item.daemonId === daemonId)?.id ?? "";
  const files = new WorkbenchFileStore(workspace, state, registrationFor, warn);
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
    if (value && value.phase !== "pending") return value.phase === "current" ? value.location : null;
    const matches = visibleRows()?.members.filter(member =>
      member.ref.kind === "thread" && member.ref.identity.threadId === id) ?? [];
    const first = matches[0]?.location;
    return first && matches.every(member => sameLocation(member.location, first))
      ? first : localThreadLocations.get(id) ?? null;
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
      workspace, ...(location ? { location } : {}),
      observeProviderEvents: location !== null,
      resolveThreadIdentity: async request => (await daemon.threads.resolveIdentity(request)).data,
      ...(location ? {
        projectRootPathFor: (projectId: string) =>
          threadProject({ daemonId: location.daemonId, projectId: ProjectIdSchema.parse(projectId) })?.rootPath || null,
      } : {}),
      updateThreadStateWithAcceptance: request => mutateThread(request),
      onStatusMessage: message => warn(message),
      ...(state ? { resolveAttachmentUrl: (url: string) => state.resolveDraftAttachmentUrl(url) } : {}),
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
    const location = locationForThread(id);
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
      await retargetPresentationDraft(DraftIdSchema.parse(draftId), location, logical.id);
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

  /** A sole observer swaps its arguments in place, so the change ships as a delta; a shared one takes its own. */
  function retargeted<Kind extends "projectThreads" | "archivedThreads">(handle: QueryHandle<Kind>,
    query: Extract<WorkspaceQuery, { kind: Kind }>) {
    try { handle.retarget(query); return true; }
    catch { return false; }
  }

  function selectRows(selection: WorkspaceProjectReference[] | null) {
    if (rowSelection !== undefined && areDeeplyEqual(rowSelection, selection)) return;
    if (rows && retargeted(rows, { kind: "projectThreads", projects: selection })) {
      rowSelection = selection;
      observeArchived();
      return;
    }
    const next = workspace.observe({ kind: "projectThreads", projects: selection }, factsChanged);
    const retained = usableRows(rows) ? rows : previousRows;
    if (rows && rows !== retained) rows.release();
    if (previousRows && previousRows !== retained) previousRows.release();
    rowSelection = selection;
    rows = next;
    previousRows = retained;
    retirePreviousRows();
    observeArchived();
  }

  function observeArchived() {
    const selection = rowSelection ?? null;
    if (archivedLimit === null || rowSelection === undefined) {
      archived?.handle.release();
      archived = null;
      return;
    }
    if (archived && archived.limit === archivedLimit && areDeeplyEqual(archived.selection, selection)) return;
    if (archived && retargeted(archived.handle, { kind: "archivedThreads", projects: selection, limit: archivedLimit })) {
      archived = { ...archived, limit: archivedLimit, selection };
      return;
    }
    const previous = archived;
    archived = { limit: archivedLimit, selection,
      handle: workspace.observe({ kind: "archivedThreads", projects: selection, limit: archivedLimit }, factsChanged) };
    previous?.handle.release();
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

  /** Listed members: the main list's, then archived page members it does not already hold. */
  function listedMembers() {
    const main = visibleRows();
    const held = new Set(main?.members.map(member => member.key));
    const archivedMembers = (archived?.handle.getSnapshot().value?.data.members ?? []).filter(member => !held.has(member.key));
    return { main, archivedMembers };
  }

  /** Members whose detail is known, as rows: thread summaries that have landed, and listed presentation drafts. */
  function materializeRows(members: readonly WorkspaceThreadMember[]): WorkbenchProjectedThreadRow[] {
    const logical = projectFacts()?.projects ?? [];
    return members.flatMap(member => {
      if (member.ref.kind === "draft") {
        // The listing decided which drafts show and which stand in for their launching thread.
        const draft = presentation.draft(member.ref.draftId);
        return draft && (draft.phase === "unsent" || draft.phase === "submitting")
          ? [materializeWorkspaceThreadRow(member,
            projectPresentationDraftRow(draft, logical, member.ref.launching === true).entry)] : [];
      }
      const located = threadSummaries.get(member.ref.identity.threadId);
      return located ? [materializeWorkspaceThreadRow(member, located.summary.row)] : [];
    });
  }

  let summaryRefreshQueued = false;
  /** One batch delivers many summaries at once; re-project the sidebar once per task, not once per thread. */
  function summaryLanded() {
    if (summaryRefreshQueued) return;
    summaryRefreshQueued = true;
    queueMicrotask(() => {
      summaryRefreshQueued = false;
      factsChanged();
    });
  }

  function syncMemberLeases(members: readonly WorkspaceThreadMember[]) {
    const wanted = new Set<string>(members.flatMap(member => member.ref.kind === "thread" ? [member.ref.identity.threadId] : []));
    for (const [threadId, release] of memberLeases) {
      if (wanted.has(threadId)) continue;
      release();
      memberLeases.delete(threadId);
    }
    for (const threadId of wanted) {
      if (!memberLeases.has(threadId)) memberLeases.set(threadId, threadSummaries.subscribe(threadId, summaryLanded));
    }
  }

  /** The server placement with archived page members appended, newest first, after the archived keys it lists. */
  function placementWithArchived(placement: WorkspaceThreadPlacement, archivedMembers: readonly WorkspaceThreadMember[]) {
    const listed = new Set(placement.archived);
    const extra = archivedMembers.filter(member => member.homeKey && !listed.has(member.homeKey))
      .sort((left, right) => right.activityAt - left.activityAt).map(member => member.homeKey!);
    return extra.length ? { ...placement, archived: [...placement.archived, ...extra] } : placement;
  }

  function selectRowsForRoute(route: WorkbenchRoute) {
    if (projectFactsStore.getGroups().phase === "failed") {
      selectRows(null);
      return;
    }
    // The default project list shows every project; a viewed thread or draft owner never narrows it.
    const defaultSelection = route.selectedProjectIds === null;
    const selectedLogicalIds = defaultSelection ? [] : [...new Set([
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
    const explicit = defaultSelection
      ? route.folderAddress?.length ? projectNavigator.folderForRoute(route) : null
      : projectNavigator.folderForRoute(route) ?? route.logical?.browseLocation ?? route.logical?.location;
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
        ?? (target.kind === "draft" ? presentation.draft(target.draftId)?.target ?? localThreadLocations.get(target.draftId) : null);
      if (location) warmOpenCode(location);
    }
    const { main, archivedMembers } = listedMembers();
    syncMemberLeases([...main?.members ?? [], ...archivedMembers]);
    const observedRows = materializeRows(main?.members ?? []);
    sidebar.acceptFacts(browseLocation, observedRows, main?.projects ?? []);
    // Placement already knows which threads are settled, so warming need not wait for summaries.
    const settledKeys = new Set([...main?.placement.archived ?? [],
      ...main?.placement.settled.flatMap(item => item.kind === "thread" ? [item.key] : item.keys) ?? []]);
    for (const member of main?.members ?? []) {
      if (member.ref.kind === "thread" && member.ref.identity.harness === "opencode"
        && member.homeKey && !settledKeys.has(member.homeKey)) warmOpenCode(member.location);
    }
    prepareMosaicRenderers(route.mosaicNode);
    routeIntents.factsChanged();
    for (const listener of factListeners) listener();
    emit();
  }

  function emit() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const project = projectClient.getSnapshot();
      const threads = threadClient.getSnapshot();
      const fontSize = state?.records("globalPreference").find(item => item.preference.key === "editorFontSize");
      const { main: rowData, archivedMembers } = listedMembers();
      // Archived members ride their own paged observation; a member present in both is the main list's.
      const listed = [...rowData?.members ?? [], ...archivedMembers];
      const logicalRows = materializeRows(listed).filter(
        (item): item is WorkbenchLogicalThreadRow => item.logicalProjectId !== null);
      const threadsError = rows?.getSnapshot().failure ?? threads.threadsError;
      const isThreadsLoading = !!rows && !rows.getSnapshot().value;
      sidebar.acceptListing({
        members: Object.fromEntries(listed.flatMap(member => member.homeKey ? [[member.homeKey, member]] : [])),
        rows: logicalRows,
        archivedCount: rowData?.projects.reduce((total, item) => total + (item.archivedCount ?? 0), 0) ?? 0,
        status: { listed: Boolean(rowData), loading: isThreadsLoading, error: threadsError },
        ...(rowData ? { placement: placementWithArchived(rowData.placement, archivedMembers), folders: rowData.folders } : {}),
      });
      for (const listener of changeListeners) listener();
      const snapshot: ExplorerSnapshot = {
        ...project, browseLocation, currentPath: navigation.getSnapshot().route.view === "file"
          ? navigation.getSnapshot().route.filePath : "",
        isProjectLoading: !!browseLocation && (!tree?.getSnapshot().value?.data || project.isLoading),
        currentThreadId: threads.currentThreadId,
        locallyModifiedPaths: browseLocation ? files.draftsFor(browseLocation).getLocallyModifiedPaths() : [],
        newFileDraftPaths: browseLocation ? files.draftsFor(browseLocation).getNewFilePaths() : [],
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
    localThreadLocations.set(draft.id, location);
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
    if (route.view === "file") {
      selectFolder(browseFolder);
      draftLocation = null;
      threadClient.clearThreadSelection();
      return { ok: true };
    }
    if (route.view === "home" || route.view === "project" && !route.selectedProjectIds?.length
      || route.view === "git" && (route.logical || !route.projectId || route.folderAddress?.length)
      || route.view === "settings"
      || route.view === "stats"
      || route.view === "new-project") {
      selectFolder(browseFolder);
      draftLocation = null;
      threadClient.clearThreadSelection();
      return { ok: true };
    }
    const facts = projectFacts();
    if (!facts) return { ok: false, pending: true };
    if (route.view === "project" && route.selectedProjectIds?.length) {
      const presentationState = presentation.snapshot();
      if (!presentationState.data) {
        return presentationState.phase === "failed"
          ? { ok: false, error: presentationState.error ?? "Project presentation is unavailable." }
          : { ok: false, pending: true };
      }
      const preferred = preferredSelectedLaunchTarget(
        facts.projects,
        route.selectedProjectIds,
        presentationState.data,
      );
      let canonicalRoute: WorkbenchRoute | null = null;
      if (preferred) {
        canonicalRoute = withProjectSelection(createLogicalThreadRoute(
          route.selectedProjectIds.length === 1 ? preferred.project.id : null,
          preferred.project.id,
          preferred.location,
          { kind: "new" },
        ), route.selectedProjectIds);
      } else if (route.projectId) {
        canonicalRoute = createThreadRoute(route.projectId, { kind: "new" });
      }
      if (canonicalRoute) {
        return {
          ok: true,
          canonicalRoute: route.folderAddress === undefined ? canonicalRoute : {
            ...canonicalRoute,
            folderAddress: route.folderAddress && [...route.folderAddress],
          },
        };
      }
      return facts.catalogues.some(item => item.phase === "pending" || item.phase === "stale")
        ? { ok: false, pending: true }
        : { ok: false, error: "No available folder belongs to the selected projects." };
    }
    const logical = facts.projects.find(item => item.id === (logicalId ?? route.logical?.threadOwnerProjectId));
    const saved = target?.kind === "draft" ? presentation.draft(target.draftId) : null;
    const draftRouteTarget = route.view === "thread" && (target?.kind === "new" || target?.kind === "draft");
    const browseTarget = explicit ?? (logical?.locations.length === 1 ? logical.locations[0]!.target : null);
    let location = draftRouteTarget
      ? explicit ?? saved?.target ?? (logical && presentation.snapshot().data
        ? preferredLogicalLaunchLocation(logical, presentation.snapshot().data!) : null)
      : explicit ?? browseTarget ?? browseFolder;
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
      // With no project selected, a thread browses its own folder.
      selectFolder(browseFolder ?? (route.logical
        ? browseTarget ?? (route.selectedProjectIds === null ? data.location : null)
        : location ?? data.location));
      selectRenderer(data.location);
      draftLocation = null;
      const outcome = await threadClient.openThread(data.identity.threadId, {
        harness: data.identity.harness, project, isCurrent: context.isCurrent,
      });
      if (!context.isCurrent() || outcome.kind === "superseded") return { ok: false };
      if (outcome.kind === "failure") return { ok: false, error: outcome.message };
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
    if (route.view === "thread" && target && (target.kind === "new" || target.kind === "draft")) {
      if (target.kind === "draft" && !saved) {
        return presentation.snapshot().data ? { ok: false, error: "The saved draft is unavailable." }
          : { ok: false, pending: true };
      }
      if (saved && explicit && !sameLocation(saved.target, explicit)) {
        return { ok: false, error: "The draft address does not match its saved folder." };
      }
      const current = threadClient.getSnapshot().currentThread;
      const sameDraft = current?.isDraft && sameLocation(localThreadLocations.get(current.id), location)
        && (target.kind === "draft" ? current.id === target.draftId : draftRoute?.threadTarget?.kind === "new");
      const retainedNewDraftId = target.kind === "new" && current?.isDraft
        && draftRoute?.threadTarget?.kind === "new"
        ? DraftIdSchema.parse(current.id)
        : undefined;
      const draft = sameDraft ? current : createDraft(location,
        saved?.selection.settings.harness ?? defaultProviderKey,
        { threadId: target.kind === "draft" ? target.draftId : retainedNewDraftId });
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
    const result = WorkspaceThreadActionResultSchema.safeParse(await workspace.rpc.requestRaw({
      method: "workspace/thread/action", params: { threadId, intent },
    }));
    if (!result.success) {
      reportClientSchemaError(`Rejected workspace thread action (${intent.kind})`, result.error);
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
    continueThreadCreation: (draftId, nextDraftId) => {
      const route = navigation.getSnapshot().route;
      const location = localThreadLocations.get(draftId);
      if (!location) return null;
      const renderer = rendererFor(location);
      const draft = renderer.getThreadStore(location.projectId, { kind: "draft", draftId }).getSlice("summary").draftDocument;
      if (!draft) return null;
      let nextRoute: WorkbenchRoute;
      if (route.view === "mosaic" && route.mosaicNode) {
        let found = false;
        const replace = (node: NonNullable<WorkbenchRoute["mosaicNode"]>): NonNullable<WorkbenchRoute["mosaicNode"]> => {
          if (node.type === "split") return { ...node, children: node.children.map(replace) };
          if (node.target.kind !== "thread" || node.target.target.kind !== "draft"
            || node.target.target.draftId !== draftId) return node;
          found = true;
          return { ...node, target: { ...node.target, target: { kind: "draft", draftId: nextDraftId } } };
        };
        const node = replace(route.mosaicNode);
        if (!found) return null;
        nextRoute = route.logical?.projectId
          ? createLogicalMosaicRoute(route.logical.projectId, node)
          : createMosaicRoute(route.projectId, node);
        createDraft(location, draft.harness, { threadId: nextDraftId, select: false });
      } else {
        if (!route.logical || !isWorkbenchRouteOwnerOfThread(route, draftId, true)
          || threadClient.getSnapshot().currentThread?.id !== draftId) return null;
        const owner = route.logical.threadOwnerProjectId ?? logicalFor(location)?.id;
        if (!owner) return null;
        nextRoute = createLogicalThreadRoute(route.logical.projectId, owner, location,
          route.threadTarget?.kind === "new" ? route.threadTarget : { kind: "new" });
        draftRoute = nextRoute;
        createDraft(location, draft.harness, { threadId: nextDraftId });
      }
      return withProjectSelection(nextRoute, route.selectedProjectIds);
    },
    getSelectedThreadDraft: () => navigation.readPinnedDraft((projectId, draftId) =>
      sidebar.getDraft(ProjectIdSchema.parse(projectId), DraftIdSchema.parse(draftId))),
    sendThreadMessage: async (thread, input, options = {}) => {
      if (!thread.isDraft) throw new Error("Existing threads send through their thread store.");
      const saved = presentation.draft(thread.id);
      if (!saved) throw new Error("Save this draft before starting it.");
      const route = navigation.getSnapshot().route;
      const launched = await workspace.launchDraft(saved.id, saved.revision, options);
      localThreadLocations.set(launched.threadId, saved.target);
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
      // The thread's observation carries the accepted title to every view.
      return parsed.data.title;
    },
    setArchivedThreadLimit: limit => {
      archivedLimit = limit === null ? null : Math.min(Math.max(1, Math.floor(limit)), 500);
      observeArchived();
      emit();
    },
    listModels: (...args) => threadClient.listModels(...args),
    watchRateLimits: () => threadClient.watchRateLimits(),
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
    deleteFile: async (path, options) => {
      const location = browseLocation;
      const result = await projectClient.deleteFile(path, options);
      if (!result.confirmationRequired && location) {
        try { await files.draftsFor(location).clearBuffer(path); }
        catch (error) { warn("File deleted, but its editor draft could not be removed.", error); }
        emit();
      }
      return result;
    },
    deleteThreadDraft: (id, projectId) => sidebar.delete(id, Date.now(), projectId),
    moveThreadDraft: (source, destination, id) => sidebar.moveDraft(source, destination, id),
    deletePresentationDraft: id => presentation.removeDraft(id),
    // Saving a known destination does not require a live daemon. Launch validates capabilities.
    retargetPresentationDraft,
    setPresentationDraftPriority: (...args) => presentation.setDraftPriority(...args),
    savePresentationProjectLayout: (...args) => presentation.saveProjectLayout(...args),
    savePresentationHomeLayout: (...args) => presentation.saveHomeLayout(...args),
    savePresentationHomeAndProjectLayouts: (...args) => presentation.saveHomeAndProjectLayouts(...args),
    updatePresentationProjectLayout: (...args) => presentation.updateProjectLayout(...args),
    updatePresentationHomeLayout: intent => presentation.updateHomeLayout(intent),
    updatePresentationPinnedLayout: (...args) => presentation.updatePinnedLayout(...args),
    createTextFileDocumentPort: (path, explicitLocation) => {
      const location = explicitLocation ?? browseLocation;
      if (!location) throw new Error("Choose a folder before opening an editor.");
      const operations = workspace.daemon({ kind: "folder", location });
      const drafts = files.draftsFor(location);
      const { projectId } = location;
      return {
        read: async () => {
          const file = await operations.projects.files.read({ projectId, path });
          return { content: file.content, mtimeMs: file.mtimeMs };
        },
        save: async (content, expectedMtimeMs, force) => {
          const result = await operations.projects.files.save({ projectId, path, content, expectedMtimeMs, force });
          return "actualMtimeMs" in result ? { kind: "conflict", message: result.error } : { kind: "saved", mtimeMs: result.mtimeMs };
        },
        drafts: {
          read: () => {
            const buffer = drafts.getBuffer(path);
            return buffer?.dirty ? { content: buffer.content, mtimeMs: buffer.expectedMtimeMs, history: buffer.history } : null;
          },
          write: ({ baseline, content, history, mtimeMs }) => drafts.setBuffer(path, {
            baselineContent: baseline, content, dirty: true, editorState: content, expectedMtimeMs: mtimeMs, headContent: null,
            history, mode: "plain", pendingWriteConflict: null, saveIssue: null,
          }),
          clear: () => drafts.clearBuffer(path),
          subscribe: listener => drafts.subscribe(() => listener()),
        },
      };
    },
    createTextFile: async (path, content, explicitLocation) => {
      const location = explicitLocation ?? browseLocation;
      if (!location) throw new Error("Choose a folder before creating a file.");
      const operations = workspace.daemon({ kind: "folder", location });
      const existing = await operations.projects.files.read({ projectId: location.projectId, path }).then(() => true, () => false);
      if (existing) throw new Error(`${path} already exists.`);
      // A forced save creates the missing file and any missing folders on its path.
      const saved = await operations.projects.files.save({ projectId: location.projectId, path, content, expectedMtimeMs: 0, force: true });
      if ("actualMtimeMs" in saved) throw new Error(saved.error);
    },
    createFileDraft: (path, content) => {
      if (!browseLocation) throw new Error("Choose a folder before creating a file.");
      files.draftsFor(browseLocation).createNewFileBuffer(path, content, isMarkdownFile(path) ? "rich" : "plain");
    },
    discardFileDraft: async path => {
      if (browseLocation) await files.draftsFor(browseLocation).clearBuffer(path);
    },
  };

  const draftLocationFor = (id: string) => presentation.draft(id)?.target ?? localThreadLocations.get(id) ?? null;
  const launchContextFor = (location: ProjectLocationReference): ViewContext | null => {
    const project = threadProject(location);
    const renderer = renderers.get(location.daemonId);
    return project && renderer ? { daemonId: location.daemonId, daemon: workspace.daemon({ kind: "folder", location }),
      project, threads: renderer,
      assetSource: { kind: "source", daemonId: location.daemonId } } : null;
  };
  const locationOwnerFor: MountedWorkbenchClient["locationOwnerFor"] = location => {
    const project = folder(location);
    const hostname = projectFacts()?.sources.find(item => item.daemonId === location.daemonId)?.hostname ?? location.daemonId;
    const displayPath = projectFacts()?.projects.flatMap(item => item.locations)
      .find(item => sameLocation(item.target, location))?.displayPath ?? project?.name ?? location.projectId;
    return { ...location, hostname, rootPath: project?.rootPath ?? "",
      displayPath };
  };
  const threadOwnerFor: MountedWorkbenchClient["threadOwnerFor"] = id => {
    const location = locationForThread(id);
    return location ? locationOwnerFor(location) : null;
  };
  lifetime.addUnsubscribe(projectClient.subscribe(() => {
    refreshProjectNavigator();
    emit();
  }));
  lifetime.addUnsubscribe(presentation.subscribe(factsChanged));
  lifetime.addUnsubscribe(files.subscribeDrafts(emit));
  if (state) lifetime.addUnsubscribe(state.subscribe(factsChanged));
  presentation.start();
  void network.start().catch(error => warn("Network settings could not start.", error));
  void runtime.open().catch(error => warn("Runtime observation could not start.", error));
  emit();

  return {
    workspace, files, networkClient: network, presentationClient: presentation,
    navigation, projectNavigator, routeIntents, controls, voice, projectFileIndexStore,
    projectFacts: projectFactsStore,
    projectSourceErrors: {
      getSnapshot: () => [projectFactsStore.getFailure(),
        ...(projectFacts()?.catalogues.map(item => item.failure) ?? []),
        rows?.getSnapshot().failure, tree?.getSnapshot().failure].filter(Boolean).join(" "),
      subscribe: listener => { factListeners.add(listener); return () => { factListeners.delete(listener); }; },
    },
    subscribeChanges: listener => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    threadRuntime, threadSidebar: sidebar, threadSummaries,
    get threadTextPresentation() { return threadClient.textPresentation; },
    threadTextPresentationFor: id => rendererForThread(id).textPresentation,
    getThreadStore: (projectId, target) => {
      const id = target.kind === "draft" ? target.draftId
        : target.kind === "subagent" ? target.parentThreadId : target.threadId;
      const location = locationForThread(id);
      return rendererForThread(id).getThreadStore(location?.projectId ?? projectId, target);
    },
    threadOwnerFor, locationOwnerFor,
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
    refreshInstallationProjects: async daemonId => {
      await workspace.daemon({ kind: "installation", daemonId }).projects.catalog();
      return await presentation.refresh();
    },
    dispose: () => {
      disposed = true;
      projectFactsStore.dispose();
      rows?.release();
      previousRows?.release();
      archived?.handle.release();
      tree?.release();
      for (const owner of owners.values()) owner.release();
      for (const release of memberLeases.values()) release();
      memberLeases.clear();
      threadSummaries.dispose();
      files.dispose();
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
      changeListeners.clear();
    },
  };
}
