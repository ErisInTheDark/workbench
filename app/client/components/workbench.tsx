/*
 * Exports:
 * - default Workbench: shell composition, providers (including the explorer snapshot), routed views and responsive chrome.
 * Local helpers: route, title, drag, editor, file, and thread UI transformations.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
    ExplorerSnapshot,
    ThreadPayload,
    WorkbenchAppRuntimeStore,
    WorkbenchComposerInputDraft,
    WorkbenchHarness,
    WorkbenchLogicalThreadRow,
    WorkbenchProjectOption,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { DaemonIdSchema, DraftIdSchema, ThreadReferenceSchema, type DaemonId, type FolderId } from "workbench-shared/workbench/identity";
import {
    createFileRoute,
    createDiscardedDraftExitRoute,
    createHomeRoute,
    createHomeThreadRoute,
    createLogicalExistingThreadRoute,
    createLogicalFileRoute,
    createLogicalProjectRoute,
    createLogicalThreadRoute,
    createPinnedThreadRoute,
    createProjectRoute,
    createSettingsRoute,
    createSettledThreadExitRoute,
    createThreadRoute,
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
import { isSvgFile } from "workbench-shared/workbench/project/tree-utils";
import { preferredSelectedLaunchTarget } from "workbench-shared/workbench/project/workbench-project-projection";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { useThread } from "./workbench/use-thread";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { useWorkbenchAppRpc } from "../workbench/app/WorkbenchAppRpcContext";
import { WorkbenchNetworkClientContext } from "../workbench/app/WorkbenchNetworkClient";
import WorkbenchBrowseSessionController from "../workbench/browse/WorkbenchBrowseSessionController";
import { installBrowserRandomUuidPolyfill } from "../workbench/browser-random-uuid-polyfill";
import {
  FileActionContext, FileScopeContext, useFileActions,
} from "../workbench/file/use-file";
import useMediaQuery from "../workbench/dom/layout/use-media-query";
import type { WorkspaceFileLinkRoot } from "../workbench/markdown/markdown-links";
import { useWorkbenchProjectNavigation } from "../workbench/navigation/use-workbench-project-navigation";
import { useWorkbenchTabs } from "../workbench/navigation/use-workbench-tabs";
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
import { getThreadDocumentFromSnapshot } from "../workbench/thread/thread-document-keys";
import WorkbenchWorkingTreeProvider from "./workbench/git/WorkbenchWorkingTreeProvider";
import WorkbenchWorkingTreeView from "./workbench/git/WorkbenchWorkingTreeView";
import WorkbenchFileView from "./workbench/layout/WorkbenchFileView";
import WorkbenchSvgFileView from "./workbench/svg/WorkbenchSvgFileView";
import WorkbenchShellTabs from "./workbench/shell-tabs/WorkbenchShellTabs";
import MobilePaneTrack from "./workbench/MobilePaneTrack";
import type { MobileShellHeaderEvent } from "./workbench/mobile-shell-header-visibility";
import MobileShellHeaderVisibilityController from "./workbench/MobileShellHeaderVisibilityController";
import WorkbenchMobileShellHeader from "./workbench/WorkbenchMobileShellHeader";
import WorkbenchStatsView from "./workbench/stats/WorkbenchStatsView";
import { resolveStatsProjectScope } from "./workbench/stats/stats-project-scope";
import type DraftSessionController from "./workbench/thread-view/DraftSessionController";
import { draftSessionOwner } from "./workbench/thread-view/DraftSessionController";
import { seedNewThreadReferences } from "../workbench/thread/new-thread-reference-seeds";
import { WorkbenchFeedbackAddressingContext } from "./workbench/address-feedback-context";
import { WorkbenchShellErrorContext } from "./workbench/workbench-shell-error-context";
import ThreadViewKeys, { ThreadViewKeysContext } from "../workbench/thread/ThreadViewKeys";
import { useWorkbenchComposerProfiles } from "./workbench/WorkbenchComposerProfileContext";
import { readWorkbenchLaunchSelection } from "workbench-shared/state/workbench-client-state";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import ThreadScrollViewport from "./workbench/thread-view/ThreadScrollViewport";
import ThreadView from "./workbench/thread-view/ThreadView";
import { useWorkbenchClientMount } from "./workbench/use-workbench-client";
import { useProjects } from "./workbench/use-projects";
import { useThreads } from "./workbench/use-threads";
import { useWorkbenchClientStateController } from "./workbench/workbench-client-state-context";
import { WorkbenchExplorerContext } from "./workbench/explorer/workbench-explorer-context";
import {
    BackArrowIcon,
    SidebarCollapseIcon,
    SidebarExpandIcon,
} from "./workbench/workbench-icons";
import WorkbenchAmbientCanvas, { getAmbientCanvasVariant } from "./workbench/WorkbenchAmbientCanvas";
import WorkbenchClientProvider from "./workbench/WorkbenchClientProvider";
import WorkbenchComposerProfileProvider from "./workbench/WorkbenchComposerProfileProvider";
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
import WorkbenchTabIcon from "./workbench/WorkbenchTabIcon";
import WorkbenchSidebarPane from "./workbench/WorkbenchSidebarPane";
import WorkbenchThreadTooltipDetails from "./workbench/WorkbenchThreadTooltipDetails";
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


function getProjectTabLabel (projectName: string | null | undefined) {
  return projectName?.trim() || "Project";
}

export default function Workbench ({ appRuntime = null }: { appRuntime?: WorkbenchAppRuntimeStore | null }) {
  const appRpc = useWorkbenchAppRpc();
  const clientStateController = useWorkbenchClientStateController();
  const initialRoute = new WorkbenchProjectNavigation([], clientStateController.getProjectAliases())
    .readRoute(typeof window === "undefined" ? "/" : window.location.href,
      readWorkbenchLaunchSelection(clientStateController.getSnapshot().records));
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
  const composerProfileController = useWorkbenchComposerProfiles.registry()?.(profileScopeKey);
  if (!composerProfileController) throw new Error("Workbench requires WorkbenchComposerProfileRegistryProvider.");
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
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [mobileShellHeaderVisibility] = useState(() => new MobileShellHeaderVisibilityController());
  const mobileSidebarRequested = isMobileSidebarRequested(useSearchParams().toString());
  const mobilePane = getPreferredMobilePane(isMobile, route, mobileSidebarRequested);
  const mobilePaneSlideRef = useRef<((destination: MobilePaneDestination) => void) | null>(null);
  // A composer shortcut asks settings to open on one section; ordinary settings visits start fresh.
  const [settingsTarget, setSettingsTarget] = useState<{ section: string; daemonId: DaemonId } | null>(null);
  const globalSettings = useSettings();
  const mainPaneRef = useRef<HTMLElement>(null);
  const directThreadScrollViewportRef = useRef<HTMLDivElement>(null);
  const retainedThreadRef = useRef<ThreadPayload | null>(null);
  const [threadViewKeys] = useState(() => new ThreadViewKeys());
  const search = useWorkbenchSearch();
  const sidebarPreferences = useWorkbenchSidebarPreferences.global();
  const isEffectiveDesktopSidebarCollapsed = !isMobile && sidebarPreferences.preferences.sidebarCollapsed;


  const routeToApplyToControls = useMemo(() => {
    if (route.logical) return route;
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
  ]);

  useWorkbenchRouteIntent(workbenchClient, routeToApplyToControls, navigateToRoute);
  useEffect(() => { setSelectionError(""); }, [routeToApplyToControls]);

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
  const settingsFileLocation = route.view === "file"
    ? workbenchClient.mounted?.projectNavigator.fileLocationFor(route) ?? null : null;
  const fileSettings = useSettings.forLocation(settingsFileLocation, workbenchClient);
  const threadSettings = useSettings.forThread(route.threadTarget?.kind === "new" && currentThread?.isDraft
    ? { kind: "draft", draftId: DraftIdSchema.parse(currentThread.id) } : route.threadTarget,
  routeLaunchLocation ?? route.logical?.location ?? browseLocation, workbenchClient);
  const activeSettings = route.view === "file" ? fileSettings
    : route.view === "thread" ? threadSettings : shellSettings;
  const fontSizeScopeKey = activeSettings.unavailable("editorFontSize") ? "unavailable" : activeSettings.projectId ?? "global";
  const [editorFontSizePreview, setEditorFontSizePreview] = useState<{ scope: string; value: number } | null>(null);
  const previewEditorFontSize = useCallback((value: number | null) => {
    setEditorFontSizePreview(value === null ? null : { scope: fontSizeScopeKey, value });
  }, [fontSizeScopeKey]);
  const displayedFontSizePreview = editorFontSizePreview?.scope === fontSizeScopeKey
    ? editorFontSizePreview?.value : undefined;
  const projectTabLabel = getProjectTabLabel(viewedProjectDisplayName);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

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
  const feedbackAddressing = useMemo(() => ({ here: null, inNewThread: askAgentWithReferences }), [askAgentWithReferences]);

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
  const showThreadView = route.view === "thread";
  const showFileView = route.view === "file";
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
  const createThreadFromSidebar = useCallback((ownerProjectId: string, options?: {
    folderId?: FolderId;
    location?: ProjectLocationReference;
  }) => {
    if (!controls) return;
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
  }, [controls, logicalProjects, navigateToRoute, route, selectedLogicalProjects, workbenchClient.mounted]);
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
  const effectiveThreadId = route.threadTarget ? getWorkbenchThreadTargetRootId(route.threadTarget) : route.threadId;
  const effectiveSelectedThreadId = route.threadTarget ? getWorkbenchThreadTargetSelectedId(route.threadTarget) : effectiveThreadId;
  // A folder index named by an svg (one discarded from its editor) is the folder's index, not the svg editor.
  const showSvgFileView = showFileView && isSvgFile(route.filePath) && !route.fileIndex;
  const svgFileLocation = showSvgFileView
    ? workbenchClient.mounted?.projectNavigator.fileLocationFor(route) ?? null
    : null;
  const showEmptyState = !showThreadView && !showFileView && !showSettingsView && !showStatsView && !showGitView && !routeView;
  const showRouteError = Boolean(selectionError) && showEmptyState;
  if (currentThread) {
    retainedThreadRef.current = currentThread;
  }
  const retainedThread = retainedThreadRef.current;
  const effectiveThreadRoute = route.threadTarget
    ? route.logical && (route.threadTarget.kind === "provider" || route.threadTarget.kind === "subagent")
      ? createLogicalExistingThreadRoute(route.logical.projectId, route.threadTarget,
        route.logical.browseLocation ?? null)
      : route.view === "thread" && !route.projectId && route.threadOwnerProjectId
      ? createHomeThreadRoute(route.threadOwnerProjectId, route.threadTarget)
      : route.view === "thread" && route.threadOwnerProjectId && route.threadOwnerProjectId !== route.projectId
        ? createPinnedThreadRoute(route.projectId, route.threadOwnerProjectId, route.threadTarget)
        : createThreadRoute(activeProjectId, route.threadTarget)
    : route;
  const getThreadViewInstanceKey = (threadId: string) => threadViewKeys.keyFor(threadId);
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
    ?? (route.threadTarget?.kind !== "new" && isThreadOwnedByEffectiveRoute(retainedThread)
      ? retainedThread
      : null);
  const handleSelectedThreadChange = useCallback((selectedThreadId: string) => {
    if (!route.threadTarget || route.threadTarget.kind === "new" || route.threadTarget.kind === "draft") return;
    const rootThreadId = route.threadTarget.kind === "subagent" ? route.threadTarget.parentThreadId : route.threadTarget.threadId;
    const harness = route.threadTarget.harness ?? threadForThreadView?.harness;
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
  }, [activeProjectId, route.threadTarget, navigateToRoute, route, threadForThreadView?.harness]);
  const threadProjectId = routeThreadContext?.project.id ?? routeDraftContext?.project.id
    ?? (route.view === "thread" ? route.threadOwnerProjectId || route.projectId : route.projectId || activeProjectId);
  // Existing threads load inside their own view (thread store); only drafts and new threads wait for a document.
  const isThreadViewReady = showThreadView && (Boolean(threadForThreadView)
    || route.threadTarget?.kind === "provider" || route.threadTarget?.kind === "subagent");
  const isSelectionPending = !selectionError && showThreadView && !isThreadViewReady;
  const viewedThreadId = threadForThreadView?.id ?? effectiveThreadId;
  const threadViewInstanceKey = getThreadViewInstanceKey(viewedThreadId);
  const selectedThreadIdForView = route.threadTarget?.kind === "new" && threadForThreadView
    ? threadForThreadView.id
    : effectiveSelectedThreadId;
  const activeThreadId = showThreadView ? threadViewInstanceKey : "";
  const activeFilePath = showFileView ? route.filePath : "";
  // A thread launched from a draft keeps that draft's surface, even before its own document loads, so the view
  // instance (and its launch handoff) survives the route change.
  const retainsDraftSurface = route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft"
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
    const threadIds = new Set<string>();
    if (
      isThreadViewReady
      && route.threadTarget
      && (route.threadTarget.kind === "provider" || route.threadTarget.kind === "subagent")
    ) {
      threadIds.add(getWorkbenchThreadTargetRootId(route.threadTarget));
    }
    return threadIds;
  }, [route.threadTarget, isThreadViewReady]);
  const renderThreadTooltipDetails = useCallback((entry: WorkbenchThreadSidebarEntry) => {
    if (entry.entryKind === "draft") return null;
    const threadId = entry.identity.threadId;
    const rootThreadId = entry.entryKind === "subagent" ? entry.parentThreadId : threadId;
    return (
      <WorkbenchThreadTooltipDetails
        harness={entry.identity.harness}
        materialized={materializedThreadRootIds.has(rootThreadId)}
        fallbackProjectId={activeProjectId}
        threadId={threadId}
        parentThreadId={entry.entryKind === "subagent" ? entry.parentThreadId : undefined}
      />
    );
  }, [
    activeProjectId,
    materializedThreadRootIds,
  ]);
  const ambientCanvasVariant = getAmbientCanvasVariant(theme);
  const shouldShowShellHeader = !isMobile || mobilePane === "editor";
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
  const isDirectMobileThreadSurface = isMobile && showThreadView;

  const tabs = useWorkbenchTabs(newThreadRoute);
  /** Paths are per folder, so only the browsed folder's tabs of that path close; the rest of the strip stays. */
  const closeDeletedFileViews = useCallback((filePath: string) => {
    const folder = explorer.browseLocation;
    const navigator = workbenchClient.mounted?.projectNavigator;
    if (!folder || !navigator) return;
    tabs.closeWhere(tab => {
      if (tab.view !== "file" || tab.filePath !== filePath) return false;
      const location = navigator.fileLocationFor(tab);
      return location?.daemonId === folder.daemonId && location.projectId === folder.projectId;
    });
  }, [explorer.browseLocation, tabs, workbenchClient]);

  useEffect(() => {
    if (!isMobile || mobilePane !== "editor" || !mainPaneScrollKey || showThreadView) {
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
  }, [showThreadView, isMobile, mainPaneScrollKey, mobilePane]);

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
    const scrollTarget = showThreadView
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

    if (showThreadView) {
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
  }, [activeFilePath, applyMobileShellHeaderEvent, showThreadView, isMobile, mobileShellHeaderVisibility,
    selectedThreadIdForView, shouldShowShellHeader, threadSurfaceKey]);

  return (
    <ThreadViewKeysContext.Provider value={threadViewKeys}>
    <WorkbenchShellErrorContext.Provider value={setSelectionError}>
    <WorkbenchFeedbackAddressingContext.Provider value={feedbackAddressing}>
    <WorkbenchExplorerContext.Provider value={explorer}>
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
          {ambientCanvasVariant ? <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
            <WorkbenchAmbientCanvas className="opacity-70" variant={ambientCanvasVariant} />
          </div> : null}
          <WorkbenchTabIcon />
          <WorkbenchSearchDialog />
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
          <MobilePaneTrack
            pane={mobilePane}
            route={route}
            slideRef={mobilePaneSlideRef}
          >
            <WorkbenchSidebarPane
              activeProjectId={activeProjectId}
              appRuntime={appRuntime}
              askAgentWithReferences={askAgentWithReferences}
              browseSessionController={browseSessionController}
              collapsed={isEffectiveDesktopSidebarCollapsed}
              createThread={createThreadFromSidebar}
              currentFilePath={activeFilePath}
              onFileDeleted={closeDeletedFileViews}
              onOpenQualifiedThread={openQualifiedThread}
              onOpenThread={openThreadFromExplorer}
              onPresentationDraftDeleted={handlePresentationDraftDeleted}
              onThreadSettled={handleThreadSettled}
              projectSourceError={workbenchMount.projectSourceError}
              renderThreadTooltipDetails={renderThreadTooltipDetails}
              route={route}
              showGitView={showGitView}
              viewedProjectId={viewedProjectId}
            />

            <main
              ref={mainPaneRef}
              // `--main-pad-x` is the view's side padding; the shell header cancels it so it sits in the same place in every view.
              className={`
                scrollbar-hover-reveal flex h-dvh w-screen min-w-0 shrink-0 flex-col overflow-x-hidden md:w-auto
                px-(--main-pad-x)
                ${showThreadView ? "" : "[scrollbar-gutter:stable]"}
                ${showGitView
                  ? "min-h-0 overflow-hidden pb-0 md:h-screen [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                  : showSvgFileView
                  ? "overflow-y-auto md:h-screen md:min-h-0 md:overflow-hidden [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                  : showSettingsView || showStatsView || routeView || showFileView
                  ? "overflow-y-auto md:h-screen md:min-h-0 md:overflow-y-auto [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                  : showThreadView
                  ? "overflow-hidden pb-0 md:h-screen md:min-h-0 md:overflow-hidden [--main-pad-x:0px]"
                    : "overflow-y-auto md:h-auto md:min-h-screen md:overflow-visible [--main-pad-x:calc(var(--spacing)*5)] md:[--main-pad-x:calc(var(--spacing)*6)]"
                }
              `}
            >
              <ThreadScrollViewport
                ref={directThreadScrollViewportRef}
                className="h-full"
                contentClassName="flex flex-col"
                enabled={showThreadView}
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
                  relative ${showThreadView || showGitView ? "min-h-0 flex-1" : "md:min-h-0 md:flex-1"}
                  ${showGitView ? "min-h-0 overflow-hidden" : ""}
                `}
                aria-busy={isSelectionPending}
              >
                {showThreadView ? (
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
                      settingsLocation={routeLaunchLocation ?? browseLocation}
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
                      onThreadSettled={handleComposerThreadSettled}
                      selectedThreadId={selectedThreadIdForView}
                      onSelectedThreadChange={handleSelectedThreadChange}
                      projectId={threadProjectId}
                      threadTarget={route.threadTarget ?? null}
                      projectFileCandidates={isForeignThreadProject ? [] : explorer.projectFileCandidates}
                      projectFileIndexId={isForeignThreadProject ? `${threadProjectId}:foreign-pin:no-index` : explorer.projectFileIndexId}
                      useOwnerFileIndex={Boolean(route.logical && isForeignThreadProject)}
                      projectFilePaths={isForeignThreadProject ? [] : explorer.projectFilePaths}
                      projectFileLinkRoots={threadProjectFileLinkRoots}
                      projectRootPath={threadProjectRootPath}
                      projectRoots={threadProjectRoots}
                      scrollViewportRef={directThreadScrollViewportRef}
                      viewInstanceKey={threadViewInstanceKey}
                    />
                    </div>
                    </WorkbenchWorkingTreeProvider>
                    </FileScopeContext.Provider>
                  </WorkbenchDaemonAssetOriginContext.Provider>
                  </WorkbenchDaemonClientContext.Provider>
                ) : null}
                {showSettingsView ? (
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
                {showGitView && selectionError ? (
                  <p role="alert" className="mx-auto max-w-content px-5 py-8 text-danger">{selectionError}</p>
                ) : null}
                {showGitView && !selectionError ? (
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
                {routeView ? (
                  <routeView.Component key={route.view} route={route} />
                ) : null}
                {showStatsView ? (
                  <WorkbenchStatsView
                    onAddressFeedback={askAgentWithReferences}
                    threadRoute={statsThreadRoute}
                    projects={explorer.projects}
                    scope={statsScope}
                    tab={statsTab}
                  />
                ) : null}
                {showRouteError ? (
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
                ) : showEmptyState ? (
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
                {showSvgFileView ? (
                  <WorkbenchSvgFileView
                    controls={controls}
                    location={svgFileLocation}
                    path={route.filePath}
                    route={route}
                  />
                ) : showFileView ? (
                  <WorkbenchFileView
                    route={route}
                    fontSizePreview={displayedFontSizePreview}
                    path={route.filePath}
                    shellHeaderVisibility={mobileShellHeaderVisibility}
                  />
                ) : null}
              </section>
              </ThreadScrollViewport>
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
    </WorkbenchExplorerContext.Provider>
    </WorkbenchFeedbackAddressingContext.Provider>
    </WorkbenchShellErrorContext.Provider>
    </ThreadViewKeysContext.Provider>
  );
}
