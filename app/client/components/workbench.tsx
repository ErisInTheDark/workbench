/*
 * Exports:
 * - default Workbench: shell composition, providers, explorer actions, routed views and responsive chrome.
 * Local helpers: route, title, drag, editor, file, and thread UI transformations.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";

import type {
    ExplorerSnapshot,
    RevealProjectEntryRequest, ThreadPayload, TreeNode,
    WorkbenchAppRuntimeStore,
    WorkbenchComposerInputDraft,
    WorkbenchComposerSettings,
    WorkbenchControls,
    WorkbenchHarness,
    WorkbenchLogicalThreadRow,
    WorkbenchProjectOption,
    WorkbenchSendThreadMessageOptions,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { DaemonIdSchema, DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema, type DaemonId, type FolderId } from "workbench-shared/workbench/identity";
import WorkbenchMainLayout, {
    type WorkbenchDropPlacement,
    type WorkbenchMainLayout as WorkbenchMainLayoutState,
    type WorkbenchPanelTarget,
} from "workbench-shared/workbench/layout/workbench-layout";
import {
    type WorkbenchMosaicNode,
    type WorkbenchMosaicPanelTarget,
} from "workbench-shared/workbench/navigation/workbench-mosaic-route";
import {
    createFileRoute,
    createDiscardedDraftExitRoute,
    createHomeRoute,
    createHomeThreadRoute,
    createLogicalExistingThreadRoute,
    createLogicalFileRoute,
    createLogicalMosaicRoute,
    createLogicalProjectRoute,
    createLogicalThreadRoute,
    createMosaicRoute,
    createPinnedThreadRoute,
    createProjectRoute,
    createSettingsRoute,
    createSettledThreadExitRoute,
    createThreadRoute,
    getWorkbenchMosaicThreadRootIds,
    getWorkbenchThreadTargetRootId,
    getWorkbenchThreadTargetSelectedId,
    isSameDraftRouteIntent,
    isWorkbenchRouteOwnerOfThread,
    isWorkbenchThreadTargetSelected,
    withProjectSelection,
    type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { projectFolderOptions } from "workbench-shared/workbench/project/project-folder-address";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { isSvgFile, isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import {
    preferredSelectedLaunchTarget,
    projectLogicalThreadDisplayOrder,
} from "workbench-shared/workbench/project/workbench-project-projection";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { useThread } from "./workbench/use-thread";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { useWorkbenchAppRpc } from "../workbench/app/WorkbenchAppRpcContext";
import { WorkbenchNetworkClientContext } from "../workbench/app/WorkbenchNetworkClient";
import WorkbenchBrowseSessionController from "../workbench/browse/WorkbenchBrowseSessionController";
import { installBrowserRandomUuidPolyfill } from "../workbench/browser-random-uuid-polyfill";
import {
  FileActionContext, FileScopeContext, resolveFileOpenDestination, resolveWorkbenchFileRoute, useFileActions,
} from "../workbench/file/use-file";
import type { WorkbenchDragPayload, WorkbenchMainPanelDragPayload } from "../workbench/layout/workbench-drag";
import { replaceWorkbenchMosaicTarget } from "../workbench/layout/workbench-mosaic-layout";
import useMediaQuery from "../workbench/dom/layout/use-media-query";
import WorkbenchWorkspaceController from "../workbench/layout/WorkbenchWorkspaceController";
import type { WorkspaceFileLinkRoot } from "../workbench/markdown/markdown-links";
import { useWorkbenchProjectNavigation } from "../workbench/navigation/use-workbench-project-navigation";
import { useWorkbenchRoute, useWorkbenchRouteIntent } from "../workbench/navigation/use-workbench-route";
import { useWorkbenchRouteContext } from "../workbench/navigation/use-workbench-route-context";
import WorkbenchProjectNavigation from "../workbench/navigation/workbench-project-navigation";
import {
    handleWorkbenchActionShortcut,
    runWorkbenchAction,
    type WorkbenchActionContext,
} from "../workbench/search/workbench-action-registry";
import { createComposerProfilePersistence, createComposerProfileTargetPersistence } from "../workbench/state/composer-profile-api";
import {
    attachComposerDraftReference, clearComposerDraft, presentationDraftToInput, projectComposerDrafts, saveComposerDraft,
    type ComposerDraftTarget,
} from "../workbench/state/draft-persistence";
import {
    getPreferredMobilePane,
    isMobileSidebarRequested,
    MOBILE_MEDIA_QUERY,
    mobileSidebarHref,
} from "../workbench/state/mobile-pane-url-state";
import type { MobilePaneDestination } from "../workbench/navigation/MobilePaneSwipeController";
import { installBrowserLinkNavigation, useSearchParams } from "../workbench/navigation/browser-navigation";
import {
    MAX_EDITOR_FONT_SIZE,
    MIN_EDITOR_FONT_SIZE,
} from "../workbench/state/workbench-settings";
import { useSettings } from "./workbench/use-settings";
import WorkbenchComposerProfileController from "../workbench/state/WorkbenchComposerProfileController";
import { getThreadDocumentFromSnapshot } from "../workbench/thread/thread-document-keys";
import { ThreadMessageNotSentError } from "../workbench/thread/thread-message-submission";
import { useWorkbenchDrag } from "./workbench/drag/workbench-drag-context";
import WorkbenchWorkingTreeProvider from "./workbench/git/WorkbenchWorkingTreeProvider";
import WorkbenchWorkingTreeView from "./workbench/git/WorkbenchWorkingTreeView";
import WorkbenchFileView from "./workbench/layout/WorkbenchFileView";
import WorkbenchSvgEditorView from "./workbench/svg/WorkbenchSvgEditorView";
import WorkbenchSvgFileView, { canCreateTextFiles, NEW_SVG_SOURCE } from "./workbench/svg/WorkbenchSvgFileView";
import WorkbenchShellTabs from "./workbench/shell-tabs/WorkbenchShellTabs";
import WorkbenchThreadPanel from "./workbench/layout/WorkbenchThreadPanel";
import MobilePaneTrack from "./workbench/MobilePaneTrack";
import type { MobileShellHeaderEvent } from "./workbench/mobile-shell-header-visibility";
import MobileShellHeaderVisibilityController from "./workbench/MobileShellHeaderVisibilityController";
import WorkbenchMobileShellHeader from "./workbench/WorkbenchMobileShellHeader";
import WorkbenchStatsView from "./workbench/stats/WorkbenchStatsView";
import { resolveStatsProjectScope } from "./workbench/stats/stats-project-scope";
import type DraftSessionController from "./workbench/thread-view/DraftSessionController";
import { draftSessionOwner } from "./workbench/thread-view/DraftSessionController";
import { seedNewThreadReferences } from "../workbench/thread/new-thread-reference-seeds";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import { readWorkbenchLaunchSelection } from "workbench-shared/state/workbench-client-state";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import ThreadScrollViewport from "./workbench/thread-view/ThreadScrollViewport";
import ThreadView from "./workbench/thread-view/ThreadView";
import { useWorkbenchClientMount } from "./workbench/use-workbench-client";
import { useProjects } from "./workbench/use-projects";
import { useThreads } from "./workbench/use-threads";
import {
    workbenchNewEntryButtonClassName,
    workbenchOptionHoverClassName,
    workbenchOptionRowClassName,
} from "./workbench/workbench-class-names";
import {
    useWorkbenchClientStateController,
    useWorkbenchClientStateSnapshot,
} from "./workbench/workbench-client-state-context";
import { dialogButtonClassName } from "./workbench/workbench-dialog-styles";
import {
    WorkbenchDialog,
} from "./workbench/workbench-dialogs";
import {
    ExplorerTree,
    FileVisibilityIcon,
    NewEntryIcon,
    SidebarLoadingSkeleton,
} from "./workbench/workbench-explorer";
import {
    BackArrowIcon,
    BinIcon,
    ExternalLinkIcon,
    FolderOpenIcon,
    SidebarCollapseIcon,
    SidebarExpandIcon,
    SparkleIcon,
} from "./workbench/workbench-icons";
import WorkbenchAmbientCanvas, { type WorkbenchAmbientCanvasVariant } from "./workbench/WorkbenchAmbientCanvas";
import WorkbenchClientProvider from "./workbench/WorkbenchClientProvider";
import WorkbenchComposerProfileProvider from "./workbench/WorkbenchComposerProfileProvider";
import type { WorkbenchContextMenuDefinition } from "./workbench/WorkbenchContextMenuContext";
import WorkbenchContextMenuProvider from "./workbench/WorkbenchContextMenuProvider";
import IconButton from "./ui/IconButton";
import WorkbenchProjectControl from "./workbench/WorkbenchProjectControl";
import WorkbenchThreadOwnerLabel from "./workbench/WorkbenchThreadOwnerLabel";
import WorkbenchProjectLocationMenu from "./workbench/WorkbenchProjectLocationMenu";
import WorkbenchSearchDialog from "./workbench/search/WorkbenchSearchDialog";
import { useWorkbenchSearch } from "./workbench/search/workbench-search-context";
import WorkbenchSettingsView from "./workbench/WorkbenchSettingsView";
import { workbenchRouteViews } from "./workbench/route-views/workbench-route-views";
import WorkbenchSidebarPreferencesProvider from "./workbench/WorkbenchSidebarPreferencesProvider";
import { useWorkbenchSidebarPreferences } from "./workbench/workbench-sidebar-preferences-context";
import WorkbenchSidebarSectionDisclosure from "./workbench/WorkbenchSidebarSectionDisclosure";
import WorkbenchTabIcon from "./workbench/WorkbenchTabIcon";
import WorkbenchSidebarPane from "./workbench/WorkbenchSidebarPane";
import { isThreadStatusActive } from "./workbench/thread-attention";
import WorkbenchThreadTooltipDetails from "./workbench/WorkbenchThreadTooltipDetails";
import WorkbenchWorkspace from "./workbench/WorkbenchWorkspace";
import { WorkbenchDaemonAssetOriginContext, WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "./workbench/WorkbenchWorkspaceContext";
import WorkbenchZoomButton from "./workbench/WorkbenchZoomButton";

installBrowserRandomUuidPolyfill();

function createUniqueFileLinkRootId (id: string, usedIds: Set<string>) {
  const baseId = id.trim() || "root";
  let candidateId = baseId;
  let suffix = 2;
  while (usedIds.has(candidateId.toLowerCase())) {
    candidateId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidateId.toLowerCase());
  return candidateId;
}

function createProjectFileLinkRoots (
  projects: readonly WorkbenchProjectOption[],
  currentProjectId: string,
  currentRoots: readonly ExplorerSnapshot["roots"][number][],
): WorkspaceFileLinkRoot[] {
  const roots: WorkspaceFileLinkRoot[] = [];
  const usedIds = new Set<string>();
  const usedRootPaths = new Set<string>();

  const addRoot = (root: WorkspaceFileLinkRoot) => {
    const rootPathKey = root.rootPath.toLowerCase();
    if (!root.rootPath || usedRootPaths.has(rootPathKey)) {
      return;
    }

    usedRootPaths.add(rootPathKey);
    roots.push({
      ...root,
      id: createUniqueFileLinkRootId(root.id, usedIds),
    });
  };

  if (currentRoots.length > 1) {
    for (const root of currentRoots) {
      addRoot({
        id: root.id,
        openPathMode: "workspace-qualified",
        projectId: currentProjectId,
        rootPath: root.rootPath,
      });
    }
  }

  for (const project of projects) {
    if (project.id === currentProjectId) {
      continue;
    }

    for (const root of project.roots) {
      addRoot({
        id: project.kind === "git" ? project.name || project.id : root.id,
        openPathMode: project.kind === "workspace" ? "workspace-qualified" : "root-relative",
        projectId: project.id,
        rootPath: root.rootPath,
      });
    }
  }

  return roots;
}

function formatWorkbenchPageTitle (projectName: string | null | undefined) {
  const normalizedProjectName = projectName?.trim();
  return normalizedProjectName ? `${normalizedProjectName} / Workbench` : "Workbench";
}

function getFirstMosaicTarget (node: WorkbenchMosaicNode | null): WorkbenchMosaicPanelTarget | null {
  if (!node) {
    return null;
  }

  if (node.type === "target") {
    return node.target;
  }

  for (const child of node.children) {
    const target = getFirstMosaicTarget(child);
    if (target) {
      return target;
    }
  }

  return null;
}

function getRouteMosaicFallbackTarget (routeNode: WorkbenchMosaicNode | null, isMobile: boolean): WorkbenchMosaicPanelTarget | null {
  return isMobile ? getFirstMosaicTarget(routeNode) : null;
}

function mosaicContainsThreadTarget (node: WorkbenchMosaicNode | null, threadId: string): boolean {
  if (!node) {
    return false;
  }

  if (node.type === "target") {
    return node.target.kind === "thread"
      && (node.target.target.kind === "draft" && node.target.target.draftId === threadId
        || node.target.target.kind === "provider" && node.target.target.threadId === threadId);
  }

  return node.children.some((child) => mosaicContainsThreadTarget(child, threadId));
}

const noSubscription = (_listener: () => void) => () => {};

function filterVisibleTreeNodes (nodes: TreeNode[]): TreeNode[] {
  const visibleNodes: TreeNode[] = [];

  for (const node of nodes) {
    if (node.type === "file") {
      if (isWorkbenchOpenableFile(node.path)) {
        visibleNodes.push(node);
      }
      continue;
    }

    const children = filterVisibleTreeNodes(node.children);
    if (children.length) {
      visibleNodes.push({
        ...node,
        children,
      });
    }
  }

  return visibleNodes;
}

function getProjectTabLabel (projectName: string | null | undefined) {
  return projectName?.trim() || "Project";
}

export default function Workbench ({ appRuntime = null }: { appRuntime?: WorkbenchAppRuntimeStore | null }) {
  const appRpc = useWorkbenchAppRpc();
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const [composerProfileControllers] = useState(() => new Map<string, WorkbenchComposerProfileController>());
  const initialRoute = new WorkbenchProjectNavigation([], clientStateController.getProjectAliases())
    .readRoute(typeof window === "undefined" ? "/" : window.location.href,
      readWorkbenchLaunchSelection(clientState.records));
  const currentRouteRef = useRef<WorkbenchRoute>(initialRoute);
  const activeDraftSessionRef = useRef<DraftSessionController<WorkbenchComposerInputDraft> | null>(null);
  const workbenchMount = useWorkbenchClientMount({
    appRpc,
    clientStateController,
    initialRoute,
  });
  const workbenchClient = workbenchMount.client;
  const { navigateToRoute, navigationState, route } = useWorkbenchRoute(workbenchClient);
  const openQualifiedThread = useCallback((row: WorkbenchLogicalThreadRow,
    selectedLogicalProjectId: string | null) => {
    navigateToRoute(row.entry.entryKind === "draft"
      ? createLogicalThreadRoute(selectedLogicalProjectId, row.logicalProjectId, null,
        { kind: "draft", draftId: row.entry.draft.draftId })
      : createLogicalExistingThreadRoute(selectedLogicalProjectId,
        { kind: "provider", harness: row.entry.identity.harness,
          threadId: ThreadReferenceSchema.parse(row.entry.identity.threadId) }));
  }, [navigateToRoute]);
  const handlePresentationDraftDeleted = useCallback((draftId: string) => {
    const current = currentRouteRef.current;
    const exit = createDiscardedDraftExitRoute(current, draftId);
    if (exit) navigateToRoute(exit, { replace: true });
  }, [navigateToRoute]);
  const projectHref = useWorkbenchProjectNavigation(workbenchClient);
  currentRouteRef.current = route;
  const explorer = workbenchMount.explorer;
  const browseLocation = explorer.browseLocation ?? null;
  const logicalProjects = useProjects(workbenchClient);
  const projectSelection = useProjects.selection(route, explorer.projects, browseLocation, workbenchClient);
  useProjects.observeSelection(projectSelection, workbenchClient);
  const {
    displayedLogicalProjects, selectionProjectIds, selectedLogicalProject, selectedLogicalProjects, selectedPhysicalProjects,
  } = projectSelection;
  useEffect(() => installBrowserLinkNavigation(), []);
  const dynamicSelectionPending = projectSelection.pending;
  const currentThread = useThreads.current(workbenchClient);
  const threadDocuments = useThreads.documents(workbenchClient);
  const [localSelectionError, setSelectionError] = useState("");
  useEffect(() => {
    if (navigationState?.phase === "ready") setSelectionError("");
  }, [navigationState?.phase, navigationState?.generation]);
  const presentationState = workbenchClient.mounted?.presentationClient?.snapshot();
  const selectionError = (navigationState?.phase === "failed" ? navigationState.error ?? "" : "")
    || localSelectionError
    || (workbenchMount.startup.phase === "failed" ? workbenchMount.startup.error ?? "" : "")
    || (presentationState?.phase === "failed" ? presentationState.error ?? "" : "");
  const retryPresentation = useCallback(() => {
    void workbenchClient.mounted?.presentationClient?.refresh().catch(error =>
      console.warn("Project identities could not refresh:",
        error instanceof Error ? error.message.slice(0, 512) : "Unknown failure."));
  }, [workbenchClient.mounted]);
  const [isProjectRotationPending, setIsProjectRotationPending] = useState(false);
  const controls = workbenchClient.controls;
  const {
    threadContext: routeThreadContext, draftContext: routeDraftContext, launchLocation: routeLaunchLocation,
    ownerMetadata: routeOwnerMetadata, browseDaemon, selectedDaemon, selectedAssetSource, profileScopeKey,
  } = useWorkbenchRouteContext(workbenchClient, route, currentThread, browseLocation);
  const profileControllerFor = useCallback((key: string) => {
    const existing = composerProfileControllers.get(key);
    if (existing) return existing;
    const controller = new WorkbenchComposerProfileController();
    composerProfileControllers.set(key, controller);
    return controller;
  }, [composerProfileControllers]);
  const composerProfileController = profileControllerFor(profileScopeKey);
  useEffect(() => () => {
    for (const controller of composerProfileControllers.values()) controller.dispose();
    composerProfileControllers.clear();
  }, [composerProfileControllers]);
  useEffect(() => {
    const presentation = workbenchClient.mounted?.presentationClient;
    const source = DaemonIdSchema.safeParse(profileScopeKey);
    if (!controls || !selectedDaemon || !presentation || !source.success) return;
    void composerProfileController.initializeTargetPersistence(createComposerProfileTargetPersistence(
      selectedDaemon, presentation, source.data,
    ));
    void composerProfileController.initializePersistence(createComposerProfilePersistence(selectedDaemon));
    return () => { composerProfileController.disconnectPersistence(); };
  }, [composerProfileController, controls, selectedDaemon, workbenchClient.mounted?.presentationClient, profileScopeKey]);
  const [harness, setHarness] = useState<WorkbenchHarness>(() => (
    clientStateController.records("globalPreference").find((record) => (
      record.preference.key === "harness"
    ))?.preference.value as WorkbenchHarness | undefined
  ) ?? defaultProviderKey);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [mobileShellHeaderVisibility] = useState(() => new MobileShellHeaderVisibilityController());
  const mobileSidebarRequested = isMobileSidebarRequested(useSearchParams().toString());
  const mobilePane = getPreferredMobilePane(isMobile, route, mobileSidebarRequested);
  const mobilePaneSlideRef = useRef<((destination: MobilePaneDestination) => void) | null>(null);
  // A composer shortcut asks settings to open on one section; ordinary settings visits start fresh.
  const [settingsTarget, setSettingsTarget] = useState<{ section: string; daemonId: DaemonId } | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [pendingDeleteFilePath, setPendingDeleteFilePath] = useState("");
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [projectActionError, setProjectActionError] = useState("");
  const globalSettings = useSettings();
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");
  const [workspaceController] = useState(() => new WorkbenchWorkspaceController({
    createDraft: () => {
      throw new Error("Workspace draft creation is not connected.");
    },
    navigateMosaic: () => undefined,
    navigatePanel: () => undefined,
    navigateProject: () => undefined,
  }));
  const mainPaneRef = useRef<HTMLElement>(null);
  const directThreadScrollViewportRef = useRef<HTMLDivElement>(null);
  const retainedThreadRef = useRef<ThreadPayload | null>(null);
  const threadViewInstanceKeysByThreadIdRef = useRef(new Map<string, string>());
  const search = useWorkbenchSearch();
  const sidebarPreferences = useWorkbenchSidebarPreferences.global();
  const isEffectiveDesktopSidebarCollapsed = !isMobile && sidebarPreferences.preferences.sidebarCollapsed;
  const drag = useWorkbenchDrag();
  const activeDragPayload = useWorkbenchDrag.activePayload();
  const beginMainPanelDrag = useWorkbenchDrag.mainPanel();
  useEffect(() => () => { workspaceController.dispose(); }, [workspaceController]);

  const selectedThreadProjectId = route.view === "thread"
    ? route.threadOwnerProjectId || explorer.currentProjectId || route.projectId
    : explorer.currentProjectId;
  const composerDraftIdentityFor = useCallback((threadId: string) => route.logical
    ? workbenchClient.mounted?.threadDraftIdentityFor(threadId) ?? null
    : selectedThreadProjectId ? {
      daemonRegistrationId: clientState.daemonRegistrationId,
      projectId: ProjectIdSchema.parse(selectedThreadProjectId),
      threadId: ThreadReferenceSchema.parse(threadId),
    } : null, [clientState.daemonRegistrationId, route.logical, selectedThreadProjectId, workbenchClient.mounted]);
  // Owners land asynchronously; re-project only when which drafts resolve changes.
  const readResolvedComposerDrafts = useCallback(() => Object.keys(projectComposerDrafts(
    clientState.records, composerDraftIdentityFor)).join("\n"), [clientState.records, composerDraftIdentityFor]);
  const resolvedComposerDrafts = useSyncExternalStore(workbenchClient.mounted?.subscribeChanges ?? noSubscription,
    readResolvedComposerDrafts, readResolvedComposerDrafts);
  const threadComposerDraftsByThreadId = useMemo(() => projectComposerDrafts(clientState.records, composerDraftIdentityFor),
    [clientState.records, composerDraftIdentityFor, resolvedComposerDrafts]);

  const isMobileMosaicRoute = isMobile && route.view === "mosaic";
  const routeMosaicNodeForControls = isMobileMosaicRoute ? route.mosaicNode : null;
  const routeToApplyToControls = useMemo(() => {
    if (route.logical) return route;
    if (route.view === "mosaic") {
      const mobileMosaicTarget = getRouteMosaicFallbackTarget(routeMosaicNodeForControls, isMobileMosaicRoute);
      if (mobileMosaicTarget?.kind === "file") {
        return createFileRoute(route.projectId, mobileMosaicTarget.filePath);
      }
      if (mobileMosaicTarget?.kind === "thread") {
        return createThreadRoute(route.projectId, mobileMosaicTarget.target);
      }

      return createProjectRoute(route.projectId);
    }

    if (route.view === "file") {
      return createFileRoute(route.projectId, route.filePath);
    }
    if (route.view === "thread") {
      const threadRoute = !route.projectId && route.threadOwnerProjectId
        ? createHomeThreadRoute(route.threadOwnerProjectId, route.threadTarget ?? route.threadId)
        : route.threadOwnerProjectId && route.threadOwnerProjectId !== route.projectId
        ? createPinnedThreadRoute(route.projectId, route.threadOwnerProjectId, route.threadTarget ?? route.threadId)
        : createThreadRoute(route.projectId, route.threadTarget ?? route.threadId);
      return withProjectSelection(threadRoute, route.selectedProjectIds);
    }
    if (route.view === "settings") {
      return route;
    }
    if (route.view === "stats" || route.view === "git") {
      return route.projectId ? createProjectRoute(route.projectId) : createHomeRoute();
    }
    if (route.view === "project") {
      return createProjectRoute(route.projectId);
    }

    return route;
  }, [
    isMobileMosaicRoute,
    route.error,
    route.filePath,
    route.logical?.projectId,
    route.logical?.threadOwnerProjectId,
    route.logical?.location?.daemonId,
    route.logical?.location?.projectId,
    route.logical?.browseLocation?.daemonId,
    route.logical?.browseLocation?.projectId,
    route.projectId,
    route.selectedProjectIds,
    route.threadId,
    route.threadTarget,
    route.view,
    routeMosaicNodeForControls,
  ]);

  useWorkbenchRouteIntent(workbenchClient, routeToApplyToControls, navigateToRoute);
  useEffect(() => { setSelectionError(""); }, [routeToApplyToControls]);

  const expandedDirectories = new Set(explorer.expandedDirectories);
  const modifiedPaths = new Set(explorer.locallyModifiedPaths);
  const currentProject = explorer.projects.find((project) => project.id === explorer.currentProjectId) ?? null;
  const activeProjectId = explorer.currentProjectId || route.projectId;
  const viewedProjectId = route.logical ? route.logical.projectId ?? "" : activeProjectId;
  const browseProjectId = browseLocation?.projectId ?? explorer.currentProjectId;
  const attachedProjectId = route.logical
    ? browseProjectId && browseLocation?.daemonId === workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId
      ? browseProjectId : ""
    : browseProjectId;
  const attachedDaemonId = workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId ?? null;
  const statsScope = useMemo(() => resolveStatsProjectScope({
    attachedDaemonId,
    logicalProjects: displayedLogicalProjects,
    projects: explorer.projects,
    selectedProjectIds: selectionProjectIds,
  }), [attachedDaemonId, displayedLogicalProjects, explorer.projects, selectionProjectIds]);
  const browseSessionController = useMemo(() => new WorkbenchBrowseSessionController({
    mutate: async (action, input) => {
      if (!controls) return {};
      return await controls.daemon.browse.sessions[action](input);
    },
    read: async (projectId) => {
      if (!controls) return [];
      const payload = await controls.daemon.browse.sessions.read({
        cwd: null,
        includeRuntime: true,
        projectId,
        threadId: null,
        timeoutMs: 5_000,
      });
      return payload.sessions;
    },
  }), [controls]);
  useEffect(() => () => {
    browseSessionController.dispose();
  }, [browseSessionController]);
  useEffect(() => {
    browseSessionController.selectProject(attachedProjectId);
  }, [attachedProjectId, browseSessionController]);
  const routeProviderTarget = route.view === "thread" && route.threadTarget?.kind === "provider" ? route.threadTarget : null;
  const routeSubagent = useThread.subagent(routeProviderTarget?.threadId ?? null, routeProviderTarget?.harness, workbenchClient);
  useEffect(() => {
    if (route.view !== "thread" || route.threadTarget?.kind !== "provider") return;
    const providerTarget = route.threadTarget;
    const relationship = routeSubagent;
    const parentThreadId = relationship ? ThreadReferenceSchema.parse(relationship.parentThreadId) : null;
    if (!relationship || !parentThreadId) return;
    const ownerProjectId = route.threadOwnerProjectId || route.projectId;
    const target = {
      harness: relationship.harness,
      kind: "subagent" as const,
      parentThreadId,
      threadId: providerTarget.threadId,
    };
    if (route.logical) {
      navigateToRoute(createLogicalExistingThreadRoute(route.logical.projectId, target,
        route.logical.browseLocation ?? null), { replace: true });
      return;
    }
    navigateToRoute(!route.projectId
      ? createHomeThreadRoute(ownerProjectId, target)
      : ownerProjectId === route.projectId
        ? createThreadRoute(route.projectId, target)
        : createPinnedThreadRoute(route.projectId, ownerProjectId, target), { replace: true });
  }, [routeSubagent, navigateToRoute, route]);
  const isProjectIdentityLoading = Boolean(route.projectId) && route.projectId !== explorer.currentProjectId;
  const isProjectTreeLoading = isProjectIdentityLoading || (explorer.isProjectLoading && explorer.tree.length === 0);
  const currentProjectDisplayName = currentProject
    ? `${currentProject.name || currentProject.id}${currentProject.kind === "workspace" ? " workspace" : ""}`
    : null;
  const viewedProjectDisplayName = route.logical
    ? selectedLogicalProject?.displayName ?? selectedLogicalProject?.label ?? null
    : currentProjectDisplayName ?? explorer.root ?? explorer.currentProjectId;
  const pageTitle = formatWorkbenchPageTitle(viewedProjectDisplayName);
  const settingsLogicalProjectId = route.logical?.threadOwnerProjectId ?? route.logical?.projectId
    ?? (selectionProjectIds.length === 1
      ? displayedLogicalProjects?.find(project => project.id === selectionProjectIds[0])?.id ?? null
      : null);
  const shellSettings = useSettings(settingsLogicalProjectId);
  const browseSettings = useSettings.forLocation(browseLocation, workbenchClient);
  const settingsFallbackTarget = route.view === "mosaic"
    ? getRouteMosaicFallbackTarget(routeMosaicNodeForControls, isMobileMosaicRoute) : null;
  const settingsFileLocation = settingsFallbackTarget?.kind === "file" ? settingsFallbackTarget.source?.location ?? null
    : route.view === "file" ? workbenchClient.mounted?.projectNavigator.fileLocationFor(route) ?? null : null;
  const fileSettings = useSettings.forLocation(settingsFileLocation, workbenchClient);
  const settingsThreadTarget = settingsFallbackTarget?.kind === "thread" ? settingsFallbackTarget.target : route.threadTarget;
  const threadSettings = useSettings.forThread(settingsThreadTarget?.kind === "new" && currentThread?.isDraft
    ? { kind: "draft", draftId: DraftIdSchema.parse(currentThread.id) } : settingsThreadTarget,
  settingsFallbackTarget?.kind === "thread" ? settingsFallbackTarget.source?.location ?? null
    : routeLaunchLocation ?? route.logical?.location ?? browseLocation, workbenchClient);
  const activeSettings = route.view === "file" || settingsFallbackTarget?.kind === "file" ? fileSettings
    : route.view === "thread" || settingsFallbackTarget?.kind === "thread" ? threadSettings : shellSettings;
  const fontSizeScopeKey = activeSettings.unavailable("editorFontSize") ? "unavailable" : activeSettings.projectId ?? "global";
  const [editorFontSizePreview, setEditorFontSizePreview] = useState<{ scope: string; value: number } | null>(null);
  const previewEditorFontSize = useCallback((value: number | null) => {
    setEditorFontSizePreview(value === null ? null : { scope: fontSizeScopeKey, value });
  }, [fontSizeScopeKey]);
  const displayedFontSizePreview = editorFontSizePreview?.scope === fontSizeScopeKey
    ? editorFontSizePreview?.value : undefined;
  const showUnopenableFiles = browseSettings.get("showUnopenableFiles");
  const visibleTree = useMemo(
    () => {
      if (isProjectTreeLoading) {
        return [];
      }

      return showUnopenableFiles ? explorer.tree : filterVisibleTreeNodes(explorer.tree);
    },
    [explorer.tree, isProjectTreeLoading, showUnopenableFiles],
  );
  const projectTabLabel = getProjectTabLabel(viewedProjectDisplayName);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    const storedHarness = clientState.records.find((record) => (
      record.kind === "globalPreference" && record.preference.key === "harness"
    ));
    if (storedHarness?.kind === "globalPreference" && typeof storedHarness.preference.value === "string") {
      setHarness(storedHarness.preference.value as WorkbenchHarness);
    }
  }, [clientState.records]);

  const closeCreateDialog = () => {
    if (isCreatingEntry) {
      return;
    }

    setIsCreateDialogOpen(false);
    setCreateDialogParentPath("");
    setCreateEntryName("");
    setCreateDialogError("");
  };

  const openCreateDialog = (parentPath: string) => {
    setIsCreateDialogOpen(true);
    setCreateDialogParentPath(parentPath);
    setCreateEntryName("");
    setCreateDialogError("");
  };

  const theme = shellSettings.get("theme");
  useEffect(() => {
    document.documentElement.dataset.workbenchTheme = theme;
  }, [theme]);

  const updateEditorFontSize = useCallback((fontSize: number) => {
    if (activeSettings.unavailable("editorFontSize")) return;
    const settings = activeSettings.overridden("editorFontSize") ? activeSettings : globalSettings;
    void settings.set("editorFontSize", fontSize).catch((error: Error) => setSelectionError(error.message));
  }, [activeSettings, globalSettings]);

  const statsTab = route.view === "stats" ? route.statsTab ?? "usage" : "usage";
  // Threads on another machine open by id through their logical project, which knows every location.
  const statsThreadRoute = useCallback((thread: { projectId: string; threadId: string }, logicalProjectId: string | null) => {
    const reference = ThreadReferenceSchema.safeParse(thread.threadId).data;
    return logicalProjectId && reference
      ? createLogicalExistingThreadRoute(logicalProjectId, { kind: "provider", threadId: reference })
      : createThreadRoute(thread.projectId, thread.threadId);
  }, []);

  // The new-thread composer in that project takes the references and saves them as an ordinary draft.
  const askAgentWithReferences = useCallback((projectId: string, references: readonly PresentationDraftReference[]) => {
    seedNewThreadReferences(projectId, references);
    navigateToRoute(createThreadRoute(projectId, { kind: "new" }));
  }, [navigateToRoute]);

  const onInvalidFileLocation = useCallback(() => {
    setSelectionError("The thread's file location is invalid.");
  }, []);
  const browseFileScope = useMemo(() => ({
    daemon: browseDaemon,
    daemonId: browseLocation?.daemonId,
    projectId: browseProjectId,
  }), [browseDaemon, browseLocation?.daemonId, browseProjectId]);
  const fileOpenPolicyFor = useSettings.fileOpenPolicy(workbenchClient);
  const openFileByPolicy = useFileActions({
    policyFor: fileOpenPolicyFor,
    browseLocation,
    currentProjectId: explorer.currentProjectId,
    defaultDaemon: controls?.daemon ?? null,
    logicalProjects: logicalProjects,
    navigateToRoute,
    onInvalidLocation: onInvalidFileLocation,
    route,
    selectedDaemon: selectedDaemon ?? null,
  });

  const openFileFromExplorer = useCallback(async (path: string) => (
    await openFileByPolicy({ path, projectId: explorer.currentProjectId || route.projectId })
  ), [explorer.currentProjectId, openFileByPolicy, route.projectId]);

  const openThreadFromExplorer = useCallback(async (target: WorkbenchThreadTarget, ownerProjectId?: string) => {
    const viewedProjectId = explorer.currentProjectId || route.projectId;
    const targetProjectId = ownerProjectId ?? viewedProjectId;
    if (route.view === "thread" && route.projectId === viewedProjectId && (route.threadOwnerProjectId || route.projectId) === targetProjectId && route.threadTarget && areDeeplyEqual(route.threadTarget, target)) {
      return true;
    }

    if (route.logical && (target.kind === "provider" || target.kind === "subagent")) {
      navigateToRoute(createLogicalExistingThreadRoute(route.logical.projectId, target,
        route.logical.browseLocation ?? null));
      return true;
    }
    if (route.logical && (target.kind === "new" || target.kind === "draft")) {
      const owner = logicalProjects?.find(project =>
        project.id === route.logical?.threadOwnerProjectId
        || project.id === route.logical?.projectId
        || project.locations.some(location => location.target.projectId === targetProjectId));
      if (!owner) return false;
      navigateToRoute(createLogicalThreadRoute(route.logical.projectId, owner.id, null, target));
      return true;
    }
    navigateToRoute(!viewedProjectId
      ? createHomeThreadRoute(targetProjectId, target)
      : targetProjectId === viewedProjectId
        ? createThreadRoute(viewedProjectId, target)
        : createPinnedThreadRoute(viewedProjectId, targetProjectId, target));
    return true;
  }, [explorer.currentProjectId, navigateToRoute, route]);
  /** The new-thread composer for the selection's preferred launch target: where Workbench starts when nothing is open. */
  const newThreadRoute = useCallback((): WorkbenchRoute | null => {
    if (workbenchClient.mounted?.presentationClient) {
      const presentation = workbenchClient.mounted.presentationClient.snapshot().data;
      const preferred = presentation
        ? preferredSelectedLaunchTarget(logicalProjects, selectionProjectIds, presentation)
        : null;
      return preferred?.project && preferred.location
        ? createLogicalThreadRoute(preferred.project.id, preferred.project.id, preferred.location, { kind: "new" })
        : null;
    }
    return selectedPhysicalProjects[0] ? createThreadRoute(selectedPhysicalProjects[0].id, { kind: "new" }) : null;
  }, [logicalProjects, selectedPhysicalProjects, selectionProjectIds, workbenchClient.mounted]);
  const searchActionContext = useMemo<WorkbenchActionContext>(() => ({
    createThread: () => {
      const destination = newThreadRoute();
      if (destination) navigateToRoute(destination);
    },
    getSidebarThreadLinks: () => Array.from(document.querySelector("aside")?.querySelectorAll<HTMLElement>("[data-workbench-sidebar-thread-link='true']") ?? [])
      .filter((link) => !link.closest("[hidden]")),
    hasDesktopSidebar: !isMobile,
    hasProject: Boolean(viewedProjectId),
    home: () => navigateToRoute(createHomeRoute()),
    openSearch: () => search.open(),
    openSettings: () => navigateToRoute(createSettingsRoute("")),
    toggleSidebar: () => {
      if (!isMobile) sidebarPreferences.set("sidebarCollapsed", !isEffectiveDesktopSidebarCollapsed);
    },
    zoomIn: () => updateEditorFontSize(activeSettings.get("editorFontSize") + 0.08),
    zoomOut: () => updateEditorFontSize(activeSettings.get("editorFontSize") - 0.08),
  }), [isEffectiveDesktopSidebarCollapsed, isMobile, navigateToRoute, newThreadRoute, activeSettings, search,
    sidebarPreferences, updateEditorFontSize, viewedProjectId]);
  useWorkbenchSearch.onActivate((result) => {
    switch (result.kind) {
      case "action":
        runWorkbenchAction(result.actionId, searchActionContext);
        break;
      case "project":
        navigateToRoute(result.logicalProjectId
          ? createLogicalProjectRoute(result.logicalProjectId)
          : createProjectRoute(result.projectId));
        break;
      case "projectSetting": {
        const logicalProjectId = result.logicalProjectId
          ?? displayedLogicalProjects?.find(project => project.locations.some(location =>
            location.target.projectId === result.projectId))?.id;
        navigateToRoute(withProjectSelection(createSettingsRoute(""),
          logicalProjectId ? [logicalProjectId] : null), { selection: "exact" });
        break;
      }
      case "thread":
        if (result.logicalProjectId) {
          navigateToRoute(createLogicalExistingThreadRoute(result.logicalProjectId,
            { kind: "provider", harness: result.harnessId as WorkbenchHarness,
              threadId: ThreadReferenceSchema.parse(result.threadId) }));
          break;
        }
        void openThreadFromExplorer({
          harness: result.harnessId as WorkbenchHarness,
          kind: "provider",
          threadId: ThreadReferenceSchema.parse(result.threadId),
        }, result.projectId);
        break;
      case "file":
        if (result.source && result.logicalProjectId) {
          navigateToRoute(createLogicalFileRoute(result.logicalProjectId, result.source, result.path));
          break;
        }
        void openFileByPolicy({ path: result.path, projectId: result.projectId });
        break;
    }
  });
  useWorkbenchSearch.scope(viewedProjectId || null);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      handleWorkbenchActionShortcut(event, searchActionContext);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchActionContext]);
  const sendThreadMessage = useCallback(async (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => {
    if (!controls) {
      throw new ThreadMessageNotSentError();
    }
    const submittedRoute = currentRouteRef.current;
    const sourceContext = workbenchClient.mounted?.threadContextFor(thread.id)
      ?? workbenchClient.mounted?.draftContextFor(thread.id);
    const submissionProfiles = sourceContext
      ? profileControllerFor(sourceContext.daemonId) : composerProfileController;
    const isActiveSteer = !thread.isDraft && isThreadStatusActive(thread.status);
    if (options?.composerProfileSlot && !isActiveSteer) {
      await submissionProfiles.waitForSelection(options.composerProfileSlot);
      if (options.selectThread !== false && currentRouteRef.current !== submittedRoute) {
        throw new ThreadMessageNotSentError();
      }
      thread = submissionProfiles.resolveThread(options.composerProfileSlot, thread);
    }
    const submittedOptions = isActiveSteer
      ? { ...options, composerProfileSlot: undefined } : options;
    const replaceMosaicDraftThread = (materializedThread: Pick<ThreadPayload, "id" | "harness">) => {
      workspaceController.removeDraftThreads(thread.id);

      const currentRoute = currentRouteRef.current;
      if (currentRoute.view === "mosaic"
        && currentRoute.mosaicNode
        && materializedThread.id !== thread.id
        && mosaicContainsThreadTarget(currentRoute.mosaicNode, thread.id)
      ) {
        const nextNode = replaceWorkbenchMosaicTarget(
            currentRoute.mosaicNode,
            { kind: "thread", target: { kind: "draft", draftId: DraftIdSchema.parse(thread.id) } },
            { kind: "thread", target: { harness: materializedThread.harness, kind: "provider", threadId: ThreadReferenceSchema.parse(materializedThread.id) } },
          );
        navigateToRoute(currentRoute.logical?.projectId
          ? createLogicalMosaicRoute(currentRoute.logical.projectId, nextNode)
          : createMosaicRoute(currentRoute.projectId, nextNode), { replace: true });
        return true;
      }

      return false;
    };

    const replaceCurrentDraftThreadRoute = (materializedThread: Pick<ThreadPayload, "id" | "harness">) => {
      if (materializedThread.id === thread.id) {
        return false;
      }

      if (replaceMosaicDraftThread(materializedThread)) {
        return true;
      }

      const currentRoute = currentRouteRef.current;
      if (!isWorkbenchRouteOwnerOfThread(currentRoute, thread.id, thread.isDraft)) {
        return false;
      }

      if (currentRoute.logical) {
        navigateToRoute(createLogicalExistingThreadRoute(
          currentRoute.logical.projectId,
          { kind: "provider", harness: materializedThread.harness,
            threadId: ThreadReferenceSchema.parse(materializedThread.id) },
          currentRoute.logical.browseLocation ?? null,
        ), { replace: true });
        return true;
      }
      const ownerProjectId = currentRoute.threadOwnerProjectId || currentRoute.projectId;
      navigateToRoute(!currentRoute.projectId
        ? createHomeThreadRoute(ownerProjectId, materializedThread.id)
        : ownerProjectId === currentRoute.projectId
          ? createThreadRoute(currentRoute.projectId, materializedThread.id)
          : createPinnedThreadRoute(currentRoute.projectId, ownerProjectId, materializedThread.id), { replace: true });
      return true;
    };

    const materializedOptions: WorkbenchSendThreadMessageOptions | undefined = thread.isDraft
      ? {
        ...submittedOptions,
        onThreadLaunched: (materializedThread) => {
          if (options?.stayInCreate) {
            const current = currentRouteRef.current;
            const ownsDraft = current.view === "mosaic"
              ? Boolean(current.mosaicNode && mosaicContainsThreadTarget(current.mosaicNode, thread.id))
              : isWorkbenchRouteOwnerOfThread(current, thread.id, true)
                && workbenchClient.mounted?.threadRuntime.getSnapshot().currentThread?.id === thread.id;
            if (ownsDraft) {
              const nextId = DraftIdSchema.parse(crypto.randomUUID());
              threadViewInstanceKeysByThreadIdRef.current.set(nextId,
                threadViewInstanceKeysByThreadIdRef.current.get(thread.id) ?? thread.id);
              const nextRoute = controls.continueThreadCreation(DraftIdSchema.parse(thread.id), nextId);
              if (nextRoute) {
                workspaceController.removeDraftThreads(thread.id);
                navigateToRoute(nextRoute, { replace: true });
              } else {
                threadViewInstanceKeysByThreadIdRef.current.delete(nextId);
              }
            }
            options.onThreadLaunched?.(materializedThread);
            return;
          }
          threadViewInstanceKeysByThreadIdRef.current.set(
            materializedThread.id,
            threadViewInstanceKeysByThreadIdRef.current.get(thread.id) ?? thread.id,
          );
          replaceCurrentDraftThreadRoute(materializedThread);
          options?.onThreadLaunched?.(materializedThread);
        },
      }
      : submittedOptions;
    // Drafts launch with their saved attachments; existing threads send through their own store.
    return await controls.sendThreadMessage(thread, input, materializedOptions);
  }, [composerProfileController, controls, navigateToRoute, profileControllerFor, workbenchClient.mounted, workspaceController]);

  const activeSidebarDraftId = route.view === "thread" && route.threadTarget?.kind === "draft"
    ? route.threadTarget.draftId
    : "";
  const activeSidebarDraft = useThreads.draft(selectedThreadProjectId, activeSidebarDraftId, workbenchClient);
  const selectedPinnedThreadDraft = route.view === "thread"
    && route.threadTarget?.kind === "draft"
    && route.threadOwnerProjectId
    && route.threadOwnerProjectId !== route.projectId
    ? controls?.getSelectedThreadDraft() ?? null
    : null;
  const activeRouteDraft = selectedPinnedThreadDraft ?? activeSidebarDraft;

  const getThreadComposerDraftForTarget = useCallback((target: WorkbenchThreadTarget | null | undefined): WorkbenchComposerInputDraft | null => {
    if (!target || target.kind === "new") return null;
    if (target.kind === "provider" || target.kind === "subagent") return threadComposerDraftsByThreadId[target.threadId] ?? null;
    if (workbenchClient.mounted?.presentationClient) {
      return presentationDraftToInput(workbenchClient.mounted.presentationClient, target.draftId);
    }
    return null;
  }, [threadComposerDraftsByThreadId, workbenchClient.mounted]);

  const activeThreadComposerDraft = getThreadComposerDraftForTarget(route.view === "thread" ? route.threadTarget : null);

  const getComposerDraftTarget = useCallback((projectId: string, threadId: string, originTarget?: WorkbenchThreadTarget): ComposerDraftTarget => {
    if (!projectId) throw new Error("The composer draft has no project identity.");
    const ownerProjectId = ProjectIdSchema.parse(projectId);
    if (originTarget?.kind !== "new" && originTarget?.kind !== "draft") {
      const ownerIdentity = workbenchClient.mounted?.threadDraftIdentityFor(threadId);
      if (!ownerIdentity) throw new Error("The thread daemon is not registered in app state.");
      return { kind: "thread", daemonRegistrationId: ownerIdentity.daemonRegistrationId,
        projectId: ownerIdentity.projectId,
        threadId: ThreadReferenceSchema.parse(threadId) };
    }
    const draftId = originTarget.kind === "draft" ? originTarget.draftId : DraftIdSchema.parse(threadId);
    if (!draftId || !controls) throw new Error("The new-thread draft owner is unavailable.");
    const isNew = originTarget.kind === "new";
    {
      const findPaneSource = (node: WorkbenchMosaicNode | null): WorkbenchMosaicPanelTarget["source"] | null => {
        if (!node) return null;
        if (node.type === "split") {
          for (const child of node.children) {
            const found = findPaneSource(child);
            if (found) return found;
          }
          return null;
        }
        return node.target.kind === "thread" && node.target.target.kind === "draft"
          && node.target.target.draftId === draftId
          ? node.target.source ?? null : null;
      };
      const paneSource = findPaneSource(route.mosaicNode);
      const owner = workbenchClient.mounted?.presentationClient;
      const location = paneSource?.location
        ?? workbenchClient.mounted?.draftLocationFor(draftId)
        ?? route.logical?.location;
      if (!location || !owner) throw new Error("The selected draft location is unavailable.");
      const logicalProjectId = paneSource?.logicalProjectId ?? route.logical?.threadOwnerProjectId
        ?? owner.snapshot().data?.locations.find(item => item.target.daemonId === location.daemonId
          && item.target.projectId === location.projectId)?.logicalProjectId;
      if (!logicalProjectId) throw new Error("This folder is waiting for its app project identity. Draft text remains local.");
      const draftThread = workspaceController.getSnapshot().draftThreadsById[draftId] ?? currentThread;
      const draftProfiles = profileControllerFor(location.daemonId);
      let placement: Extract<ComposerDraftTarget, { kind: "presentation" }>["placement"];
      if (originTarget.kind === "new" && originTarget.folderId && !owner.draft(draftId)) {
        const presentation = owner.snapshot().data;
        const folder = presentation && projectLogicalThreadDisplayOrder(
          logicalProjectId, workbenchClient.mounted?.threadSidebar.getListing?.().rows ?? [], presentation,
        ).folders?.find(item => item.folderId === originTarget.folderId);
        if (!folder || folder.section === "settled") throw new Error("The draft folder is unavailable. Draft text remains local.");
        placement = { folderId: folder.folderId, priority: folder.section };
      }
      return {
        kind: "presentation", draftId, isNew, logicalProjectId, location, owner, placement,
        selection: () => {
          const slot = isNew
            ? { kind: "new-thread" as const, projectId: ownerProjectId }
            : { kind: "draft" as const, projectId: ownerProjectId, draftId,
              harness: draftThread?.harness ?? defaultProviderKey };
          return draftProfiles.getDraftSelection(slot, {
            agentPath: draftThread?.agentPath ?? null, agentSource: null,
            harness: draftThread?.harness ?? defaultProviderKey, model: draftThread?.model ?? "",
            reasoningEffort: draftThread?.reasoningEffort ?? null,
            serviceTier: draftThread?.serviceTier === "fast" ? "fast" : null,
            contextWindowTokens: draftThread?.contextWindowTokens ?? null,
          });
        },
        materialize: () => {
          const current = currentRouteRef.current;
          if (current.view !== "thread" || current.threadTarget?.kind !== "new"
            || !current.logical
            || (current.logical.threadOwnerProjectId
              ? current.logical.threadOwnerProjectId !== logicalProjectId
              : current.logical.location?.daemonId !== location.daemonId
                || current.logical.location.projectId !== location.projectId)
            || workbenchClient.mounted?.threadRuntime.getSnapshot().currentThread?.id !== draftId) return;
          navigateToRoute(createLogicalThreadRoute(current.logical.threadOwnerProjectId
            ? current.logical.projectId : logicalProjectId,
            logicalProjectId, null, { draftId, kind: "draft" }), { replace: true });
        },
        dematerialize: () => {
          const current = currentRouteRef.current;
          if (current.view !== "thread" || current.threadTarget?.kind !== "draft"
            || current.threadTarget.draftId !== draftId || !current.logical
            || current.logical.threadOwnerProjectId !== logicalProjectId) return;
          navigateToRoute(createLogicalThreadRoute(current.logical.projectId,
            logicalProjectId, current.logical.location ?? location, { kind: "new" }), { replace: true });
        },
      };
    }
  }, [controls, currentThread, navigateToRoute, profileControllerFor, route, workbenchClient, workspaceController]);

  const handleThreadComposerDraftChange = useCallback(async (
    projectId: string, threadId: string, update: (draft: WorkbenchComposerInputDraft) => WorkbenchComposerInputDraft,
    reason: "autosave" | "submission" | "retarget" = "autosave", target?: WorkbenchThreadTarget, detached = false,
  ) => {
    try {
      const draftTarget = getComposerDraftTarget(projectId, threadId, target);
      const profiles = draftTarget.kind === "presentation"
        ? profileControllerFor(draftTarget.location.daemonId) : composerProfileController;
      if (draftTarget.kind === "presentation" && draftTarget.isNew) {
        await profiles.waitForSelection({ kind: "new-thread", projectId: draftTarget.location.projectId });
      }
      if (draftTarget.kind === "presentation" && !draftTarget.isNew) {
        await profiles.waitForSelection({
          kind: "draft", projectId: draftTarget.location.projectId,
          draftId: draftTarget.draftId, harness: currentThread?.harness ?? defaultProviderKey,
        });
      }
      return await saveComposerDraft(clientStateController, draftTarget, update, { reason, detached });
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Unable to save composer draft.");
      throw error;
    }
  }, [clientStateController, composerProfileController, currentThread?.harness, getComposerDraftTarget, profileControllerFor]);

  const handleThreadComposerDraftClear = useCallback(async (projectId: string, threadId: string, target?: WorkbenchThreadTarget) => {
    try {
      await clearComposerDraft(clientStateController, getComposerDraftTarget(projectId, threadId, target));
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Unable to clear composer draft.");
      throw error;
    }
  }, [clientStateController, getComposerDraftTarget]);

  const handleAttachFeedbackToThread = useCallback(async (
    ownerProjectId: string,
    target: WorkbenchThreadTarget,
    reference: WorkbenchThreadAddressedFeedback,
  ) => {
    if (clientState.schemaVersion < appStateReleases.composerDraftReferences.version) {
      throw new Error("Restart Workbench to attach feedback to an existing thread.");
    }
    if (target.kind === "new") throw new Error("Feedback needs a concrete thread composer.");
    const threadId = target.kind === "draft" ? target.draftId : target.threadId;
    await handleThreadComposerDraftChange(
      ownerProjectId,
      threadId,
      draft => attachComposerDraftReference(draft, reference),
      "autosave",
      target,
      true,
    );
  }, [clientState.schemaVersion, handleThreadComposerDraftChange]);

  const setThreadComposerSettings = useCallback((threadId: string, settings: WorkbenchComposerSettings) => {
    if (currentThread?.id === threadId && currentThread.isDraft && currentThread.harness !== settings.harness) {
      void clientStateController.put({
        kind: "globalPreference",
        preference: { key: "harness", value: settings.harness },
      }).catch((error: Error) => setSelectionError(error.message));
      setHarness(settings.harness);
    }
    controls?.setCurrentThreadComposerSettings(threadId, settings);
  }, [clientStateController, controls, currentThread]);

  const workbenchControls = useMemo<WorkbenchControls | null>(() => {
    if (!controls) {
      return null;
    }

    return {
      ...controls,
      openFile: openFileFromExplorer,
      openThread: openThreadFromExplorer,
    };
  }, [controls, openFileFromExplorer, openThreadFromExplorer]);

  const createDialogParentLabel = createDialogParentPath || "project";
  const canOpenFileFromExplorer = useCallback((path: string) => (
    resolveFileOpenDestination({ path }, fileOpenPolicyFor(browseLocation)) !== null
  ), [browseLocation, fileOpenPolicyFor]);
  const mobileMosaicFallbackTarget = route.view === "mosaic"
    ? getRouteMosaicFallbackTarget(route.mosaicNode, isMobile)
    : null;
  const showMosaicView = route.view === "mosaic" && !mobileMosaicFallbackTarget;
  const showThreadView = route.view === "thread" || mobileMosaicFallbackTarget?.kind === "thread";
  const showFileView = route.view === "file" || mobileMosaicFallbackTarget?.kind === "file";
  // New full-page views belong in workbenchRouteViews, not new show* booleans; settings/stats/git should migrate there.
  const routeView = workbenchRouteViews[route.view] ?? null;
  const showSettingsView = route.view === "settings";
  useEffect(() => { if (!showSettingsView) setSettingsTarget(null); }, [showSettingsView]);
  const selectedSettingsProject = selectionProjectIds.length === 1
    ? displayedLogicalProjects?.find(project => project.id === selectionProjectIds[0]) ?? null
    : null;
  /** The sidebar's project selection bounds what settings can reach; no selection reaches every project. */
  const settingsReachableProjects = selectionProjectIds.length
    ? (displayedLogicalProjects ?? []).filter(project => selectionProjectIds.includes(project.id))
    : displayedLogicalProjects ?? [];
  const showStatsView = route.view === "stats";
  const showGitView = route.view === "git";
  const showFullBleedMainView = showMosaicView;
  const createThreadFromSidebar = useCallback((ownerProjectId: string, options?: {
    folderId?: FolderId;
    location?: ProjectLocationReference;
  }) => {
    if (showMosaicView || !controls) return;
    const target = options?.folderId
      ? { folderId: options.folderId, kind: "new" as const }
      : { kind: "new" as const };
    if (workbenchClient.mounted?.presentationClient) {
      if (!logicalProjects?.length) {
        setSelectionError("Project identities are not ready yet.");
        return;
      }
      const selected = options?.location
        ? logicalProjects.find(project => project.locations.some(location =>
          location.target.daemonId === options.location?.daemonId
          && location.target.projectId === options.location.projectId))
        : route.logical?.projectId
        ? logicalProjects.find(project => project.id === route.logical?.projectId)
        : logicalProjects.find(project => project.id === ownerProjectId)
          ?? logicalProjects.find(project => project.locations.some(location =>
          location.target.projectId === ownerProjectId
          && location.daemonId === workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId))
          ?? logicalProjects.find(project => project.locations.some(location =>
            location.target.projectId === ownerProjectId))
          ?? selectedLogicalProjects[0];
      if (selected) {
        const location = options?.location
          ?? (route.logical?.projectId === selected.id ? route.logical.location
            ?? selected.locations.find(item => item.project)?.target
            ?? selected.locations[0]?.target ?? null
          : selected.locations.find(item => item.project)?.target
            ?? selected.locations[0]?.target ?? null);
        if (!location) {
          setSelectionError("No daemon folder for this project is available.");
          return;
        }
        navigateToRoute(createLogicalThreadRoute(route.logical?.projectId ?? null, selected.id, location, target));
        return;
      }
      setSelectionError("Choose an available project before creating a thread.");
      return;
    }
    navigateToRoute(!route.projectId
      ? createHomeThreadRoute(ownerProjectId, target)
      : createThreadRoute(ownerProjectId, target));
  }, [controls, logicalProjects, navigateToRoute, route, selectedLogicalProjects, showMosaicView, workbenchClient.mounted]);
  const handleThreadSettled = useCallback((settledTarget: WorkbenchThreadTarget, ownerProjectId?: string) => {
    const currentRoute = currentRouteRef.current;
    if (currentRoute.view !== "thread"
      || (!currentRoute.logical && ownerProjectId
        && (currentRoute.threadOwnerProjectId || currentRoute.projectId) !== ownerProjectId)
      || !isWorkbenchThreadTargetSelected(settledTarget, currentRoute.threadTarget)) {
      return;
    }
    navigateToRoute(createSettledThreadExitRoute(currentRoute, ownerProjectId ?? ""));
  }, [navigateToRoute]);
  const handleComposerThreadSettled = useCallback((settledTarget: WorkbenchThreadTarget, ownerProjectId: string) => {
    const currentRoute = currentRouteRef.current;
    if (currentRoute.view !== "thread"
      || (!currentRoute.logical
        && (currentRoute.threadOwnerProjectId || currentRoute.projectId) !== ownerProjectId)
      || !isWorkbenchThreadTargetSelected(settledTarget, currentRoute.threadTarget)) {
      return;
    }
    createThreadFromSidebar(ownerProjectId);
  }, [createThreadFromSidebar]);
  const effectiveThreadTarget = mobileMosaicFallbackTarget?.kind === "thread" ? mobileMosaicFallbackTarget.target : route.threadTarget;
  const effectiveThreadId = effectiveThreadTarget ? getWorkbenchThreadTargetRootId(effectiveThreadTarget) : route.threadId;
  const effectiveSelectedThreadId = effectiveThreadTarget ? getWorkbenchThreadTargetSelectedId(effectiveThreadTarget) : effectiveThreadId;
  const effectiveFilePath = mobileMosaicFallbackTarget?.kind === "file" ? mobileMosaicFallbackTarget.filePath : route.filePath;
  const showSvgFileView = showFileView && isSvgFile(effectiveFilePath);
  const svgFileLocation = showSvgFileView
    ? (mobileMosaicFallbackTarget?.kind === "file" ? mobileMosaicFallbackTarget.source?.location : undefined)
      ?? workbenchClient.mounted?.projectNavigator.fileLocationFor(route) ?? null
    : null;
  const showEmptyState = !showThreadView && !showFileView && !showSettingsView && !showStatsView && !showMosaicView && !showGitView && !routeView;
  const showRouteError = Boolean(selectionError) && !showThreadView && !showFileView && !showSettingsView && !showStatsView && !showMosaicView && !showGitView && !routeView;
  if (currentThread) {
    retainedThreadRef.current = currentThread;
  }
  const retainedThread = retainedThreadRef.current;
  const effectiveThreadRoute = effectiveThreadTarget
    ? route.logical && (effectiveThreadTarget.kind === "provider" || effectiveThreadTarget.kind === "subagent")
      ? createLogicalExistingThreadRoute(route.logical.projectId, effectiveThreadTarget,
        route.logical.browseLocation ?? null)
      : route.view === "thread" && !route.projectId && route.threadOwnerProjectId
      ? createHomeThreadRoute(route.threadOwnerProjectId, effectiveThreadTarget)
      : route.view === "thread" && route.threadOwnerProjectId && route.threadOwnerProjectId !== route.projectId
        ? createPinnedThreadRoute(route.projectId, route.threadOwnerProjectId, effectiveThreadTarget)
        : createThreadRoute(activeProjectId, effectiveThreadTarget)
    : route;
  const getThreadViewInstanceKey = (threadId: string) => threadViewInstanceKeysByThreadIdRef.current.get(threadId) ?? threadId;
  const isThreadOwnedByEffectiveRoute = (thread: ThreadPayload | null) => Boolean(
    showThreadView
    && thread
    && (
      isWorkbenchRouteOwnerOfThread(effectiveThreadRoute, thread.id, thread.isDraft)
      || isWorkbenchRouteOwnerOfThread(effectiveThreadRoute, getThreadViewInstanceKey(thread.id), getThreadViewInstanceKey(thread.id) !== thread.id)
    )
  );
  const documentThreadForThreadView = showThreadView
    ? getThreadDocumentFromSnapshot(threadDocuments, effectiveThreadId)
    : null;
  const threadForThreadView = documentThreadForThreadView
    ?? (isThreadOwnedByEffectiveRoute(currentThread)
      ? currentThread
      : null)
    ?? (effectiveThreadTarget?.kind !== "new" && isThreadOwnedByEffectiveRoute(retainedThread)
      ? retainedThread
      : null);
  const handleSelectedThreadChange = useCallback((selectedThreadId: string) => {
    if (!effectiveThreadTarget || effectiveThreadTarget.kind === "new" || effectiveThreadTarget.kind === "draft") return;
    const rootThreadId = effectiveThreadTarget.kind === "subagent" ? effectiveThreadTarget.parentThreadId : effectiveThreadTarget.threadId;
    const harness = effectiveThreadTarget.harness ?? threadForThreadView?.harness;
    const target = selectedThreadId === rootThreadId
      ? { harness, kind: "provider" as const, threadId: rootThreadId }
      : { harness, kind: "subagent" as const, parentThreadId: rootThreadId, threadId: ThreadReferenceSchema.parse(selectedThreadId) };
    const ownerProjectId = route.view === "thread" ? route.threadOwnerProjectId || route.projectId : activeProjectId;
    if (route.logical) {
      navigateToRoute(createLogicalExistingThreadRoute(route.logical.projectId, target,
        route.logical.browseLocation ?? null));
      return;
    }
    navigateToRoute(!activeProjectId
      ? createHomeThreadRoute(ownerProjectId, target)
      : ownerProjectId === activeProjectId
        ? createThreadRoute(activeProjectId, target)
        : createPinnedThreadRoute(activeProjectId, ownerProjectId, target));
  }, [activeProjectId, effectiveThreadTarget, navigateToRoute, route, threadForThreadView?.harness]);
  const threadProjectId = routeThreadContext?.project.id ?? routeDraftContext?.project.id
    ?? (route.view === "thread" ? route.threadOwnerProjectId || route.projectId : route.projectId || activeProjectId);
  // Existing threads load inside their own view (thread store); only drafts and new threads wait for a document.
  const isThreadViewReady = showThreadView && (Boolean(threadForThreadView)
    || effectiveThreadTarget?.kind === "provider" || effectiveThreadTarget?.kind === "subagent");
  const isSelectionPending = !selectionError && showThreadView && !isThreadViewReady;
  const viewedThreadId = threadForThreadView?.id ?? effectiveThreadId;
  const threadViewInstanceKey = getThreadViewInstanceKey(viewedThreadId);
  const selectedThreadIdForView = effectiveThreadTarget?.kind === "new" && threadForThreadView
    ? threadForThreadView.id
    : effectiveSelectedThreadId;
  const activeThreadId = showThreadView ? threadViewInstanceKey : "";
  const activeFilePath = showFileView ? effectiveFilePath : "";
  // A thread launched from a draft keeps that draft's surface, even before its own document loads, so the view
  // instance (and its launch handoff) survives the route change.
  const retainsDraftSurface = effectiveThreadTarget?.kind === "new" || effectiveThreadTarget?.kind === "draft"
    || threadViewInstanceKey !== viewedThreadId;
  const threadSurfaceKey = retainsDraftSurface
    ? `draft:${threadViewInstanceKey}`
    : `${routeThreadContext?.daemonId ?? routeDraftContext?.daemonId ?? "attached"}:${threadProjectId}:${threadViewInstanceKey}`;
  const threadFileScope = useMemo(() => ({
    daemon: selectedDaemon,
    daemonId: routeThreadContext?.daemonId ?? routeDraftContext?.daemonId ?? routeLaunchLocation?.daemonId,
    projectId: threadProjectId,
  }), [selectedDaemon, routeThreadContext?.daemonId, routeDraftContext?.daemonId,
    routeLaunchLocation?.daemonId, threadProjectId]);
  const threadProject = routeThreadContext?.project ?? routeDraftContext?.project
    ?? explorer.projects.find((project) => project.id === threadProjectId) ?? null;
  const logicalThreadProject = logicalProjects?.find(project =>
    project.id === route.logical?.threadOwnerProjectId
    || routeOwnerMetadata && project.locations.some(location =>
      location.target.daemonId === routeOwnerMetadata.daemonId
      && location.target.projectId === routeOwnerMetadata.projectId)) ?? null;
  const logicalThreadDaemonProjectId = logicalThreadProject?.locations.some(location => location.project?.kind === "daemon")
    ? logicalThreadProject.id : null;
  const approvalModeSettings = useMemo(() => logicalThreadDaemonProjectId ? {
    onOpenSettings: () => {
      const daemonId = threadFileScope.daemonId;
      if (!daemonId) return;
      setSettingsTarget({ section: "settings-auto-approve", daemonId });
      navigateToRoute({
        ...withProjectSelection(createSettingsRoute(""), route.selectedProjectIds),
        folderAddress: route.folderAddress,
      }, { selection: "exact" });
    },
  } : null, [logicalThreadDaemonProjectId, navigateToRoute, route.selectedProjectIds, route.folderAddress, threadFileScope.daemonId]);
  const showThreadOwnerLabel = Boolean(routeOwnerMetadata
    && !(selectedLogicalProject?.id === logicalThreadProject?.id
      && selectedLogicalProject?.locations.length === 1));
  const isHomeDraftRoute = route.view === "thread"
    && !route.projectId
    && !route.logical?.projectId
    && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft");
  const homeDraftProjects = route.logical ? selectedLogicalProjects : selectedPhysicalProjects;
  const homeDraftProjectId = route.logical?.threadOwnerProjectId ?? threadProjectId;
  const moveHomeDraftProject = useCallback(async (nextProjectId: string) => {
    if (!controls || !isHomeDraftRoute) return;
    const nextProject = homeDraftProjects.find(({ id }) => id === nextProjectId);
    if (!homeDraftProjectId || !nextProject || nextProject.id === homeDraftProjectId) return;
    setIsProjectRotationPending(true);
    setSelectionError("");
    try {
      const target = route.threadTarget;
      if (route.logical) {
        const logicalProject = selectedLogicalProjects.find(project => project.id === nextProject.id);
        const destination = logicalProject?.locations.find(item => item.project)?.target;
        if (!logicalProject || !destination) throw new Error("That project's daemon folder is unavailable.");
        const draftSession = activeDraftSessionRef.current;
        const draftId = target?.kind === "draft" ? target.draftId
          : threadForThreadView?.isDraft ? DraftIdSchema.parse(threadForThreadView.id) : null;
        const owner = workbenchClient.mounted?.presentationClient;
        if (!draftSession || !draftId || !owner) throw new Error("The draft editor is unavailable.");
        await draftSession.retarget(draftSessionOwner(destination.projectId, draftId), async () => {
          if (!isSameDraftRouteIntent(route, currentRouteRef.current, draftId)) return false;
          const draft = owner.draft(draftId);
          if (draft) await controls.retargetPresentationDraft(draftId, destination, logicalProject.id);
          if (!isSameDraftRouteIntent(route, currentRouteRef.current, draftId)) return false;
          navigateToRoute(createLogicalThreadRoute(null, logicalProject.id, draft ? null : destination,
            draft ? { kind: "draft", draftId } : { kind: "new" }), { replace: Boolean(draft) });
          return true;
        });
        return;
      }
      if (!threadProjectId) return;
      const legacyNext = selectedPhysicalProjects.find(project => project.id === nextProject.id);
      if (!legacyNext) return;
      if (target?.kind === "draft") {
        await controls.moveThreadDraft(threadProjectId, legacyNext.id, target.draftId);
        navigateToRoute(createHomeThreadRoute(legacyNext.id, target));
      } else {
        navigateToRoute(createHomeThreadRoute(legacyNext.id, { kind: "new" }));
      }
    } catch (error) {
      setSelectionError((error instanceof Error ? error.message : "Unable to move this draft.").slice(0, 500));
    } finally {
      setIsProjectRotationPending(false);
    }
  }, [controls, homeDraftProjectId, homeDraftProjects, isHomeDraftRoute, navigateToRoute, route, selectedLogicalProjects,
    selectedPhysicalProjects, threadForThreadView, threadProjectId, workbenchClient.mounted]);
  const homeRotatorProject = route.logical ? logicalThreadProject
    : explorer.projects.find(project => project.id === threadProject?.id);
  const projectRotator = isHomeDraftRoute && homeRotatorProject ? (
    <WorkbenchProjectControl
      disabled={isProjectRotationPending || homeDraftProjects.length < 2}
      onSelect={projectId => { void moveHomeDraftProject(projectId); }}
      project={homeRotatorProject}
      projects={homeDraftProjects}
    />
  ) : null;
  const isForeignThreadProject = Boolean(threadProjectId && (threadProjectId !== browseProjectId
    || (routeThreadContext ?? routeDraftContext)
      && browseLocation?.daemonId !== (routeThreadContext ?? routeDraftContext)?.daemonId));
  const threadProjectRoots = isForeignThreadProject ? threadProject?.roots ?? [] : explorer.roots;
  const threadProjectRootPath = isForeignThreadProject ? threadProject?.rootPath ?? "" : explorer.rootPath;
  const threadProjectFileLinkRoots = useMemo(
    () => createProjectFileLinkRoots(explorer.projects, threadProjectId, threadProjectRoots),
    [explorer.projects, threadProjectId, threadProjectRoots],
  );
  const materializedThreadRootIds = useMemo(() => {
    if (showMosaicView) return getWorkbenchMosaicThreadRootIds(route.mosaicNode);
    const threadIds = new Set<string>();
    if (
      isThreadViewReady
      && effectiveThreadTarget
      && (effectiveThreadTarget.kind === "provider" || effectiveThreadTarget.kind === "subagent")
    ) {
      threadIds.add(getWorkbenchThreadTargetRootId(effectiveThreadTarget));
    }
    return threadIds;
  }, [effectiveThreadTarget, isThreadViewReady, route.mosaicNode, showMosaicView]);
  const renderThreadTooltipDetails = useCallback((entry: WorkbenchThreadSidebarEntry) => {
    if (entry.entryKind === "draft") return null;
    const threadId = entry.identity.threadId;
    const rootThreadId = entry.entryKind === "subagent" ? entry.parentThreadId : threadId;
    return (
      <WorkbenchThreadTooltipDetails
        harness={entry.identity.harness}
        materialized={materializedThreadRootIds.has(rootThreadId)}
        onQuestionnaireError={setSelectionError}
        fallbackProjectId={activeProjectId}
        threadId={threadId}
        parentThreadId={entry.entryKind === "subagent" ? entry.parentThreadId : undefined}
      />
    );
  }, [
    activeProjectId,
    materializedThreadRootIds,
  ]);
  const ambientCanvasVariant: WorkbenchAmbientCanvasVariant | null = theme === "magical-girl" || theme === "winter"
    ? theme
    : null;
  const shouldShowShellHeader = !showFullBleedMainView && (!isMobile || mobilePane === "editor");
  const mainPaneScrollKey = showThreadView
    ? `thread:${activeThreadId}`
    : showFileView
      ? `file:${activeFilePath}`
      : showSettingsView
        ? "settings"
        : showStatsView
          ? `stats:${route.projectId ?? "global"}`
        : routeView
          ? `route:${route.view}`
        : "";
  const routePanelTarget = useMemo<WorkbenchPanelTarget>(() => {
    if (showFileView) {
      return { filePath: effectiveFilePath, kind: "file" };
    }
    if (showThreadView) {
      return { kind: "thread", target: effectiveThreadTarget ?? { kind: "new" } };
    }
    if (showSettingsView) {
      return { kind: "settings" };
    }

    return { kind: "empty" };
  }, [effectiveFilePath, effectiveThreadTarget, showFileView, showSettingsView, showThreadView]);
  const navigateToPanelTarget = useCallback((target: WorkbenchPanelTarget, options?: { replace?: boolean }) => {
    if (target.kind === "file") {
      navigateToRoute(route.logical?.projectId
        ? createLogicalFileRoute(route.logical.projectId, browseLocation, target.filePath)
        : createFileRoute(explorer.currentProjectId || route.projectId, target.filePath), options);
      return;
    }
    if (target.kind === "thread") {
      navigateToRoute(route.logical?.projectId
        ? target.target.kind === "provider" || target.target.kind === "subagent"
          ? createLogicalExistingThreadRoute(route.logical.projectId, target.target, browseLocation ?? null)
          : createLogicalThreadRoute(route.logical.projectId, route.logical.projectId,
            null, target.target)
        : createThreadRoute(explorer.currentProjectId || route.projectId, target.target), options);
      return;
    }
    if (target.kind === "settings") {
      navigateToRoute(createSettingsRoute(""), options);
      return;
    }

    navigateToRoute(route.logical?.projectId
      ? createLogicalProjectRoute(route.logical.projectId)
      : createProjectRoute(explorer.currentProjectId || route.projectId), options);
  }, [browseLocation, explorer.currentProjectId, navigateToRoute, route]);
  const navigateToMosaicNode = useCallback((mosaicNode: WorkbenchMosaicNode, options?: { replace?: boolean }) => {
    if (!route.logical?.projectId) {
      navigateToRoute(createMosaicRoute(explorer.currentProjectId || route.projectId, mosaicNode), options);
      return;
    }
    const logicalProjectId = route.logical.projectId;
    const browseLocation = route.logical.browseLocation ?? route.logical.location;
    const withTargets = (node: WorkbenchMosaicNode): WorkbenchMosaicNode => {
      if (node.type === "split") return { ...node, children: node.children.map(withTargets) };
      if (node.target.kind === "thread"
        && (node.target.target.kind === "provider" || node.target.target.kind === "subagent")) {
        return { ...node, target: { ...node.target, source: undefined } };
      }
      if (node.target.source) return node;
      return { ...node, target: { ...node.target, source: {
        logicalProjectId, location: browseLocation ?? null,
      } } };
    };
    navigateToRoute(createLogicalMosaicRoute(logicalProjectId, withTargets(mosaicNode)), options);
  }, [explorer.currentProjectId, navigateToRoute, route]);
  workspaceController.setOptions({
    createDraft: (draftHarness) => {
      if (!controls) throw new Error("The Workbench client is not ready.");
      if (route.logical) {
        if (!browseLocation) throw new Error("Choose a daemon folder before creating a mosaic draft.");
        return controls.createThreadDraftAt(browseLocation, draftHarness, { select: false });
      }
      return controls.createThreadDraft(draftHarness);
    },
    navigateMosaic: navigateToMosaicNode,
    navigatePanel: navigateToPanelTarget,
    navigateProject: () => {
      navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
    },
  });
  useEffect(() => {
    workspaceController.select({
      isMobile,
      isPanelTargetDragActive: activeDragPayload?.type === "panel-target",
      mosaicNode: route.view === "mosaic" ? route.mosaicNode : null,
      routeTarget: routePanelTarget,
      showMosaic: showMosaicView,
    });
  }, [
    activeDragPayload?.type,
    isMobile,
    route.mosaicNode,
    route.view,
    routePanelTarget,
    showMosaicView,
    workspaceController,
  ]);
  const workspaceSnapshot = useSyncExternalStore(
    workspaceController.subscribe,
    workspaceController.getSnapshot,
    workspaceController.getSnapshot,
  );
  const routeMosaicProjection = workspaceSnapshot.routeProjection;
  const mosaicDraftThreadsById = workspaceSnapshot.draftThreadsById;
  const mainLayoutForRender = workspaceSnapshot.renderLayout;
  const topLeftMosaicPanelId = showMosaicView && mainLayoutForRender
    ? WorkbenchMainLayout.panels(mainLayoutForRender)[0]?.id
    : null;
  const shouldRenderMainLayout = Boolean(mainLayoutForRender);
  const isDirectThreadSurface = showThreadView && !shouldRenderMainLayout;
  const isDirectMobileThreadSurface = isMobile && isDirectThreadSurface;

  useEffect(() => {
    if (showMosaicView) controls?.watchRateLimits();
  }, [controls, showMosaicView]);

  const updateMainLayout = useCallback((nextLayout: WorkbenchMainLayoutState) => {
    workspaceController.updateLayout(nextLayout);
  }, [workspaceController]);

  const focusMainPanel = useCallback((panelId: string) => {
    workspaceController.focusPanel(panelId);
  }, [workspaceController]);

  const handleMainLayoutPanelDrop = useCallback((drop: { panelId: string; placement: WorkbenchDropPlacement }, payload: Extract<WorkbenchDragPayload, { readonly type: "new-thread" | "panel-target" | "thread-row" }>) => {
    if (payload.type !== "new-thread" || controls) workspaceController.dropPanel(drop, payload);
  }, [controls, workspaceController]);

  const updateMosaicPanelOptions = useCallback((panelId: string, options: { minimized?: boolean; zoomDelta?: number }) => {
    workspaceController.updatePanelOptions(panelId, options);
  }, [workspaceController]);

  const resizeMosaicSplit = useCallback((splitId: string, firstPercent: number) => {
    workspaceController.resizeSplit(splitId, firstPercent);
  }, [workspaceController]);

  const closeMosaicPanel = useCallback((target: WorkbenchPanelTarget) => {
    workspaceController.closePanel(target);
  }, [workspaceController]);

  const revealProjectEntry = useCallback(async (path: string) => {
    const projectId = explorer.currentProjectId || route.projectId;
    if (!projectId) {
      return;
    }

    setProjectActionError("");
    try {
      const request: RevealProjectEntryRequest = { path, projectId };
      if (!controls) throw new Error("The daemon is not ready.");
      await controls.daemon.nativeFiles.reveal(request);
    } catch (error) {
      setProjectActionError(error instanceof Error ? error.message : "Unable to show that entry in the file explorer.");
    }
  }, [controls, explorer.currentProjectId, route.projectId]);

  const closeDeletedFileViews = useCallback((filePath: string) => {
    workspaceController.closeFile(filePath);
    if (route.view === "file" && route.filePath === filePath) {
      navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
    }
  }, [explorer.currentProjectId, navigateToRoute, route, workspaceController]);

  const deleteProjectFile = useCallback(async (filePath: string, confirmUntracked = false) => {
    if (!controls || isDeletingFile) {
      return;
    }

    setIsDeletingFile(true);
    setDeleteDialogError("");
    setProjectActionError("");
    try {
      const result = await controls.deleteFile(filePath, { confirmUntracked });
      if (result.confirmationRequired) {
        setPendingDeleteFilePath(result.path);
        return;
      }

      setPendingDeleteFilePath("");
      closeDeletedFileViews(result.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete that file.";
      if (pendingDeleteFilePath) {
        setDeleteDialogError(message);
      } else {
        setProjectActionError(message);
      }
    } finally {
      setIsDeletingFile(false);
    }
  }, [closeDeletedFileViews, controls, isDeletingFile, pendingDeleteFilePath]);

  const closeDeleteFileDialog = useCallback(() => {
    if (isDeletingFile) {
      return;
    }
    setPendingDeleteFilePath("");
    setDeleteDialogError("");
  }, [isDeletingFile]);

  const getProjectNodeContextMenu = useCallback((node: TreeNode): WorkbenchContextMenuDefinition => ({
    id: `project-entry:${node.type}:${node.path}`,
    items: [
      {
        icon: <ExternalLinkIcon size={16} />,
        id: "reveal",
        label: "Show in File Explorer",
        onSelect: () => {
          void revealProjectEntry(node.path);
        },
      },
      ...(node.type === "file" ? [{
        icon: <BinIcon size={20} />,
        id: "delete",
        label: "Delete file",
        onSelect: () => {
          void deleteProjectFile(node.path);
        },
        tone: "danger" as const,
      }] : []),
    ],
    label: `${node.type === "file" ? "File" : "Folder"} actions for ${node.name}`,
  }), [deleteProjectFile, revealProjectEntry]);

  useEffect(() => {
    if (!isMobile || mobilePane !== "editor" || !mainPaneScrollKey || isDirectThreadSurface) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (mainPaneRef.current) {
        mainPaneRef.current.scrollTop = 0;
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isDirectThreadSurface, isMobile, mainPaneScrollKey, mobilePane]);

  const applyMobileShellHeaderEvent = useCallback((event: MobileShellHeaderEvent) => {
    if (!isMobile || !shouldShowShellHeader) return;
    mobileShellHeaderVisibility.apply(event);
  }, [isMobile, mobileShellHeaderVisibility, shouldShowShellHeader]);

  const handleThreadScrollIntent = useCallback((direction: "up" | "down", travelPx: number) => {
    applyMobileShellHeaderEvent({
      kind: "gesture",
      direction,
      travelPx,
    });
  }, [applyMobileShellHeaderEvent]);
  const handleThreadTouchActivity = useCallback((active: boolean) => {
    applyMobileShellHeaderEvent({ kind: "touch", active });
  }, [applyMobileShellHeaderEvent]);

  useEffect(() => {
    const scrollTarget = isDirectThreadSurface
      ? directThreadScrollViewportRef.current
      : mainPaneRef.current;
    mobileShellHeaderVisibility.reset(scrollTarget ? {
      scrollTop: scrollTarget.scrollTop,
      scrollHeight: scrollTarget.scrollHeight,
      clientHeight: scrollTarget.clientHeight,
    } : null);
    if (!isMobile || !shouldShowShellHeader) return;
    if (!scrollTarget) return;

    const handleScroll = () => {
      applyMobileShellHeaderEvent({
        kind: "scroll",
        scrollTop: scrollTarget.scrollTop,
        scrollHeight: scrollTarget.scrollHeight,
        clientHeight: scrollTarget.clientHeight,
      });
    };
    scrollTarget.addEventListener("scroll", handleScroll, { passive: true });

    if (isDirectThreadSurface) {
      return () => {
        scrollTarget.removeEventListener("scroll", handleScroll);
      };
    }

    let touchClientY: number | null = null;
    const handleGesture = (direction: "up" | "down", travelPx: number) => {
      applyMobileShellHeaderEvent({
        kind: "gesture",
        direction,
        travelPx,
      });
    };
    const belongsToMainPane = (target: EventTarget | null) => (
      !(target instanceof Element) || !target.closest("[data-thread-scroll-target]")
    );
    const handleTouchStart = (event: TouchEvent) => {
      touchClientY = belongsToMainPane(event.target) && event.touches.length === 1
        ? event.touches[0].clientY : null;
      if (touchClientY !== null) applyMobileShellHeaderEvent({ kind: "touch", active: true });
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (!belongsToMainPane(event.target) || event.touches.length !== 1 || touchClientY === null) {
        touchClientY = null;
        applyMobileShellHeaderEvent({ kind: "touch", active: false });
        return;
      }
      const nextClientY = event.touches[0].clientY;
      if (nextClientY !== touchClientY) {
        handleGesture(nextClientY > touchClientY ? "up" : "down", Math.abs(nextClientY - touchClientY));
      }
      touchClientY = nextClientY;
    };
    const handleTouchEnd = () => {
      touchClientY = null;
      applyMobileShellHeaderEvent({ kind: "touch", active: false });
    };
    const handleWheel = (event: WheelEvent) => {
      if (!belongsToMainPane(event.target) || event.deltaY === 0) return;
      const travelPx = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Math.abs(event.deltaY) * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.abs(event.deltaY) * scrollTarget.clientHeight
          : Math.abs(event.deltaY);
      handleGesture(event.deltaY > 0 ? "down" : "up", travelPx);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!belongsToMainPane(event.target)) return;
      if (event.target instanceof HTMLElement
        && event.target.closest("a,button,input,select,textarea,[contenteditable='true']")) return;
      if (["ArrowDown", "End", "PageDown"].includes(event.key) || (event.key === " " && !event.shiftKey)) {
        handleGesture("down", scrollTarget.clientHeight);
      } else if (["ArrowUp", "Home", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        handleGesture("up", scrollTarget.clientHeight);
      }
    };

    scrollTarget.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollTarget.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollTarget.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollTarget.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    scrollTarget.addEventListener("wheel", handleWheel, { passive: true });
    scrollTarget.addEventListener("keydown", handleKeyDown);
    return () => {
      scrollTarget.removeEventListener("scroll", handleScroll);
      scrollTarget.removeEventListener("touchstart", handleTouchStart);
      scrollTarget.removeEventListener("touchmove", handleTouchMove);
      scrollTarget.removeEventListener("touchend", handleTouchEnd);
      scrollTarget.removeEventListener("touchcancel", handleTouchEnd);
      scrollTarget.removeEventListener("wheel", handleWheel);
      scrollTarget.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeFilePath, applyMobileShellHeaderEvent, isDirectThreadSurface, isMobile, mobileShellHeaderVisibility,
    selectedThreadIdForView, shouldShowShellHeader, threadSurfaceKey]);

  const handleHarnessChange = (nextHarness: WorkbenchHarness,
    location?: ProjectLocationReference | null) => {
    if (!location && nextHarness === harness && currentThread?.harness === nextHarness) {
      return;
    }

    void clientStateController.put({
      kind: "globalPreference",
      preference: { key: "harness", value: nextHarness },
    }).catch((error: Error) => setSelectionError(error.message));
    setHarness(nextHarness);
    if (location) controls?.setDraftThreadHarnessAt(location, nextHarness);
    else controls?.setDraftThreadHarness(nextHarness);
  };

  const handleCreateEntry = async (type: "directory" | "file") => {
    if (!controls || isCreatingEntry) {
      return;
    }

    setIsCreatingEntry(true);
    setCreateDialogError("");
    try {
      // Explorer entries follow markdown naming; an svg starts as an empty drawing written directly.
      const svgPath = type === "file" && isSvgFile(createEntryName.trim())
        ? [createDialogParentPath, createEntryName.trim()].filter(Boolean).join("/") : null;
      const createdPath = svgPath && canCreateTextFiles(controls)
        ? await controls.createTextFile(svgPath, NEW_SVG_SOURCE, browseLocation).then(() => svgPath)
        : await controls.createEntry(createDialogParentPath, createEntryName, type);
      setIsCreatingEntry(false);

      closeCreateDialog();
      if (type === "file") {
        navigateToRoute(route.logical?.projectId && browseLocation
          ? createLogicalFileRoute(route.logical.projectId, browseLocation, createdPath)
          : createFileRoute(explorer.currentProjectId || route.projectId, createdPath), { tab: "durable" });
      }
    } catch (error) {
      setIsCreatingEntry(false);
      setCreateDialogError(error instanceof Error ? error.message : `Couldn't create the ${type === "file" ? "file" : "folder"}.`);
    }
  };

  return (
    <FileActionContext.Provider value={openFileByPolicy}>
    <FileScopeContext.Provider value={browseFileScope}>
    <WorkbenchNetworkClientContext.Provider value={workbenchClient.mounted?.networkClient ?? null}>
    <WorkbenchClientProvider client={workbenchClient}>
    <WorkbenchDaemonClientContext.Provider value={controls?.daemon ?? null}>
    <WorkbenchWorkingTreeProvider projectId={browseProjectId} sourceDaemon={browseDaemon}
      sourceDaemonId={browseLocation?.daemonId}>
    <WorkbenchComposerProfileProvider controller={composerProfileController}>
      <WorkbenchSidebarPreferencesProvider projectId={viewedProjectId}>
        <WorkbenchContextMenuProvider>
        <div
          className={`relative isolate h-dvh overflow-hidden md:grid md:min-h-screen md:h-auto md:overflow-visible md:items-start${isEffectiveDesktopSidebarCollapsed
            ? " md:grid-cols-[minmax(0,1fr)]"
            : " md:grid-cols-[minmax(16rem, 21rem) 1fr]"
            }`}
        >
          {ambientCanvasVariant ? <WorkbenchAmbientCanvas variant={ambientCanvasVariant} /> : null}
          <WorkbenchTabIcon />
          <WorkbenchSearchDialog projects={explorer.projects} />
          {!isMobile ? (
            <IconButton
              type="button"
              label={isEffectiveDesktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              display="hover-border"
              title={isEffectiveDesktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              className={`fixed top-3 z-40 hidden md:inline-flex ${isEffectiveDesktopSidebarCollapsed ? "left-3" : "left-[calc(21rem_-_1.5rem)]"}`}
              onClick={() => sidebarPreferences.set("sidebarCollapsed", !isEffectiveDesktopSidebarCollapsed)}
            >
              {isEffectiveDesktopSidebarCollapsed ? <SidebarExpandIcon size={20} /> : <SidebarCollapseIcon size={20} />}
              <span className="sr-only">{isEffectiveDesktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}</span>
            </IconButton>
          ) : null}
          {isEffectiveDesktopSidebarCollapsed && showMosaicView ? (
            <IconButton
              type="button"
              label="Drag to create a new thread panel"
              display="hover-border"
              title="Drag to create a new thread panel"
              className="fixed left-14 top-3 z-40 hidden cursor-grab active:cursor-grabbing md:inline-flex"
              onClick={(event) => {
                event.preventDefault();
              }}
              onPointerDown={(event) => {
                beginMainPanelDrag(event, {
                  harness,
                  type: "new-thread",
                });
              }}
            >
              <SparkleIcon size={20} />
              <span className="sr-only">Drag to create a new thread panel</span>
            </IconButton>
          ) : null}
          <MobilePaneTrack
            pane={mobilePane}
            route={route}
            slideRef={mobilePaneSlideRef}
          >
            <WorkbenchSidebarPane
              activeProjectId={activeProjectId}
              appRuntime={appRuntime}
              askAgentWithReferences={askAgentWithReferences}
              browseLocation={browseLocation}
              browseProjectId={browseProjectId}
              browseSessionController={browseSessionController}
              collapsed={isEffectiveDesktopSidebarCollapsed}
              createThread={createThreadFromSidebar}
              harness={harness}
              onAttachFeedback={clientState.schemaVersion >= appStateReleases.composerDraftReferences.version
                ? handleAttachFeedbackToThread
                : undefined}
              onOpenQualifiedThread={openQualifiedThread}
              onOpenThread={openThreadFromExplorer}
              onPresentationDraftDeleted={handlePresentationDraftDeleted}
              onThreadSettled={handleThreadSettled}
              physicalProjects={explorer.projects}
              projectSourceError={workbenchMount.projectSourceError}
              renderThreadTooltipDetails={renderThreadTooltipDetails}
              route={route}
              showGitView={showGitView}
              showMosaicView={showMosaicView}
              viewedProjectId={viewedProjectId}
              explorerSection={<section className="shrink-0 pb-3">
                    <WorkbenchSidebarSectionDisclosure
                      actions={(
                        <div className="flex items-center gap-1">
                          <IconButton
                            type="button"
                            label={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            display="hover-border"
                            size="small"
                            aria-pressed={showUnopenableFiles}
                            disabled={!explorer.currentProjectId || isProjectTreeLoading}
                            title={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            className={workbenchNewEntryButtonClassName}
                            onClick={() => {
                              void browseSettings.set("showUnopenableFiles", !showUnopenableFiles)
                                .catch((error: Error) => setSelectionError(error.message));
                            }}
                          >
                            <FileVisibilityIcon visible={showUnopenableFiles} />
                            <span className="sr-only">
                              {showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            </span>
                          </IconButton>
                          <IconButton
                            type="button"
                            label="Create in project"
                            display="hover-border"
                            size="small"
                            title="Create in project"
                            className={workbenchNewEntryButtonClassName}
                            disabled={!explorer.currentProjectId || isProjectTreeLoading}
                            onClick={() => {
                              openCreateDialog("");
                            }}
                          >
                            <NewEntryIcon size={16} />
                            <span className="sr-only">Create in project</span>
                          </IconButton>
                        </div>
                      )}
                      contentClassName="space-y-2"
                      icon={FolderOpenIcon}
                      preferenceKey="explorerOpen"
                      title="Explorer"
                    >
                      {!explorer.projects.length && !isProjectIdentityLoading ? (
                        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted md:pr-4.5">
                          No projects were found.
                        </p>
                      ) : null}
                      {isProjectTreeLoading ? (
                        <SidebarLoadingSkeleton ariaLabel="Loading project files" rows={8} />
                      ) : (
                        <nav id="file-tree" aria-label="Project files">
                          <ExplorerTree
                            changes={explorer.changes}
                            controls={workbenchControls}
                            currentPath={activeFilePath}
                            expandedDirectories={expandedDirectories}
                            getNodeContextMenu={getProjectNodeContextMenu}
                            isFileOpenable={canOpenFileFromExplorer}
                            modifiedPaths={modifiedPaths}
                            nodes={visibleTree}
                            onCreateInDirectory={openCreateDialog}
                            onOpenFile={(path) => {
                              void openFileFromExplorer(path);
                            }}
                          />
                        </nav>
                      )}
                      {projectActionError ? (
                        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger md:pr-4.5">{projectActionError}</p>
                      ) : null}
                    </WorkbenchSidebarSectionDisclosure>
                  </section>}
            />

            <main
              ref={mainPaneRef}
              // `--main-pad-x` is the view's side padding; the shell header cancels it so it sits in the same place in every view.
              className={`
                scrollbar-hover-reveal flex h-dvh w-screen min-w-0 shrink-0 flex-col overflow-x-hidden md:w-auto
                px-(--main-pad-x)
                ${isDirectThreadSurface ? "" : "[scrollbar-gutter:stable]"}
                ${showGitView
                  ? "min-h-0 overflow-hidden pb-0 md:h-screen [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                  : showSvgFileView
                  ? "overflow-y-auto md:h-screen md:min-h-0 md:overflow-hidden [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                  : showSettingsView || showStatsView || routeView || showFileView
                  ? "overflow-y-auto md:h-screen md:min-h-0 md:overflow-y-auto [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                  : isDirectThreadSurface
                  ? "overflow-hidden pb-0 md:h-screen md:min-h-0 md:overflow-hidden [--main-pad-x:0px]"
                  : showFullBleedMainView
                    ? "overflow-y-auto md:h-screen md:min-h-0 md:overflow-hidden md:pb-0 [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:0px]"
                    : "overflow-y-auto md:h-auto md:min-h-screen md:overflow-visible [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                }
              `}
            >
              <ThreadScrollViewport
                ref={directThreadScrollViewportRef}
                className="h-full"
                contentClassName="flex flex-col"
                enabled={isDirectThreadSurface}
                onScrollIntent={handleThreadScrollIntent}
                onTouchActivityChange={handleThreadTouchActivity}
                resetKey={`${threadSurfaceKey}:${getThreadViewInstanceKey(selectedThreadIdForView || activeThreadId)}`}
              >
              <WorkbenchMobileShellHeader
                className={`
              sticky top-0 z-10 transform-gpu py-3 transition-[translate,opacity] duration-200 ease-out will-change-translate motion-reduce:transition-none -mx-(--main-pad-x) pl-5 pr-5 md:pr-6 ${isEffectiveDesktopSidebarCollapsed ? "md:pl-20" : "md:pl-11"}
              md:translate-y-0 md:opacity-100
            `}
                hidden={!shouldShowShellHeader}
                visibility={mobileShellHeaderVisibility}
              >
                {/* On desktop the fade stops short of the left edge so the page's top-left glow shows through. */}
                <div
                  aria-hidden="true"
                  className={`
                    pointer-events-none absolute inset-0 -z-10 md:backdrop-blur-none
                    bg-[linear-gradient(to bottom, var(--app-bg-solid) calc(100% - var(--spacing) * 6), transparent)]
                    md:[mask-image:linear-gradient(to right, transparent, black calc(var(--spacing) * 20))]
                  `}
                />
                <div className="flex items-center gap-2">
                  <IconButton
                    type="button"
                    label="Back to file explorer"
                    display="hover-border"
                    title="Back to file explorer"
                    hidden={!isMobile || mobilePane !== "editor"}
                    className="shrink-0 md:hidden"
                    onClick={() => {
                      if (mobilePaneSlideRef.current) mobilePaneSlideRef.current("sidebar");
                      else window.history.pushState({ workbench: true }, "", mobileSidebarHref(window.location));
                    }}
                  >
                    <BackArrowIcon size={20} />
                    <span className="sr-only">Back to file explorer</span>
                  </IconButton>
                  <WorkbenchShellTabs className="flex-1" fallback={newThreadRoute} />
                  <WorkbenchZoomButton
                    key={fontSizeScopeKey}
                    label="Editor text size"
                    disabled={!shouldShowShellHeader || activeSettings.unavailable("editorFontSize")}
                    min={MIN_EDITOR_FONT_SIZE}
                    max={MAX_EDITOR_FONT_SIZE}
                    value={activeSettings.get("editorFontSize")}
                    onPreview={previewEditorFontSize}
                    onChange={updateEditorFontSize}
                  />
                </div>
              </WorkbenchMobileShellHeader>

              <section
                className={`
                  relative ${isDirectThreadSurface || showGitView ? "min-h-0 flex-1" : "md:min-h-0 md:flex-1"}
                  ${showFullBleedMainView || showGitView ? "min-h-0 overflow-hidden" : ""}
                `}
                aria-busy={isSelectionPending}
              >
                {showThreadView && !shouldRenderMainLayout ? (
                  <WorkbenchDaemonClientContext.Provider value={selectedDaemon ?? null}>
                  <WorkbenchDaemonAssetOriginContext.Provider value={selectedAssetSource}>
                    <FileScopeContext.Provider value={threadFileScope}>
                    <WorkbenchWorkingTreeProvider
                      projectId={threadProjectId}
                      sourceDaemon={selectedDaemon}
                      sourceDaemonId={routeThreadContext?.daemonId ?? routeDraftContext?.daemonId ?? null}
                    >
                    <div className="relative h-full"
                      data-thread-daemon-id={routeOwnerMetadata?.daemonId ?? routeLaunchLocation?.daemonId}
                      data-thread-project-id={routeOwnerMetadata?.projectId ?? routeLaunchLocation?.projectId}>
                    <ThreadView
                      routeOwned
                      routeError={selectionError}
                      key={threadSurfaceKey}
                      thread={threadForThreadView}
                      threadOwnerContent={showThreadOwnerLabel && routeOwnerMetadata ? (
                        <WorkbenchThreadOwnerLabel owner={routeOwnerMetadata}
                          project={routeThreadContext?.project ?? routeDraftContext?.project} />
                      ) : null}
                      draftLeadingContent={projectRotator}
                      approvalModeSettings={approvalModeSettings}
                      draftTargetControl={route.logical && logicalThreadProject && threadForThreadView?.isDraft ? (
                        <WorkbenchProjectLocationMenu
                          folders={projectFolderOptions([logicalThreadProject])}
                          selected={routeLaunchLocation ?? null}
                          label={`Start thread in ${logicalThreadProject.label} at`}
                          onSelect={location => {
                            void (async () => {
                              const submittedRoute = route;
                              const logicalRoute = submittedRoute.logical;
                              const logicalOwnerProjectId = logicalRoute?.threadOwnerProjectId;
                              // Observed folders (e.g. unregistered worktrees) are valid launch targets too.
                              const destination = projectFolderOptions([logicalThreadProject]).find(item =>
                                item.target.daemonId === location.daemonId && item.target.projectId === location.projectId);
                              if (!destination?.project) throw new Error("That daemon folder is unavailable.");
                              if (!controls || !logicalRoute || !logicalOwnerProjectId
                                || !threadForThreadView?.isDraft) return;
                              const draftSession = activeDraftSessionRef.current;
                              const owner = workbenchClient.mounted?.presentationClient;
                              if (!draftSession || !owner) throw new Error("The draft editor is unavailable.");
                              const draftId = DraftIdSchema.parse(threadForThreadView.id);
                              await draftSession.retarget(draftSessionOwner(location.projectId, draftId), async () => {
                                if (!isSameDraftRouteIntent(submittedRoute, currentRouteRef.current, draftId)) return false;
                                const draft = owner.draft(draftId);
                                if (draft) await controls.retargetPresentationDraft(draftId, location);
                                if (!isSameDraftRouteIntent(submittedRoute, currentRouteRef.current, draftId)) return false;
                                const nextRoute = createLogicalThreadRoute(logicalRoute.projectId,
                                  logicalOwnerProjectId, draft ? null : location,
                                  draft ? { kind: "draft", draftId } : { kind: "new" });
                                if (draft) navigateToRoute(nextRoute, { replace: true });
                                else await controls.applyRoute(nextRoute);
                                return true;
                              });
                            })().catch(error => setSelectionError(
                              error instanceof Error ? error.message.slice(0, 500) : "Unable to change draft folder.",
                            ));
                          }}
                        />
                      ) : null}
                      onDraftSessionChange={session => { activeDraftSessionRef.current = session; }}
                      fontSizeRem={displayedFontSizePreview}
                      settingsLocation={settingsFallbackTarget?.kind === "thread"
                        ? settingsFallbackTarget.source?.location ?? null : routeLaunchLocation ?? browseLocation}
                      getThreadHref={(target) => route.logical
                        && (target.kind === "provider" || target.kind === "subagent")
                        ? projectHref(createLogicalExistingThreadRoute(route.logical.projectId, target,
                          route.logical.browseLocation ?? null))
                        : route.logical?.threadOwnerProjectId && routeLaunchLocation
                        ? projectHref(createLogicalThreadRoute(route.logical.projectId, route.logical.threadOwnerProjectId,
                          routeLaunchLocation, target))
                        : !activeProjectId
                        ? projectHref(createHomeThreadRoute(threadProjectId, target))
                        : isForeignThreadProject
                          ? projectHref(createPinnedThreadRoute(activeProjectId, threadProjectId, target))
                          : projectHref(createThreadRoute(activeProjectId, target))}
                      mobileFullBleed={isDirectMobileThreadSurface}
                      onDraftHarnessChange={handleHarnessChange}
                      onThreadSettled={handleComposerThreadSettled}
                      onSendMessage={sendThreadMessage}
                      onThreadComposerDraftChange={handleThreadComposerDraftChange}
                      onThreadComposerDraftClear={handleThreadComposerDraftClear}
                      onQuestionnaireError={setSelectionError}
                      onThreadSettingsChange={setThreadComposerSettings}
                      selectedThreadId={selectedThreadIdForView}
                      onSelectedThreadChange={handleSelectedThreadChange}
                      projectId={threadProjectId}
                      threadTarget={effectiveThreadTarget ?? null}
                      projectFileCandidates={isForeignThreadProject ? [] : explorer.projectFileCandidates}
                      projectFileIndexId={isForeignThreadProject ? `${threadProjectId}:foreign-pin:no-index` : explorer.projectFileIndexId}
                      useOwnerFileIndex={Boolean(route.logical && isForeignThreadProject)}
                      projectFilePaths={isForeignThreadProject ? [] : explorer.projectFilePaths}
                      projectFileLinkRoots={threadProjectFileLinkRoots}
                      projectRootPath={threadProjectRootPath}
                      projectRoots={threadProjectRoots}
                      scrollViewportRef={directThreadScrollViewportRef}
                      threadComposerDraft={activeThreadComposerDraft}
                      threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                      viewInstanceKey={threadViewInstanceKey}
                    />
                    </div>
                    </WorkbenchWorkingTreeProvider>
                    </FileScopeContext.Provider>
                  </WorkbenchDaemonAssetOriginContext.Provider>
                  </WorkbenchDaemonClientContext.Provider>
                ) : null}
                {showSettingsView && !shouldRenderMainLayout ? (
                  <WorkbenchSettingsView
                    attachedDaemonId={DaemonIdSchema.safeParse(
                      workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId,
                    ).data ?? null}
                    daemons={presentationState?.data?.daemons ?? []}
                    folders={projectFolderOptions(settingsReachableProjects)}
                    projects={settingsReachableProjects.map(project => ({
                      id: project.id, label: project.displayName ?? project.label, iconProject: project,
                    }))}
                    getDaemon={daemonId => workbenchClient.mounted?.workspace.daemon({ kind: "installation", daemonId }) ?? null}
                    getFolderDaemon={location => workbenchClient.mounted?.workspace.daemon({ kind: "folder", location }) ?? null}
                    logicalProject={selectedSettingsProject ? {
                      id: selectedSettingsProject.id,
                      label: selectedSettingsProject.displayName ?? selectedSettingsProject.label,
                      iconProject: selectedSettingsProject,
                    } : null}
                    onError={setSelectionError}
                    onGitRootsSaved={async daemonId => {
                      await workbenchClient.mounted?.refreshInstallationProjects(daemonId);
                    }}
                    initialSection={settingsTarget?.section}
                    initialDaemonId={settingsTarget?.daemonId}
                    selectionPending={dynamicSelectionPending
                      || (selectionProjectIds.length === 1 && !selectedSettingsProject
                        && presentationState?.phase !== "failed")}
                    selectionError={selectionProjectIds.length === 1 && !selectedSettingsProject
                      && presentationState?.phase === "failed"
                      ? presentationState.error ?? "Project identity is unavailable." : null}
                  />
                ) : null}
                {showGitView && selectionError && !shouldRenderMainLayout ? (
                  <p role="alert" className="mx-auto max-w-content px-5 py-8 text-danger">{selectionError}</p>
                ) : null}
                {showGitView && !selectionError && !shouldRenderMainLayout ? (
                  !browseLocation ? (
                    <p className="mx-auto max-w-content px-5 py-8 text-fg/muted">Choose a folder to see its working tree and files.</p>
                  ) : (
                    <WorkbenchDaemonClientContext.Provider value={selectedDaemon ?? null}>
                      <WorkbenchDaemonAssetOriginContext.Provider value={selectedAssetSource}>
                        <WorkbenchWorkingTreeView />
                      </WorkbenchDaemonAssetOriginContext.Provider>
                    </WorkbenchDaemonClientContext.Provider>
                  )
                ) : null}
                {routeView && !shouldRenderMainLayout ? (
                  <routeView.Component key={route.view} route={route} />
                ) : null}
                {showStatsView && !shouldRenderMainLayout ? (
                  <WorkbenchStatsView
                    onAddressFeedback={askAgentWithReferences}
                    threadRoute={statsThreadRoute}
                    projects={explorer.projects}
                    scope={statsScope}
                    tab={statsTab}
                  />
                ) : null}
                {showRouteError && !shouldRenderMainLayout ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-content items-center justify-center py-8">
                    <div className="shadow-float flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger/30 bg-[color: color-mix(in srgb, var(--bg) 94%, transparent)] [--fg-bg: color-mix(in srgb, var(--bg) 94%, var(--app-bg-solid))] px-5 py-4 text-left">
                      <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-danger uppercase">Route</p>
                      <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open route</p>
                      <p className="m-0 break-all text-[0.84rem] leading-6 text-fg/muted">{selectionError}</p>
                      {presentationState?.phase === "failed" ? (
                        <button className="w-fit rounded-md px-2 py-1 text-[0.84rem] text-text hover:bg-fg/10"
                          type="button" onClick={retryPresentation}>
                          Retry project identities
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : showEmptyState && !shouldRenderMainLayout ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-content items-center justify-center py-8">
                    {!selectionProjectIds.length ? (
                      <p className="m-0 w-full max-w-[42rem] px-4 text-[0.9rem] text-fg/muted">
                        {route.selectedProjectIds === null
                          ? dynamicSelectionPending ? "Loading projects..." : "No projects have unarchived threads."
                          : "No projects selected. Select a project to see its threads."}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {shouldRenderMainLayout && mainLayoutForRender ? (
                  <WorkbenchWorkspace
                    controller={workspaceController}
                    getPanelViewKey={target => target.kind === "thread"
                      && (target.target.kind === "draft" || target.target.kind === "provider")
                      ? `thread:${getThreadViewInstanceKey(getWorkbenchThreadTargetRootId(target.target))}`
                      : undefined}
                    onFocusPanel={() => { }}
                    onLayoutChange={updateMainLayout}
                    onPanelDrop={handleMainLayoutPanelDrop}
                    onPointerDrop={() => drag.cancel()}
                    onSplitResize={resizeMosaicSplit}
                    renderPanel={({ isFocused, mosaicPanel, panelId, target }) => {
                      const mosaicTarget = workspaceController.mosaicTargetForPanel(panelId);
                      const panelZoomDelta = mosaicPanel?.zoomDelta ?? 0;
                      const isMinimized = Boolean(mosaicPanel?.minimized);
                      const isMinimizedVertical = isMinimized && mosaicPanel?.parentDirection === "horizontal";
                      const sidebarToggleInset = showMosaicView && panelId === topLeftMosaicPanelId
                        ? isEffectiveDesktopSidebarCollapsed ? "collapsed" : "expanded"
                        : undefined;
                      const updatePanelZoomDelta = (zoomDelta: number) => {
                        updateMosaicPanelOptions(panelId, { zoomDelta: zoomDelta || undefined });
                      };
                      const togglePanelMinimized = () => {
                        updateMosaicPanelOptions(panelId, { minimized: !isMinimized || undefined });
                      };
                      const headerDrag: WorkbenchMainPanelDragPayload | undefined = showMosaicView
                        ? { sourcePanelId: panelId, target: mosaicTarget ?? target, type: "panel-target" }
                        : undefined;
                      if (target.kind === "file" && isSvgFile(target.filePath)) {
                        return (
                          <WorkbenchSvgEditorView
                            key={target.filePath}
                            contained={showMosaicView}
                            controls={controls}
                            location={mosaicTarget?.source?.location ?? null}
                            onClose={showMosaicView ? () => { closeMosaicPanel(mosaicTarget ?? target); } : undefined}
                            headerDrag={headerDrag}
                            path={target.filePath}
                            sidebarToggleInset={sidebarToggleInset}
                          />
                        );
                      }

                      if (target.kind === "file") {
                        return (
                          <WorkbenchFileView
                            contained={showMosaicView}
                            route={route}
                            fontSizePreview={!showMosaicView ? displayedFontSizePreview : undefined}
                            sidebarToggleInset={sidebarToggleInset}
                            isFocused={isFocused}
                            isMinimized={isMinimized}
                            isMinimizedVertical={isMinimizedVertical}
                            location={mosaicTarget?.source?.location}
                            onClose={showMosaicView ? () => {
                              closeMosaicPanel(mosaicTarget ?? target);
                            } : undefined}
                            onFocus={() => { }}
                            headerDrag={headerDrag}
                            onMinimizeToggle={showMosaicView ? togglePanelMinimized : undefined}
                            onPanelZoomDeltaChange={showMosaicView ? updatePanelZoomDelta : undefined}
                            panelZoomDelta={panelZoomDelta}
                            path={target.filePath}
                          />
                        );
                      }

                      if (target.kind === "thread") {
                        return (
                          <WorkbenchThreadPanel
                            routeOwned
                            getThreadHref={threadTarget => route.logical
                              && (threadTarget.kind === "provider" || threadTarget.kind === "subagent")
                              ? projectHref(createLogicalExistingThreadRoute(route.logical.projectId, threadTarget,
                                route.logical.browseLocation ?? null))
                              : undefined}
                            fontSizePreview={!showMosaicView ? displayedFontSizePreview : undefined}
                            sidebarToggleInset={sidebarToggleInset}
                            isFocused={isFocused}
                            isMinimized={isMinimized}
                            isMinimizedVertical={isMinimizedVertical}
                            onDraftHarnessChange={nextHarness =>
                              handleHarnessChange(nextHarness, mosaicTarget?.source?.location)}
                            onCreateDraftThread={() => {
                              if (!controls || !route.mosaicNode || target.target.kind !== "new") return null;
                              if (route.logical && !mosaicTarget?.source?.location) {
                                setSelectionError("Choose a daemon folder before creating this thread.");
                                return null;
                              }
                              const draft = route.logical && mosaicTarget?.source?.location
                                ? controls.createThreadDraftAt(mosaicTarget.source.location, harness, { select: false })
                                : controls.createThreadDraft(harness, { select: false });
                              const nextTarget: WorkbenchMosaicPanelTarget = {
                                kind: "thread", target: { kind: "draft", draftId: DraftIdSchema.parse(draft.id) },
                                ...(mosaicTarget?.source ? { source: mosaicTarget.source } : {}),
                              };
                              const nextNode = replaceWorkbenchMosaicTarget(
                                route.mosaicNode, mosaicTarget ?? target, nextTarget,
                              );
                              navigateToRoute(route.logical?.projectId
                                ? createLogicalMosaicRoute(route.logical.projectId, nextNode)
                                : createMosaicRoute(route.projectId, nextNode), { replace: true });
                              return draft;
                            }}
                            onSendMessage={sendThreadMessage}
                            onThreadComposerDraftChange={handleThreadComposerDraftChange}
                            onThreadComposerDraftClear={handleThreadComposerDraftClear}
                            onQuestionnaireError={setSelectionError}
                            onThreadSettingsChange={setThreadComposerSettings}
                            selectedThreadId={getWorkbenchThreadTargetSelectedId(target.target)}
                            onSelectedThreadChange={(selectedThreadId) => {
                              if (!route.mosaicNode || target.target.kind === "new" || target.target.kind === "draft") return;
                              const rootThreadId = target.target.kind === "subagent" ? target.target.parentThreadId : target.target.threadId;
                              const nextTarget: WorkbenchMosaicPanelTarget = {
                                kind: "thread",
                                target: selectedThreadId === rootThreadId
                                  ? { harness: target.target.harness, kind: "provider", threadId: rootThreadId }
                                  : { harness: target.target.harness, kind: "subagent", parentThreadId: rootThreadId, threadId: ThreadReferenceSchema.parse(selectedThreadId) },
                              };
                              const nextNode = replaceWorkbenchMosaicTarget(route.mosaicNode, mosaicTarget ?? target, nextTarget);
                              navigateToRoute(route.logical?.projectId
                                ? createLogicalMosaicRoute(route.logical.projectId, nextNode)
                                : createMosaicRoute(route.projectId, nextNode));
                            }}
                            profileController={profileControllerFor(
                              target.target.kind === "provider" || target.target.kind === "subagent"
                                ? workbenchClient.mounted?.threadOwnerFor(getWorkbenchThreadTargetRootId(target.target))
                                  ?.daemonId ?? profileScopeKey
                                : mosaicTarget?.source?.location?.daemonId ?? profileScopeKey)}
                            projectId={route.projectId}
                            projectFileCandidates={explorer.projectFileCandidates}
                            projectFileIndexId={explorer.projectFileIndexId}
                            useOwnerFileIndex={Boolean(route.logical)}
                            projectFilePaths={explorer.projectFilePaths}
                            projectRootPath={explorer.rootPath}
                            projectRoots={explorer.roots}
                            threadTarget={target.target}
                            threadComposerDraft={getThreadComposerDraftForTarget(target.target)}
                            threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                            onClose={showMosaicView ? () => {
                              closeMosaicPanel(mosaicTarget ?? target);
                            } : undefined}
                            headerDrag={headerDrag}
                            onMinimizeToggle={showMosaicView ? togglePanelMinimized : undefined}
                            onPanelZoomDeltaChange={showMosaicView ? updatePanelZoomDelta : undefined}
                            panelZoomDelta={panelZoomDelta}
                            location={mosaicTarget?.source?.location}
                            thread={target.target.kind === "provider" || target.target.kind === "subagent"
                              ? getThreadDocumentFromSnapshot(threadDocuments, getWorkbenchThreadTargetRootId(target.target))
                                ?? (currentThread?.id === getWorkbenchThreadTargetRootId(target.target) ? currentThread : null)
                              : target.target.kind === "draft"
                                ? mosaicDraftThreadsById[target.target.draftId] ?? null
                                : null}
                            threadId={getWorkbenchThreadTargetRootId(target.target)}
                            viewInstanceKey={getThreadViewInstanceKey(getWorkbenchThreadTargetRootId(target.target))}
                          />
                        );
                      }

                      return (
                        <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-content items-center justify-center py-8">
                          <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in srgb, var(--text) 10%, transparent)] bg-[color: color-mix(in srgb, var(--bg) 94%, transparent)] [--fg-bg: color-mix(in srgb, var(--bg) 94%, var(--app-bg-solid))] px-5 py-4 text-left">
                            <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-fg/muted uppercase">Workbench</p>
                            <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Drop a file or thread here</p>
                          </div>
                        </div>
                      );
                    }}
                  />
                ) : null}
                {showSvgFileView && !shouldRenderMainLayout ? (
                  <WorkbenchSvgFileView
                    controls={controls}
                    location={svgFileLocation}
                    onOpenCopy={path => navigateToRoute(resolveWorkbenchFileRoute({
                      currentProjectId: explorer.currentProjectId, logicalProjects, location: svgFileLocation, path,
                      projectId: svgFileLocation?.projectId ?? explorer.currentProjectId ?? route.projectId, route,
                    }), { replace: true })}
                    path={effectiveFilePath}
                  />
                ) : showFileView && !shouldRenderMainLayout ? (
                  <WorkbenchFileView
                    route={route}
                    fontSizePreview={displayedFontSizePreview}
                    isFocused
                    location={mobileMosaicFallbackTarget?.kind === "file" ? mobileMosaicFallbackTarget.source?.location : undefined}
                    onFocus={() => { }}
                    path={effectiveFilePath}
                    shellHeaderVisibility={mobileShellHeaderVisibility}
                  />
                ) : null}
              </section>
              </ThreadScrollViewport>

              <WorkbenchDialog
                id="delete-file-dialog"
                titleId="delete-file-title"
                summaryId="delete-file-summary"
                eyebrow="Permanent deletion"
                title="Permanently delete this untracked file?"
                isOpen={Boolean(pendingDeleteFilePath)}
                onBackdropClick={closeDeleteFileDialog}
                actions={
                  <>
                    <button
                      type="button"
                      className={dialogButtonClassName}
                      onClick={closeDeleteFileDialog}
                      disabled={isDeletingFile}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`${dialogButtonClassName} text-danger`}
                      onClick={() => {
                        void deleteProjectFile(pendingDeleteFilePath, true);
                      }}
                      disabled={isDeletingFile}
                    >
                      Delete permanently
                    </button>
                  </>
                }
              >
                <>
                  <p id="delete-file-summary" className="mt-3 text-sm leading-6 text-fg/muted">
                    Git cannot restore this file. This also discards its saved Workbench draft.
                  </p>
                  <p className="mt-3 break-all text-[0.84rem] leading-6 text-text">{pendingDeleteFilePath}</p>
                  {deleteDialogError ? <p className="mt-3 text-sm leading-6 text-danger">{deleteDialogError}</p> : null}
                </>
              </WorkbenchDialog>

              <WorkbenchDialog
                id="create-entry-dialog"
                titleId="create-entry-title"
                summaryId="create-entry-summary"
                eyebrow="Create entry"
                title={`New item in ${createDialogParentLabel}`}
                isOpen={isCreateDialogOpen}
                onBackdropClick={closeCreateDialog}
                actions={
                  <>
                    <button
                      id="create-entry-cancel"
                      type="button"
                      className={dialogButtonClassName}
                      onClick={closeCreateDialog}
                      disabled={isCreatingEntry}
                    >
                      Cancel
                    </button>
                    <button
                      id="create-entry-folder"
                      type="button"
                      className={dialogButtonClassName}
                      onClick={() => {
                        void handleCreateEntry("directory");
                      }}
                      disabled={isCreatingEntry}
                    >
                      Make folder
                    </button>
                    <button
                      id="create-entry-file"
                      type="button"
                      className={dialogButtonClassName}
                      onClick={() => {
                        void handleCreateEntry("file");
                      }}
                      disabled={isCreatingEntry}
                    >
                      Make file
                    </button>
                  </>
                }
              >
                <>
                  <p id="create-entry-summary" className="mt-3 text-sm leading-6 text-fg/muted">
                    Enter a name for the new file or folder. New files are created as markdown files.
                  </p>
                  <label className="mt-4 block text-sm text-fg/muted" htmlFor="create-entry-name">
                    Name
                  </label>
                  <input
                    id="create-entry-name"
                    type="text"
                    value={createEntryName}
                    autoFocus
                    onChange={(event) => {
                      setCreateEntryName(event.target.value);
                      if (createDialogError) {
                        setCreateDialogError("");
                      }
                    }}
                    className="mt-2 w-full rounded-xl bg-[color-mix(in srgb, var(--bg) 86%, transparent)] px-3 py-2 text-base outline-none ring-0 transition focus:bg-[color-mix(in srgb, var(--bg) 94%, transparent)]"
                    placeholder="chapter-notes"
                  />
                  {createDialogError ? (
                    <p className="mt-3 text-sm leading-6 text-danger">{createDialogError}</p>
                  ) : null}
                </>
              </WorkbenchDialog>
            </main>
          </MobilePaneTrack>

        </div>
        </WorkbenchContextMenuProvider>
      </WorkbenchSidebarPreferencesProvider>
    </WorkbenchComposerProfileProvider>
    </WorkbenchWorkingTreeProvider>
    </WorkbenchDaemonClientContext.Provider>
    </WorkbenchClientProvider>
    </WorkbenchNetworkClientContext.Provider>
    </FileScopeContext.Provider>
    </FileActionContext.Provider>
  );
}
