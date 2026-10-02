/*
 * Exports:
 * - default Workbench: stable shell composition, providers, explorer/file dialogs, responsive chrome, and DOM surfaces.
 * Local helpers: route, title, drag, editor, file, and thread UI transformations.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";

import type {
    ExplorerSnapshot,
    RevealProjectEntryRequest, ThreadPayload, ThreadSummary, TreeNode,
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
import { DaemonIdSchema, DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema, type FolderId } from "workbench-shared/workbench/identity";
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
    createGitRoute,
    createHomeRoute,
    createHomeThreadRoute,
    createLogicalExistingThreadRoute,
    createLogicalFileRoute,
    createLogicalGitRoute,
    createLogicalMosaicRoute,
    createLogicalProjectRoute,
    createLogicalThreadRoute,
    createMosaicRoute,
    createPinnedThreadRoute,
    createProjectRoute,
    createNewProjectRoute,
    createSettingsRoute,
    createStatsRoute,
    createThreadRoute,
    createToggledProjectSelectionRoute,
    createWorkbenchHref,
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
import { isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import { projectLogicalThreadDisplayOrder } from "workbench-shared/workbench/project/workbench-project-projection";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import { createDraftTitle, type WorkbenchThreadSidebarEntry, type WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { useWorkbenchAppRpc } from "../workbench/app/WorkbenchAppRpcContext";
import { WorkbenchNetworkClientContext } from "../workbench/app/WorkbenchNetworkClient";
import WorkbenchBrowseSessionController from "../workbench/browse/WorkbenchBrowseSessionController";
import { installBrowserRandomUuidPolyfill } from "../workbench/browser-random-uuid-polyfill";
import { FileActionContext, FileScopeContext, useFileActions } from "../workbench/file/use-file";
import { WORKBENCH_MAIN_PANEL_DROP_TARGET_ID, type WorkbenchDragPayload } from "../workbench/layout/workbench-drag";
import { replaceWorkbenchMosaicTarget } from "../workbench/layout/workbench-mosaic-layout";
import WorkbenchDragController from "../workbench/layout/WorkbenchDragController";
import WorkbenchWorkspaceController from "../workbench/layout/WorkbenchWorkspaceController";
import type { WorkspaceFileLinkRoot } from "../workbench/markdown/markdown-links";
import { useWorkbenchProjectNavigation } from "../workbench/navigation/use-workbench-project-navigation";
import { useWorkbenchRoute, useWorkbenchRouteIntent } from "../workbench/navigation/use-workbench-route";
import WorkbenchProjectNavigation from "../workbench/navigation/workbench-project-navigation";
import {
    handleWorkbenchActionShortcut,
    runWorkbenchAction,
    type WorkbenchActionContext,
} from "../workbench/search/workbench-action-registry";
import type { WorkbenchSearchHit } from "../workbench/search/WorkbenchSearchController";
import WorkbenchSearchController from "../workbench/search/WorkbenchSearchController";
import { createComposerProfilePersistence, createComposerProfileTargetPersistence } from "../workbench/state/composer-profile-api";
import {
    clearComposerDraft, presentationDraftToInput, projectComposerDrafts, saveComposerDraft,
    type ComposerDraftTarget,
} from "../workbench/state/draft-persistence";
import {
    getMobileExplorerRoute,
    getPreferredMobilePane,
    MOBILE_MEDIA_QUERY,
    type MobilePane,
} from "../workbench/state/mobile-pane-url-state";
import {
    createDefaultProjectWorkbenchSettings,
    MAX_EDITOR_FONT_SIZE,
    MIN_EDITOR_FONT_SIZE,
    readGlobalWorkbenchSettings,
    readLogicalProjectWorkbenchSettings,
    resolveWorkbenchSettings,
    writeGlobalWorkbenchSetting,
    writeLogicalProjectWorkbenchSetting,
    type WorkbenchEditorFontFamily,
    type WorkbenchGlobalSettings,
    type WorkbenchSettingKey,
} from "../workbench/state/workbench-settings";
import WorkbenchComposerProfileController from "../workbench/state/WorkbenchComposerProfileController";
import { getThreadDocumentFromSnapshot } from "../workbench/thread/thread-document-keys";
import { ThreadMessageNotSentError } from "../workbench/thread/thread-message-submission";
import type { WorkbenchDomSurfaces } from "../workbench/workbench-dom";
import DropTargetBoundary from "./workbench/drag/DropTargetBoundary";
import WorkbenchDragProvider from "./workbench/drag/WorkbenchDragProvider";
import WorkbenchGitRefreshButton from "./workbench/git/WorkbenchGitRefreshButton";
import WorkbenchGitRepositoryControl from "./workbench/git/WorkbenchGitRepositoryControl";
import WorkbenchGitSidebar from "./workbench/git/WorkbenchGitSidebar";
import WorkbenchWorkingTreeProvider from "./workbench/git/WorkbenchWorkingTreeProvider";
import WorkbenchWorkingTreeView from "./workbench/git/WorkbenchWorkingTreeView";
import WorkbenchFilePanel from "./workbench/layout/WorkbenchFilePanel";
import WorkbenchThreadPanel from "./workbench/layout/WorkbenchThreadPanel";
import { resolveSelectedProjectIds } from "./workbench/project-sidebar-groups";
import ProjectSidebar from "./workbench/ProjectSidebar";
import ReloadNecessary from "./workbench/ReloadNecessary";
import WorkbenchStatsView from "./workbench/stats/WorkbenchStatsView";
import { resolveStatsProjectScope } from "./workbench/stats/stats-project-scope";
import type DraftSessionController from "./workbench/thread-view/DraftSessionController";
import resolveThreadActivityTimestampMs from "./workbench/thread-view/thread-activity-timestamp";
import { formatThreadRelativeTimestamp, getThreadTitle } from "./workbench/thread-view/thread-view-formatters";
import ThreadScrollViewport from "./workbench/thread-view/ThreadScrollViewport";
import ThreadView from "./workbench/thread-view/ThreadView";
import ThreadShellTitleInput from "./workbench/ThreadShellTitleInput";
import {
    useWorkbenchClientMount,
    useWorkbenchProjectThreadSidebar,
    useWorkbenchProjectThreadSidebars,
    useWorkbenchProjectThreadSummaries,
    useWorkbenchThreads,
} from "./workbench/use-workbench-client";
import {
    workbenchFloatingToolbarClassName,
    workbenchFloatingToolbarGroupClassName,
    workbenchNewEntryButtonClassName,
    workbenchOptionHoverClassName,
    workbenchOptionRowClassName,
    workbenchRevisionActionButtonClassName,
    workbenchRevisionHoverToolbarClassName
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
    DraftThreadIcon,
    ExternalLinkIcon,
    FolderOpenIcon,
    GearIcon, ImageIcon, ProjectIcon,
    SaveIcon,
    SearchIcon,
    SidebarCollapseIcon,
    SidebarExpandIcon,
    SparkleIcon,
    StatsIcon
} from "./workbench/workbench-icons";
import WorkbenchAmbientCanvas, { type WorkbenchAmbientCanvasVariant } from "./workbench/WorkbenchAmbientCanvas";
import WorkbenchBrowseSessionsSection from "./workbench/WorkbenchBrowseSessionsSection";
import WorkbenchClientProvider from "./workbench/WorkbenchClientProvider";
import WorkbenchComposerProfileProvider from "./workbench/WorkbenchComposerProfileProvider";
import type { WorkbenchContextMenuDefinition } from "./workbench/WorkbenchContextMenuContext";
import WorkbenchContextMenuProvider from "./workbench/WorkbenchContextMenuProvider";
import WorkbenchFolderSidebar from "./workbench/WorkbenchFolderSidebar";
import WorkbenchIconButton from "./workbench/WorkbenchIconButton";
import WorkbenchProjectControl from "./workbench/WorkbenchProjectControl";
import WorkbenchProjectIcon from "./workbench/WorkbenchProjectIcon";
import WorkbenchProjectLocationLabel from "./workbench/WorkbenchProjectLocationLabel";
import WorkbenchProjectLocationMenu from "./workbench/WorkbenchProjectLocationMenu";
import WorkbenchSearchDialog from "./workbench/WorkbenchSearchDialog";
import WorkbenchSettingsView from "./workbench/WorkbenchSettingsView";
import { workbenchRouteViews } from "./workbench/route-views/workbench-route-views";
import WorkbenchSidebarPreferencesProvider from "./workbench/WorkbenchSidebarPreferencesProvider";
import WorkbenchSidebarSectionDisclosure from "./workbench/WorkbenchSidebarSectionDisclosure";
import WorkbenchTabIcon, { type WorkbenchTabIconState } from "./workbench/WorkbenchTabIcon";
import WorkbenchThreadSidebar from "./workbench/WorkbenchThreadSidebar";
import WorkbenchThreadSidebarActionsProvider from "./workbench/WorkbenchThreadSidebarActions";
import WorkbenchThreadTooltipDetails from "./workbench/WorkbenchThreadTooltipDetails";
import WorkbenchWorkspace from "./workbench/WorkbenchWorkspace";
import { WorkbenchDaemonAssetOriginContext, WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "./workbench/WorkbenchWorkspaceContext";
import WorkbenchZoomButton from "./workbench/WorkbenchZoomButton";

installBrowserRandomUuidPolyfill();

const MOBILE_SHELL_HEADER_HIDE_THRESHOLD_PX = 24;
const MOBILE_SHELL_HEADER_SHOW_THRESHOLD_PX = 8;
const MOSAIC_RATE_LIMIT_REFRESH_INTERVAL_MS = 15_000;
const EDITOR_FONT_CLASS_NAMES: Record<WorkbenchEditorFontFamily, string> = {
  mono: "font-mono",
  sans: "font-sans",
  serif: "font-serif",
};

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

function formatQuickOpenTimestamp (updatedAt: string | null | undefined) {
  if (!updatedAt) {
    return "Unknown time";
  }

  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return date.toLocaleString([], {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
  });
}

function formatQuickOpenChangeSummary (additions: number, deletions: number) {
  const parts: string[] = [];
  if (additions) {
    parts.push(`+${additions}`);
  }
  if (deletions) {
    parts.push(`-${deletions}`);
  }
  return parts.join(" ");
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

function isThreadStatusActive (status: string) {
  return status === "active" || status.startsWith("active:");
}

function isThreadStatusWaitingOnUserInput (status: string) {
  if (!status.startsWith("active:")) {
    return false;
  }

  const [, activeFlags = ""] = status.split(":", 2);
  return activeFlags.split(",").includes("waitingOnUserInput");
}

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

function clampEditorFontSize (value: number) {
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Number(value.toFixed(2))));
}

function getProjectTabLabel (projectName: string | null | undefined) {
  return projectName?.trim() || "Project";
}

const THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;

export default function Workbench ({ appRuntime = null }: { appRuntime?: WorkbenchAppRuntimeStore | null }) {
  const appRpc = useWorkbenchAppRpc();
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const [composerProfileControllers] = useState(() => new Map<string, WorkbenchComposerProfileController>());
  const initialRoute = new WorkbenchProjectNavigation([], clientStateController.getProjectAliases())
    .readRoute(typeof window === "undefined" ? "/" : window.location.href,
      clientState.records.find(record => record.kind === "lastLaunchTarget")?.projectId);
  const currentRouteRef = useRef<WorkbenchRoute>(initialRoute);
  const activeDraftSessionRef = useRef<DraftSessionController<WorkbenchComposerInputDraft> | null>(null);
  const workbenchClient = useWorkbenchClientMount({
    appRpc,
    clientStateController,
    getDomSurfaces: getWorkbenchDomSurfaces,
    initialRoute,
  });
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
  const projectHref = useWorkbenchProjectNavigation(workbenchClient);
  currentRouteRef.current = route;
  const threads = useWorkbenchThreads(workbenchClient);
  const explorer = workbenchClient.explorer;
  const displayedLogicalProjects = explorer.logicalProjects?.length
    ? explorer.logicalProjects
    : explorer.projects.length ? undefined : explorer.logicalProjects;
  const projectThreadSidebars = useWorkbenchProjectThreadSidebars(workbenchClient);
  const projectThreadSummaries = useWorkbenchProjectThreadSummaries(workbenchClient);
  const appProjectGroups = displayedLogicalProjects
    && (explorer.workspaceProjectGroupsPhase === "current"
      || explorer.workspaceProjectGroupsPhase === "stale")
    ? explorer.workspaceProjectGroups : null;
  const unarchivedProjectIds = useMemo(() => new Set<string>(appProjectGroups?.unarchivedProjectIds
    ?? (displayedLogicalProjects
      ? (explorer.logicalThreads ?? []).filter(row => row.entry.entryKind !== "subagent"
        && !row.entry.metadata.archived).map(row => row.logicalProjectId)
      : projectThreadSidebars.projects.flatMap(sidebar => sidebar.entries
        .filter(entry => entry.entryKind !== "subagent" && !entry.metadata.archived)
        .map(() => sidebar.projectId)))), [appProjectGroups, displayedLogicalProjects, explorer.logicalThreads,
    projectThreadSidebars.projects]);
  const unsettledProjectIds = useMemo(() => new Set<string>(appProjectGroups?.unsettledProjectIds
    ?? (displayedLogicalProjects
      ? displayedLogicalProjects.filter(project => explorer.logicalSummaries?.[project.id]?.unsettledThreads.length)
        .map(project => project.id)
      : projectThreadSummaries.projects.filter(summary => summary.unsettledThreads.length)
        .map(summary => summary.projectId))), [appProjectGroups, displayedLogicalProjects,
    explorer.logicalSummaries, projectThreadSummaries.projects]);
  const orderedProjectIds = appProjectGroups?.orderedProjectIds
    ?? (displayedLogicalProjects ?? explorer.projects).map(project => project.id);
  const selectionProjectIds = useMemo(() => resolveSelectedProjectIds(
    (displayedLogicalProjects ?? explorer.projects).map(project => project.id),
    route.selectedProjectIds, unarchivedProjectIds,
  ), [displayedLogicalProjects, explorer.projects, route.selectedProjectIds, unarchivedProjectIds]);
  const settingsRoute = useMemo(() => withProjectSelection(
    createSettingsRoute(""),
    selectionProjectIds.length ? selectionProjectIds : null,
  ), [selectionProjectIds]);
  const settingsHref = projectHref(settingsRoute) ?? createWorkbenchHref(settingsRoute);
  // Statistics keep the sidebar's project selection so the view can scope to it.
  const statsRoute = useMemo(() => withProjectSelection(
    createStatsRoute(null),
    selectionProjectIds.length ? selectionProjectIds : null,
  ), [selectionProjectIds]);
  const dynamicSelectionPending = route.selectedProjectIds === null
    && !appProjectGroups && explorer.isThreadsLoading;
  const selectedLogicalProjects = useMemo(() => selectionProjectIds.flatMap(id => {
    const project = displayedLogicalProjects?.find(candidate => candidate.id === id);
    return project?.locations.some(location => location.project) ? [project] : [];
  }), [displayedLogicalProjects, selectionProjectIds]);
  const selectedPhysicalProjects = useMemo(() => selectionProjectIds.flatMap(id => {
    const project = explorer.projects.find(candidate => candidate.id === id);
    return project ? [project] : [];
  }), [explorer.projects, selectionProjectIds]);
  const currentThread = threads.current;
  const threadDocuments = threads.documents;
  const [threadRelativeTimeNowMs, setThreadRelativeTimeNowMs] = useState(() => Date.now());
  const harnessUserInputRequestsByThreadId = threads.pendingQuestionnairesByThreadId;
  const [localSelectionError, setSelectionError] = useState("");
  useEffect(() => {
    if (navigationState?.phase === "ready") setSelectionError("");
  }, [navigationState?.phase, navigationState?.generation]);
  const presentationState = workbenchClient.mounted?.presentationClient?.snapshot();
  const selectionError = (navigationState?.phase === "failed" ? navigationState.error ?? "" : "")
    || localSelectionError
    || (workbenchClient.startup.phase === "failed" ? workbenchClient.startup.error ?? "" : "")
    || (presentationState?.phase === "failed" ? presentationState.error ?? "" : "");
  const retryPresentation = useCallback(() => {
    void workbenchClient.mounted?.presentationClient?.refresh().catch(error =>
      console.warn("Project identities could not refresh:",
        error instanceof Error ? error.message.slice(0, 512) : "Unknown failure."));
  }, [workbenchClient.mounted]);
  const [isProjectRotationPending, setIsProjectRotationPending] = useState(false);
  const controls = workbenchClient.controls;
  const routeExistingThreadId = route.view === "thread" && route.logical
    && (route.threadTarget?.kind === "provider" || route.threadTarget?.kind === "subagent")
    ? getWorkbenchThreadTargetRootId(route.threadTarget) : null;
  const routeThreadContext = routeExistingThreadId
    ? workbenchClient.mounted?.threadContextFor(routeExistingThreadId) : null;
  const routeDraftId = route.view === "thread" && route.logical
    ? route.threadTarget?.kind === "draft" ? route.threadTarget.draftId
      : route.threadTarget?.kind === "new" && currentThread?.isDraft ? currentThread.id : null
    : null;
  const routeDraftContext = routeDraftId
    ? workbenchClient.mounted?.draftContextFor(routeDraftId) : null;
  const routeLaunchLocation = route.view === "thread" && route.logical
    && route.threadTarget?.kind === "draft"
    ? workbenchClient.mounted?.presentationClient?.draft(route.threadTarget.draftId)?.target
      ?? workbenchClient.mounted?.draftLocationFor(route.threadTarget.draftId)
    : route.view === "thread" && route.logical && route.threadTarget?.kind === "new"
      ? currentThread?.isDraft ? workbenchClient.mounted?.draftLocationFor(currentThread.id) : null
      : null;
  const routeOwnerMetadata = routeExistingThreadId
    ? workbenchClient.mounted?.threadOwnerFor(routeExistingThreadId) : null;
  const browseLocation = explorer.browseLocation ?? null;
  const browseDaemon = useMemo(() => browseLocation
    ? workbenchClient.mounted?.workspace.daemon({ kind: "folder", location: browseLocation }) ?? null
    : route.logical ? null : controls?.daemon ?? null,
  [workbenchClient.mounted, browseLocation?.daemonId, browseLocation?.projectId, Boolean(route.logical), controls]);
  const selectedDaemon = routeExistingThreadId
    ? routeThreadContext?.daemon ?? null
    : routeDraftContext?.daemon ?? (route.view === "thread" && route.logical
      ? routeLaunchLocation ? workbenchClient.mounted?.launchContextFor(routeLaunchLocation)?.daemon ?? null : null
      : browseDaemon);
  const selectedAssetSource = routeExistingThreadId
    ? routeThreadContext?.assetSource ?? { kind: "unavailable" as const }
    : routeDraftContext?.assetSource ?? (browseLocation
      ? { kind: "source" as const, daemonId: browseLocation.daemonId }
      : { kind: "unavailable" as const });
  const profileScopeKey = routeThreadContext?.daemonId ?? routeDraftContext?.daemonId
    ?? routeLaunchLocation?.daemonId
    ?? workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId
    ?? "attached";
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
  const [isMobile, setIsMobile] = useState(false);
  const [mobileShellHeaderHeight, setMobileShellHeaderHeight] = useState(0);
  const [isMobileShellHeaderVisible, setIsMobileShellHeaderVisible] = useState(true);
  const [mobilePane, setMobilePane] = useState<MobilePane>("explorer");
  const [settingsPageTitle, setSettingsPageTitle] = useState("General");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [pendingDeleteFilePath, setPendingDeleteFilePath] = useState("");
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [projectActionError, setProjectActionError] = useState("");
  const globalSettings = useMemo(
    () => readGlobalWorkbenchSettings(clientState.records),
    [clientState.records],
  );
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");
  const [quickOpenUpdatedAtByPath, setQuickOpenUpdatedAtByPath] = useState<Record<string, string>>({});
  const [workspaceController] = useState(() => new WorkbenchWorkspaceController({
    createDraft: () => {
      throw new Error("Workspace draft creation is not connected.");
    },
    navigateMosaic: () => undefined,
    navigatePanel: () => undefined,
    navigateProject: () => undefined,
  }));
  const editorRef = useRef<HTMLDivElement>(null);
  const mainPaneRef = useRef<HTMLElement>(null);
  const directThreadScrollViewportRef = useRef<HTMLDivElement>(null);
  const customCaretRef = useRef<HTMLDivElement>(null);
  const diffGutterRef = useRef<HTMLDivElement>(null);
  const floatingToolbarRef = useRef<HTMLDivElement>(null);
  const revisionHoverToolbarRef = useRef<HTMLDivElement>(null);
  const revisionHoverAcceptButtonRef = useRef<HTMLButtonElement>(null);
  const revisionHoverRejectButtonRef = useRef<HTMLButtonElement>(null);
  const filePathLabelRef = useRef<HTMLParagraphElement>(null);
  const statusLineRef = useRef<HTMLParagraphElement>(null);
  const resetDraftButtonRef = useRef<HTMLButtonElement>(null);
  const saveFileButtonRef = useRef<HTMLButtonElement>(null);
  const shellHeaderRef = useRef<HTMLElement>(null);
  const zoomButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictDialogRef = useRef<HTMLDivElement>(null);
  const saveConflictSummaryRef = useRef<HTMLParagraphElement>(null);
  const saveConflictExpectedRef = useRef<HTMLParagraphElement>(null);
  const saveConflictActualRef = useRef<HTMLParagraphElement>(null);
  const saveConflictKeepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictReloadButtonRef = useRef<HTMLButtonElement>(null);
  const saveConflictOverwriteButtonRef = useRef<HTMLButtonElement>(null);
  const resetDraftDialogRef = useRef<HTMLDivElement>(null);
  const resetDraftCancelButtonRef = useRef<HTMLButtonElement>(null);
  const resetDraftHeadButtonRef = useRef<HTMLButtonElement>(null);
  const resetDraftSavedButtonRef = useRef<HTMLButtonElement>(null);
  const mobileShellHeaderAnimationFrameRef = useRef<number | null>(null);
  const mobileShellHeaderScrollYRef = useRef(0);
  const mobileShellHeaderDirectionRef = useRef<"up" | "down" | null>(null);
  const mobileShellHeaderDirectionTravelRef = useRef(0);
  const mobileShellHeaderVisibleRef = useRef(true);
  const retainedThreadRef = useRef<ThreadPayload | null>(null);
  const threadViewInstanceKeysByThreadIdRef = useRef(new Map<string, string>());
  const searchActivationRef = useRef<(result: WorkbenchSearchHit) => void>(() => undefined);
  const searchController = useMemo(() => new WorkbenchSearchController({
    activate: (result) => searchActivationRef.current(result),
    observe: (request, publish) => {
      if (!workbenchClient.mounted) {
        publish({ phase: "pending", failure: null, value: null });
        return () => {};
      }
      const query = workbenchClient.mounted.workspace.observe({ kind: "search", request });
      const stop = query.subscribe(() => publish(query.getSnapshot()));
      publish(query.getSnapshot());
      return () => { stop(); query.release(); };
    },
  }), [controls, workbenchClient.mounted]);
  const workbenchDragController = useMemo(() => new WorkbenchDragController(), []);
  const workbenchDragActivity = useSyncExternalStore(workbenchDragController.subscribe, workbenchDragController.getActivitySnapshot, workbenchDragController.getActivitySnapshot);
  const activeWorkbenchDrag = workbenchDragActivity.active && workbenchDragActivity.payload
    ? { payload: workbenchDragActivity.payload }
    : null;
  useEffect(() => () => { workbenchDragController.dispose(); }, [workbenchDragController]);
  useEffect(() => () => { searchController.dispose(); }, [searchController]);
  useEffect(() => () => { workspaceController.dispose(); }, [workspaceController]);

  function getWorkbenchDomSurfaces (): WorkbenchDomSurfaces | null {
    if (
      !editorRef.current
      || !customCaretRef.current
      || !diffGutterRef.current
      || !floatingToolbarRef.current
      || !revisionHoverToolbarRef.current
      || !revisionHoverAcceptButtonRef.current
      || !revisionHoverRejectButtonRef.current
      || !filePathLabelRef.current
      || !statusLineRef.current
      || !resetDraftButtonRef.current
      || !saveFileButtonRef.current
      || !zoomButtonRef.current
      || !saveConflictDialogRef.current
      || !saveConflictSummaryRef.current
      || !saveConflictExpectedRef.current
      || !saveConflictActualRef.current
      || !saveConflictKeepEditingButtonRef.current
      || !saveConflictReloadButtonRef.current
      || !saveConflictOverwriteButtonRef.current
      || !resetDraftDialogRef.current
      || !resetDraftCancelButtonRef.current
      || !resetDraftHeadButtonRef.current
      || !resetDraftSavedButtonRef.current
    ) {
      return null;
    }

    return {
      controls: {
        resetDraftButton: resetDraftButtonRef.current,
        saveFileButton: saveFileButtonRef.current,
        zoomButton: zoomButtonRef.current,
      },
      dialogs: {
        saveConflict: {
          dialog: saveConflictDialogRef.current,
          summary: saveConflictSummaryRef.current,
          expected: saveConflictExpectedRef.current,
          actual: saveConflictActualRef.current,
          keepEditing: saveConflictKeepEditingButtonRef.current,
          reload: saveConflictReloadButtonRef.current,
          overwrite: saveConflictOverwriteButtonRef.current,
        },
        resetDraft: {
          dialog: resetDraftDialogRef.current,
          cancel: resetDraftCancelButtonRef.current,
          resetToHead: resetDraftHeadButtonRef.current,
          resetToSaved: resetDraftSavedButtonRef.current,
        },
      },
      editor: {
        editor: editorRef.current,
        customCaret: customCaretRef.current,
        diffGutter: diffGutterRef.current,
      },
      statusDisplay: {
        filePathLabel: filePathLabelRef.current,
        statusLine: statusLineRef.current,
      },
      toolbars: {
        floating: floatingToolbarRef.current,
        revisionHover: revisionHoverToolbarRef.current,
        revisionAccept: revisionHoverAcceptButtonRef.current,
        revisionReject: revisionHoverRejectButtonRef.current,
      },
    };
  }

  const selectedThreadProjectId = route.view === "thread"
    ? route.threadOwnerProjectId || explorer.currentProjectId || route.projectId
    : explorer.currentProjectId;
  const selectedThreadSidebar = useWorkbenchProjectThreadSidebar(selectedThreadProjectId, workbenchClient);
  const threadComposerDraftsByThreadId = useMemo(() => projectComposerDrafts(
    clientState.records,
    threadId => route.logical
      ? workbenchClient.mounted?.threadDraftIdentityFor(threadId) ?? null
      : selectedThreadProjectId ? {
        daemonRegistrationId: clientState.daemonRegistrationId,
        projectId: ProjectIdSchema.parse(selectedThreadProjectId),
        threadId: ThreadReferenceSchema.parse(threadId),
      } : null,
  ), [clientState.daemonRegistrationId, clientState.records, explorer.logicalThreads,
    route.logical, selectedThreadProjectId, workbenchClient.mounted]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const applyMatch = () => {
      setIsMobile(mediaQuery.matches);
      setMobilePane(getPreferredMobilePane(mediaQuery.matches, route));
    };

    applyMatch();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", applyMatch);
    } else {
      mediaQuery.addListener(applyMatch);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", applyMatch);
      } else {
        mediaQuery.removeListener(applyMatch);
      }
    };
  }, [route]);

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
  const selectedLogicalProject = explorer.logicalProjects?.find(project =>
    project.id === route.logical?.projectId) ?? null;
  const viewedProjectId = route.logical ? route.logical.projectId ?? "" : activeProjectId;
  const browseProjectId = browseLocation?.projectId ?? explorer.currentProjectId;
  const folderOptions =
    workbenchClient.mounted?.projectNavigator?.folderOptions(selectionProjectIds) ?? [];
  const implicitFolderLocation =
    !route.folderAddress && selectedLogicalProject
      ? folderOptions.find(option =>
        option.name === selectedLogicalProject.displayName
      )?.target ?? null
      : null;
  const selectedFolderLocation =
    browseLocation ?? implicitFolderLocation;
  const folderSelected = Boolean(selectedFolderLocation);
  const attachedProjectId = route.logical
    ? browseProjectId && browseLocation?.daemonId === workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId
      ? browseProjectId : ""
    : browseProjectId;
  const attachedDaemonId = workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId ?? null;
  const statsScope = useMemo(() => resolveStatsProjectScope({
    daemonId: attachedDaemonId,
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
  const threadSummariesById = useMemo(() => new Map<string, ThreadSummary>(explorer.threads.map((thread) => [thread.id, thread])), [explorer.threads]);
  useEffect(() => {
    if (route.view !== "thread" || route.threadTarget?.kind !== "provider") return;
    const providerTarget = route.threadTarget;
    const relationship = explorer.subagents.find((entry) => entry.threadId === providerTarget.threadId
      && (!providerTarget.harness || entry.harness === providerTarget.harness));
    const parentThreadId = relationship?.parentThreadId;
    if (!parentThreadId) return;
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
  }, [explorer.subagents, navigateToRoute, route]);
  const projectFileLinkRoots = useMemo(
    () => createProjectFileLinkRoots(explorer.projects, browseProjectId, explorer.roots),
    [browseProjectId, explorer.projects, explorer.roots],
  );
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
  const projectSettings = useMemo(() => (
    settingsLogicalProjectId
      ? readLogicalProjectWorkbenchSettings(settingsLogicalProjectId, clientState.records)
      : createDefaultProjectWorkbenchSettings()
  ), [settingsLogicalProjectId, clientState.records]);
  const resolvedSettings = resolveWorkbenchSettings(globalSettings, projectSettings);
  const [editorFontSizePreview, setEditorFontSizePreview] = useState<number | null>(null);
  const displayedEditorFontSize = editorFontSizePreview ?? resolvedSettings.editorFontSize;
  const showUnopenableFiles = resolvedSettings.showUnopenableFiles;
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
  const editorFontClassName = EDITOR_FONT_CLASS_NAMES[resolvedSettings.editorFontFamily];

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

  const updateGlobalSetting = useCallback(<K extends WorkbenchSettingKey> (key: K, value: WorkbenchGlobalSettings[K]) => {
    const nextValue = (key === "editorFontSize" && typeof value === "number"
      ? clampEditorFontSize(value)
      : value) as WorkbenchGlobalSettings[K];
    void writeGlobalWorkbenchSetting(clientStateController, key, nextValue).catch((error: Error) => {
      setSelectionError(error.message);
    });
  }, [clientStateController]);

  const updateProjectSetting = useCallback(<K extends WorkbenchSettingKey> (key: K, value: WorkbenchGlobalSettings[K]) => {
    if (!settingsLogicalProjectId) {
      return;
    }

    const nextValue = (key === "editorFontSize" && typeof value === "number"
      ? clampEditorFontSize(value)
      : value) as WorkbenchGlobalSettings[K];
    void writeLogicalProjectWorkbenchSetting(clientStateController, settingsLogicalProjectId, key, {
      enabled: true,
      value: nextValue,
    }).catch((error: Error) => {
      setSelectionError(error.message);
    });
  }, [settingsLogicalProjectId, clientStateController]);

  const updateThreadCodeBlockWrapSetting = useCallback((nextValue: boolean) => {
    if (settingsLogicalProjectId) {
      updateProjectSetting("threadCodeBlockWrap", nextValue);
      return;
    }

    updateGlobalSetting("threadCodeBlockWrap", nextValue);
  }, [settingsLogicalProjectId, updateGlobalSetting, updateProjectSetting]);

  useEffect(() => {
    document.documentElement.dataset.workbenchTheme = resolvedSettings.theme;
  }, [resolvedSettings.theme]);

  const updateEditorFontSize = useCallback((fontSize: number) => {
    if (projectSettings.editorFontSize.enabled) {
      updateProjectSetting("editorFontSize", fontSize);
      return;
    }
    updateGlobalSetting("editorFontSize", fontSize);
  }, [
    projectSettings.editorFontSize.enabled,
    updateGlobalSetting,
    updateProjectSetting,
  ]);

  const openSettingsFromLink = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    navigateToRoute(settingsRoute);
  }, [navigateToRoute, settingsRoute]);

  const openStatsFromLink = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }

    event.preventDefault();
    navigateToRoute(statsRoute);
  }, [navigateToRoute, statsRoute]);

  const openStatsThreadFromLink = useCallback((
    event: MouseEvent<HTMLAnchorElement>,
    projectId: string,
    threadId: string,
  ) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }

    event.preventDefault();
    navigateToRoute(createThreadRoute(projectId, threadId));
  }, [navigateToRoute]);

  const selectProjectFromLink = useCallback((event: MouseEvent<HTMLAnchorElement>, projectId: string, logical = false) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }

    if (!projectId) {
      return;
    }

    event.preventDefault();
    const order = (displayedLogicalProjects ?? explorer.projects).map(project => project.id);
    navigateToRoute(createToggledProjectSelectionRoute(route, selectionProjectIds, projectId, order),
      { selection: "exact" });
  }, [displayedLogicalProjects, explorer.projects, navigateToRoute, route, selectionProjectIds]);

  const onInvalidFileLocation = useCallback(() => {
    setSelectionError("The thread's file location is invalid.");
  }, []);
  const browseFileScope = useMemo(() => ({
    daemon: browseDaemon,
    daemonId: browseLocation?.daemonId,
    projectId: browseProjectId,
  }), [browseDaemon, browseLocation?.daemonId, browseProjectId]);
  const openFileByPolicy = useFileActions({
    behavior: resolvedSettings.fileOpenBehavior,
    browseLocation,
    currentProjectId: explorer.currentProjectId,
    defaultDaemon: controls?.daemon ?? null,
    logicalProjects: explorer.logicalProjects,
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
      const owner = explorer.logicalProjects?.find(project =>
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
  const searchActionContext = useMemo<WorkbenchActionContext>(() => ({
    createThread: () => {
      if (workbenchClient.mounted?.presentationClient) {
        const project = selectedLogicalProject ?? selectedLogicalProjects[0];
        const location = project?.locations.find(item => item.project)?.target;
        if (project && location) navigateToRoute(createLogicalThreadRoute(
          route.logical?.projectId ?? null, project.id, location, { kind: "new" },
        ));
      }
      else if (selectedPhysicalProjects[0]) navigateToRoute(createThreadRoute(selectedPhysicalProjects[0].id, { kind: "new" }));
    },
    getSidebarThreadLinks: () => Array.from(document.querySelector("aside")?.querySelectorAll<HTMLElement>("[data-workbench-sidebar-thread-link='true']") ?? [])
      .filter((link) => !link.closest("[hidden]")),
    hasDesktopSidebar: !isMobile,
    hasProject: Boolean(viewedProjectId),
    home: () => navigateToRoute(createHomeRoute()),
    openSearch: () => searchController.open(),
    openSettings: () => navigateToRoute(settingsRoute),
    toggleSidebar: () => {
      if (!isMobile) document.querySelector<HTMLElement>("[aria-label='Hide sidebar'], [aria-label='Show sidebar']")?.click();
    },
    zoomIn: () => updateEditorFontSize(resolvedSettings.editorFontSize + 0.08),
    zoomOut: () => updateEditorFontSize(resolvedSettings.editorFontSize - 0.08),
  }), [attachedProjectId, isMobile, navigateToRoute, selectedLogicalProjects, selectedPhysicalProjects, settingsRoute,
    resolvedSettings.editorFontSize, route.logical?.projectId, searchController, selectedLogicalProject,
    updateEditorFontSize, viewedProjectId, workbenchClient.mounted]);
  searchActivationRef.current = (result) => {
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
  };
  useEffect(() => {
    searchController.setProjectId(viewedProjectId || null);
  }, [searchController, viewedProjectId]);
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
          const projectId = submittedRoute.threadOwnerProjectId || submittedRoute.projectId || explorer.currentProjectId;
          const submittedThreadKey = `${projectId}:${thread.harness}:${thread.id}`;
          const materializedThreadKey = `${projectId}:${materializedThread.harness}:${materializedThread.id}`;
          threadViewInstanceKeysByThreadIdRef.current.set(
            materializedThreadKey,
            threadViewInstanceKeysByThreadIdRef.current.get(submittedThreadKey) ?? thread.id,
          );
          replaceCurrentDraftThreadRoute(materializedThread);
          options?.onThreadLaunched?.(materializedThread);
        },
      }
      : submittedOptions;
    const resolvedInput = thread.isDraft ? input : await Promise.all(input.map(async item => item.type === "image"
      ? { ...item, url: await clientStateController.resolveDraftAttachmentUrl(item.url) }
      : item));
    return await controls.sendThreadMessage(thread, resolvedInput, materializedOptions);
  }, [clientStateController, composerProfileController, controls, navigateToRoute, profileControllerFor, workbenchClient.mounted, workspaceController]);

  const activeSidebarDraftId = route.view === "thread" && route.threadTarget?.kind === "draft"
    ? route.threadTarget.draftId
    : "";
  const activeSidebarDraft = useMemo(() => {
    if (!activeSidebarDraftId) return null;
    const entry = selectedThreadSidebar?.entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === activeSidebarDraftId);
    return entry?.entryKind === "draft" ? entry.draft : null;
  }, [activeSidebarDraftId, selectedThreadSidebar]);
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
          logicalProjectId, explorer.logicalThreads ?? [], presentation,
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
          const selection = draftProfiles.getSelection(slot);
          if (selection.kind === "profile" && selection.settings) {
            return { kind: "profile" as const, profileId: selection.profileId,
              settings: selection.settings };
          }
          if (selection.kind === "custom" && selection.settings) {
            return { kind: "custom" as const, settings: selection.settings };
          }
          return {
            kind: "custom" as const,
            settings: {
              agentPath: draftThread?.agentPath ?? null, agentSource: null,
              harness: draftThread?.harness ?? defaultProviderKey, model: draftThread?.model ?? "",
              reasoningEffort: draftThread?.reasoningEffort ?? null,
              serviceTier: draftThread?.serviceTier === "fast" ? "fast" as const : null,
              contextWindowTokens: draftThread?.contextWindowTokens ?? null,
            },
          };
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
  }, [controls, currentThread, explorer.logicalThreads, navigateToRoute, profileControllerFor, route, workbenchClient, workspaceController]);

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

  const mobileTrackStyle = isMobile
    ? { transform: mobilePane === "explorer" ? "translateX(0)" : "translateX(-50%)" }
    : undefined;
  const createDialogParentLabel = createDialogParentPath || "project";
  const quickOpenPaths = Array.from(new Set([
    ...explorer.locallyModifiedPaths,
    ...Object.keys(explorer.changes),
  ]))
    .filter((path) => isWorkbenchOpenableFile(path))
    .slice(0, 8);
  const canOpenFileFromExplorer = useCallback((path: string) => (
    resolvedSettings.fileOpenBehavior !== "workbench" || isWorkbenchOpenableFile(path)
  ), [resolvedSettings.fileOpenBehavior]);
  const mobileMosaicFallbackTarget = route.view === "mosaic"
    ? getRouteMosaicFallbackTarget(route.mosaicNode, isMobile)
    : null;
  const showMosaicView = route.view === "mosaic" && !mobileMosaicFallbackTarget;
  const showThreadView = route.view === "thread" || mobileMosaicFallbackTarget?.kind === "thread";
  const showFileView = route.view === "file" || mobileMosaicFallbackTarget?.kind === "file";
  // New full-page views belong in workbenchRouteViews, not new show* booleans; settings/stats/git should migrate there.
  const routeView = workbenchRouteViews[route.view] ?? null;
  const newProjectRoute = useMemo(() => withProjectSelection(createNewProjectRoute(), route.selectedProjectIds),
    [route.selectedProjectIds]);
  const showSettingsView = route.view === "settings";
  const selectedSettingsProject = selectionProjectIds.length === 1
    ? displayedLogicalProjects?.find(project => project.id === selectionProjectIds[0]) ?? null
    : null;
  const showStatsView = route.view === "stats";
  const showGitView = route.view === "git";
  const sidebarCreateProjectId = workbenchClient.mounted?.presentationClient
    ? (selectedLogicalProject ?? selectedLogicalProjects[0])?.locations
      .find(location => location.project)?.target.projectId ?? browseLocation?.projectId ?? ""
    : selectedPhysicalProjects[0]?.id || "";
  const showFullBleedMainView = showMosaicView;
  const createThreadFromSidebar = useCallback((ownerProjectId: string, folderId?: FolderId) => {
    if (showMosaicView || !controls) return;
    const target = folderId ? { folderId, kind: "new" as const } : { kind: "new" as const };
    if (workbenchClient.mounted?.presentationClient) {
      if (!explorer.logicalProjects?.length) {
        setSelectionError("Project identities are not ready yet.");
        return;
      }
      const selected = route.logical?.projectId
        ? explorer.logicalProjects.find(project => project.id === route.logical?.projectId)
        : explorer.logicalProjects.find(project => project.id === ownerProjectId)
          ?? explorer.logicalProjects.find(project => project.locations.some(location =>
          location.target.projectId === ownerProjectId
          && location.daemonId === workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId))
          ?? explorer.logicalProjects.find(project => project.locations.some(location =>
            location.target.projectId === ownerProjectId))
          ?? selectedLogicalProjects[0];
      if (selected) {
        const location = route.logical?.projectId === selected.id ? route.logical.location
            ?? selected.locations.find(item => item.project)?.target
            ?? selected.locations[0]?.target ?? null
          : selected.locations.find(item => item.project)?.target
            ?? selected.locations[0]?.target ?? null;
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
  }, [controls, explorer.logicalProjects, navigateToRoute, route, selectedLogicalProjects, showMosaicView, workbenchClient.mounted]);
  const handleThreadSettled = useCallback((settledTarget: WorkbenchThreadTarget, ownerProjectId?: string) => {
    const currentRoute = currentRouteRef.current;
    if (currentRoute.view !== "thread"
      || (!currentRoute.logical && ownerProjectId
        && (currentRoute.threadOwnerProjectId || currentRoute.projectId) !== ownerProjectId)
      || !isWorkbenchThreadTargetSelected(settledTarget, currentRoute.threadTarget)) {
      return;
    }

    if (currentRoute.logical) {
      navigateToRoute(currentRoute.logical.projectId
        ? createLogicalProjectRoute(currentRoute.logical.projectId,
          currentRoute.logical.browseLocation ?? null)
        : createHomeRoute());
      return;
    }
    const targetProjectId = ownerProjectId || currentRoute.threadOwnerProjectId || currentRoute.projectId;
    navigateToRoute(!currentRoute.projectId
      ? createHomeThreadRoute(targetProjectId, { kind: "new" })
      : createThreadRoute(currentRoute.projectId, { kind: "new" }));
  }, [navigateToRoute]);
  const usesDesktopSidebarCollapse = !isMobile;
  const effectiveThreadTarget = mobileMosaicFallbackTarget?.kind === "thread" ? mobileMosaicFallbackTarget.target : route.threadTarget;
  const effectiveThreadId = effectiveThreadTarget ? getWorkbenchThreadTargetRootId(effectiveThreadTarget) : route.threadId;
  const effectiveSelectedThreadId = effectiveThreadTarget ? getWorkbenchThreadTargetSelectedId(effectiveThreadTarget) : effectiveThreadId;
  const effectiveFilePath = mobileMosaicFallbackTarget?.kind === "file" ? mobileMosaicFallbackTarget.filePath : route.filePath;
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
  const getThreadViewInstanceKey = (thread: ThreadPayload) => (
    threadViewInstanceKeysByThreadIdRef.current.get(`${activeProjectId}:${thread.harness}:${thread.id}`) ?? thread.id
  );
  const isThreadOwnedByEffectiveRoute = (thread: ThreadPayload | null) => Boolean(
    showThreadView
    && thread
    && (
      isWorkbenchRouteOwnerOfThread(effectiveThreadRoute, thread.id, thread.isDraft)
      || isWorkbenchRouteOwnerOfThread(effectiveThreadRoute, getThreadViewInstanceKey(thread), getThreadViewInstanceKey(thread) !== thread.id)
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
  const threadSummaryForThreadView = showThreadView ? threadSummariesById.get(effectiveThreadId) ?? null : null;
  const threadShellSource = threadForThreadView ?? threadSummaryForThreadView;
  const threadShellActivityTimestampMs = resolveThreadActivityTimestampMs(threadShellSource, threadSummaryForThreadView);
  const isThreadShellTitleLoading = showThreadView && !threadShellSource;
  const threadShellTitle = threadShellSource ? getThreadTitle(threadShellSource) : "";
  const threadShellStatusLabel = threadShellActivityTimestampMs
    ? formatThreadRelativeTimestamp(threadShellActivityTimestampMs / 1000, threadRelativeTimeNowMs)
    : "";
  const isThreadViewReady = showThreadView && Boolean(threadForThreadView);
  const isFileViewReady = showFileView && !currentThread && explorer.currentPath === effectiveFilePath;
  const isSelectionPending = !selectionError && ((showThreadView && !isThreadViewReady) || (showFileView && !isFileViewReady));
  const threadViewInstanceKey = threadForThreadView ? getThreadViewInstanceKey(threadForThreadView) : effectiveThreadId;
  const selectedThreadIdForView = effectiveThreadTarget?.kind === "new" && threadForThreadView
    ? threadForThreadView.id
    : effectiveSelectedThreadId;
  const activeThreadId = showThreadView ? threadViewInstanceKey : "";
  const activeFilePath = showFileView ? effectiveFilePath : "";
  const visibleUserInputRequestsByThreadId = harnessUserInputRequestsByThreadId;
  const threadAttentionLabelsById = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const project of projectThreadSummaries.projects) {
      for (const entry of project.pinnedThreads) {
        if (entry.entryKind === "thread" && (entry.canCompleteQuestionnaire || (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput"))) {
          labels[entry.identity.threadId] = "Questionnaire";
        }
      }
    }
    for (const project of projectThreadSidebars.projects) {
      for (const entry of project.entries) {
        if (entry.entryKind !== "draft" && entry.pendingQuestionnaire) labels[entry.identity.threadId] = getQuestionnaireTitle(entry.pendingQuestionnaire.request);
      }
    }
    for (const [threadId, pending] of Object.entries(visibleUserInputRequestsByThreadId)) labels[threadId] = getQuestionnaireTitle(pending.request);
    return labels;
  }, [projectThreadSidebars.projects, projectThreadSummaries.projects, visibleUserInputRequestsByThreadId]);
  const pendingQuestionnaireThreadIds = useMemo(
    () => new Set(Object.keys(threadAttentionLabelsById)),
    [threadAttentionLabelsById],
  );
  const threadProjectId = routeThreadContext?.project.id ?? routeDraftContext?.project.id
    ?? (route.view === "thread" ? route.threadOwnerProjectId || route.projectId : route.projectId || activeProjectId);
  const threadSurfaceKey = `${routeThreadContext?.daemonId ?? routeDraftContext?.daemonId ?? "attached"}:${threadProjectId}:${threadViewInstanceKey}`;
  const threadFileScope = useMemo(() => ({
    daemon: selectedDaemon,
    daemonId: routeThreadContext?.daemonId ?? routeDraftContext?.daemonId ?? routeLaunchLocation?.daemonId,
    projectId: threadProjectId,
  }), [selectedDaemon, routeThreadContext?.daemonId, routeDraftContext?.daemonId,
    routeLaunchLocation?.daemonId, threadProjectId]);
  const threadProject = routeThreadContext?.project ?? routeDraftContext?.project
    ?? explorer.projects.find((project) => project.id === threadProjectId) ?? null;
  const logicalThreadProject = explorer.logicalProjects?.find(project =>
    project.id === route.logical?.threadOwnerProjectId
    || routeOwnerMetadata && project.locations.some(location =>
      location.target.daemonId === routeOwnerMetadata.daemonId
      && location.target.projectId === routeOwnerMetadata.projectId)) ?? null;
  const showThreadOwnerLabel = Boolean(routeOwnerMetadata
    && !(selectedLogicalProject?.id === logicalThreadProject?.id
      && selectedLogicalProject?.locations.length === 1));
  const isHomeDraftRoute = route.view === "thread"
    && !route.projectId
    && !route.logical?.projectId
    && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft");
  const rotateHomeDraftProject = useCallback(async () => {
    if (!controls || !isHomeDraftRoute) return;
    const recentProjects = route.logical ? selectedLogicalProjects : selectedPhysicalProjects;
    const currentProjectId = route.logical?.threadOwnerProjectId ?? threadProjectId;
    if (!currentProjectId || recentProjects.length < 2) return;
    const currentIndex = recentProjects.findIndex(({ id }) => id === currentProjectId);
    const nextProject = recentProjects[(currentIndex < 0 ? 0 : currentIndex + 1) % recentProjects.length];
    if (!nextProject || nextProject.id === currentProjectId) return;
    setIsProjectRotationPending(true);
    setSelectionError("");
    try {
      const target = route.threadTarget;
      if (route.logical) {
        const logicalProject = selectedLogicalProjects.find(project => project.id === nextProject.id);
        const destination = logicalProject?.locations.find(item => item.project)?.target;
        if (!logicalProject || !destination) throw new Error("The next project's daemon folder is unavailable.");
        const draftSession = activeDraftSessionRef.current;
        if (target?.kind === "draft") {
          if (!draftSession || !await draftSession.flush("retarget")) {
            throw new Error("Save the draft before changing projects.");
          }
          if (currentRouteRef.current !== route) return;
          await controls.retargetPresentationDraft(target.draftId, destination, logicalProject.id);
          if (currentRouteRef.current !== route) return;
          navigateToRoute(createLogicalThreadRoute(null, logicalProject.id, null, target), { replace: true });
        } else {
          const input = draftSession?.getSnapshot().draft;
          if (input?.text.trim() || input?.attachments.length) {
            throw new Error("Save the draft before changing projects.");
          }
          navigateToRoute(createLogicalThreadRoute(null, logicalProject.id, destination, { kind: "new" }));
        }
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
  }, [controls, isHomeDraftRoute, navigateToRoute, route, selectedLogicalProjects, selectedPhysicalProjects, threadProjectId]);
  const homeRotatorProject = route.logical ? logicalThreadProject
    : explorer.projects.find(project => project.id === threadProject?.id);
  const projectRotator = isHomeDraftRoute && homeRotatorProject ? (
    <WorkbenchProjectControl
      disabled={isProjectRotationPending || (route.logical
        ? selectedLogicalProjects : selectedPhysicalProjects).length < 2}
      onRotate={() => { void rotateHomeDraftProject(); }}
      project={homeRotatorProject}
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
    const cwd = entry.entryKind === "subagent"
      ? entry.cwd
      : threadSummariesById.get(threadId)?.cwd ?? null;
    const ownerProjectId = projectThreadSidebars.projects.find(({ entries }) => entries.some((candidate) => (
      candidate.entryKind !== "draft" && candidate.identity.harness === entry.identity.harness && candidate.identity.threadId === threadId
    )))?.projectId ?? projectThreadSummaries.projects.find(({ pinnedThreads, unsettledThreads }) => (
      pinnedThreads.some((candidate) => candidate.entryKind === "thread" && candidate.identity.harness === entry.identity.harness && candidate.identity.threadId === threadId)
      || unsettledThreads.some((candidate) => candidate.identity.harness === entry.identity.harness && candidate.identity.threadId === threadId)
    ))?.projectId ?? activeProjectId;
    return (
      <WorkbenchThreadTooltipDetails
        cwd={cwd}
        harness={entry.identity.harness}
        materialized={materializedThreadRootIds.has(rootThreadId)}
        onQuestionnaireError={setSelectionError}
        onOpenThread={openThreadFromExplorer}
        projectFilePaths={explorer.projectFilePaths}
        projectId={ownerProjectId}
        projectRootPath={explorer.rootPath}
        spellCheck={resolvedSettings.composerSpellCheck}
        threadId={threadId}
        parentThreadId={entry.entryKind === "subagent" ? entry.parentThreadId : undefined}
        workspaceRoots={projectFileLinkRoots}
      />
    );
  }, [
    activeProjectId,
    explorer.projectFilePaths,
    explorer.rootPath,
    materializedThreadRootIds,
    openThreadFromExplorer,
    projectFileLinkRoots,
    projectThreadSidebars.projects,
    projectThreadSummaries.projects,
    resolvedSettings.composerSpellCheck,
    threadSummariesById,
  ]);
  const sidebarLifecycleSignal = useMemo(() => {
    const entries = projectThreadSidebars.projects.flatMap(({ entries: projectEntries }) => projectEntries);
    if (entries.some((entry) => entry.entryKind !== "draft" && entry.lifecycle.kind === "needsAttention")) return "needsAttention";
    if (entries.some((entry) => entry.entryKind !== "draft" && entry.lifecycle.kind === "working")) return "working";
    return "idle";
  }, [projectThreadSidebars]);
  const hasPendingQuestionnaire = Boolean(currentThread
    && pendingQuestionnaireThreadIds.has(currentThread.id)
    && isThreadStatusWaitingOnUserInput(currentThread.status))
    || sidebarLifecycleSignal === "needsAttention";
  const hasActiveThread = Boolean(currentThread && isThreadStatusActive(currentThread.status))
    || sidebarLifecycleSignal === "working";
  const tabIconState: WorkbenchTabIconState = hasPendingQuestionnaire
    ? "questionnaire"
    : hasActiveThread
      ? "active"
      : "default";
  const ambientCanvasVariant: WorkbenchAmbientCanvasVariant | null = resolvedSettings.theme === "magical-girl" || resolvedSettings.theme === "winter"
    ? resolvedSettings.theme
    : null;
  const shouldShowShellHeader = !showFullBleedMainView && !showFileView && !showEmptyState
    && (!isMobile || mobilePane === "editor");
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
  const shouldRunRelativeTimeClock = showThreadView && Boolean(threadShellSource);
  useEffect(() => {
    if (!shouldRunRelativeTimeClock) {
      return;
    }

    setThreadRelativeTimeNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setThreadRelativeTimeNowMs(Date.now());
    }, THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldRunRelativeTimeClock, threadShellActivityTimestampMs, threadShellSource?.id]);
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
      navigateToRoute(settingsRoute, options);
      return;
    }

    navigateToRoute(route.logical?.projectId
      ? createLogicalProjectRoute(route.logical.projectId)
      : createProjectRoute(explorer.currentProjectId || route.projectId), options);
  }, [browseLocation, explorer.currentProjectId, navigateToRoute, route, settingsRoute]);
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
      isPanelTargetDragActive: activeWorkbenchDrag?.payload.type === "panel-target",
      mosaicNode: route.view === "mosaic" ? route.mosaicNode : null,
      routeTarget: routePanelTarget,
      showMosaic: showMosaicView,
    });
  }, [
    activeWorkbenchDrag?.payload.type,
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
  const shouldRenderMainLayout = Boolean(mainLayoutForRender);
  const isDirectThreadSurface = showThreadView && !shouldRenderMainLayout;
  const isDirectMobileThreadSurface = isMobile && isDirectThreadSurface;

  useEffect(() => {
    if (!showMosaicView || !controls) {
      return;
    }

    void controls.refreshRateLimits();
    const intervalId = window.setInterval(() => {
      void controls.refreshRateLimits();
    }, MOSAIC_RATE_LIMIT_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
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

  const endWorkbenchPointerDrag = useCallback(() => {
    workbenchDragController.cancel();
  }, [workbenchDragController]);

  const beginWorkbenchPointerDrag = useCallback((event: ReactPointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => {
    if (isMobile || event.button !== 0 || payload.type === "thread-folder" || payload.type === "home-thread-folder") return;
    const label = payload.type === "new-thread"
      ? "New thread"
      : payload.target.kind === "file"
        ? payload.target.filePath
        : payload.target.kind === "thread" && (payload.target.target.kind === "provider" || payload.target.target.kind === "subagent")
          ? payload.target.target.threadId
          : payload.target.kind;
    workbenchDragController.begin(event, {
      dropTargetIds: [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID],
      label,
      payload,
    });
  }, [isMobile, workbenchDragController]);

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

  useEffect(() => {
    const header = shellHeaderRef.current;
    if (!header || typeof window === "undefined") {
      return;
    }

    const syncHeaderHeight = () => {
      setMobileShellHeaderHeight(header.offsetHeight);
    };

    syncHeaderHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncHeaderHeight);
      return () => {
        window.removeEventListener("resize", syncHeaderHeight);
      };
    }

    const observer = new ResizeObserver(syncHeaderHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
    };
  }, [currentThread?.isDraft, showEmptyState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const cancelPendingFrame = () => {
      if (mobileShellHeaderAnimationFrameRef.current === null) {
        return;
      }

      window.cancelAnimationFrame(mobileShellHeaderAnimationFrameRef.current);
      mobileShellHeaderAnimationFrameRef.current = null;
    };

    const applyHeaderVisibility = (nextVisible: boolean) => {
      mobileShellHeaderVisibleRef.current = nextVisible;
      setIsMobileShellHeaderVisible((current) => (current === nextVisible ? current : nextVisible));
    };

    const getCurrentScrollY = () => {
      const threadScrollTarget = directThreadScrollViewportRef.current;
      if (isDirectThreadSurface && threadScrollTarget) {
        return Math.max(
          0,
          threadScrollTarget.scrollHeight - threadScrollTarget.clientHeight + threadScrollTarget.scrollTop,
        );
      }

      return isMobile
        ? mainPaneRef.current?.scrollTop ?? 0
        : Math.max(window.scrollY, 0);
    };

    const resetHeaderVisibility = () => {
      cancelPendingFrame();
      mobileShellHeaderScrollYRef.current = getCurrentScrollY();
      mobileShellHeaderDirectionRef.current = null;
      mobileShellHeaderDirectionTravelRef.current = 0;
      applyHeaderVisibility(true);
    };

    if (!isMobile || !shouldShowShellHeader) {
      resetHeaderVisibility();
      return cancelPendingFrame;
    }

    resetHeaderVisibility();

    const updateHeaderVisibility = () => {
      mobileShellHeaderAnimationFrameRef.current = null;

      const nextScrollY = getCurrentScrollY();
      const delta = nextScrollY - mobileShellHeaderScrollYRef.current;
      mobileShellHeaderScrollYRef.current = nextScrollY;

      if (nextScrollY <= mobileShellHeaderHeight) {
        mobileShellHeaderDirectionRef.current = null;
        mobileShellHeaderDirectionTravelRef.current = 0;
        applyHeaderVisibility(true);
        return;
      }

      if (Math.abs(delta) < 1) {
        return;
      }

      const nextDirection = delta > 0 ? "down" : "up";
      if (mobileShellHeaderDirectionRef.current !== nextDirection) {
        mobileShellHeaderDirectionRef.current = nextDirection;
        mobileShellHeaderDirectionTravelRef.current = Math.abs(delta);
      } else {
        mobileShellHeaderDirectionTravelRef.current += Math.abs(delta);
      }

      if (
        nextDirection === "down"
        && mobileShellHeaderVisibleRef.current
        && mobileShellHeaderDirectionTravelRef.current >= MOBILE_SHELL_HEADER_HIDE_THRESHOLD_PX
      ) {
        mobileShellHeaderDirectionTravelRef.current = 0;
        applyHeaderVisibility(false);
        return;
      }

      if (
        nextDirection === "up"
        && !mobileShellHeaderVisibleRef.current
        && mobileShellHeaderDirectionTravelRef.current >= MOBILE_SHELL_HEADER_SHOW_THRESHOLD_PX
      ) {
        mobileShellHeaderDirectionTravelRef.current = 0;
        applyHeaderVisibility(true);
      }
    };

    const handleScroll = () => {
      if (mobileShellHeaderAnimationFrameRef.current !== null) {
        return;
      }

      mobileShellHeaderAnimationFrameRef.current = window.requestAnimationFrame(updateHeaderVisibility);
    };

    const viewport = window.visualViewport;
    const scrollTarget = isDirectThreadSurface
      ? directThreadScrollViewportRef.current
      : isMobile ? mainPaneRef.current : window;
    scrollTarget?.addEventListener("scroll", handleScroll, { passive: true });
    viewport?.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollTarget?.removeEventListener("scroll", handleScroll);
      viewport?.removeEventListener("scroll", handleScroll);
      cancelPendingFrame();
    };
  }, [activeFilePath, activeThreadId, isDirectThreadSurface, isMobile, mobileShellHeaderHeight, shouldShowShellHeader]);

  useEffect(() => {
    if (!showEmptyState || !quickOpenPaths.length) {
      return;
    }

    let cancelled = false;

    const projectId = explorer.currentProjectId || route.projectId;
    void Promise.all(quickOpenPaths.map(async (path) => {
      if (!controls) return null;
      const payload = await controls.daemon.projects.files.read({ path, projectId }).catch(() => null);
      if (!payload) return null;
      return [path, payload.updatedAt] as const;
    })).then((entries) => {
      if (cancelled) {
        return;
      }

      setQuickOpenUpdatedAtByPath((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (!entry) {
            continue;
          }
          next[entry[0]] = entry[1];
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [controls, explorer.currentProjectId, quickOpenPaths, route.projectId, showEmptyState]);

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
      const createdPath = await controls.createEntry(createDialogParentPath, createEntryName, type);
      setIsCreatingEntry(false);

      closeCreateDialog();
      if (type === "file") {
        navigateToRoute(route.logical?.projectId && browseLocation
          ? createLogicalFileRoute(route.logical.projectId, browseLocation, createdPath)
          : createFileRoute(explorer.currentProjectId || route.projectId, createdPath));
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
      <WorkbenchSidebarPreferencesProvider
        projectId={viewedProjectId}
      >
        {({ preferences: sidebarPreferences, setSidebarCollapsed }) => {
          const isEffectiveDesktopSidebarCollapsed = usesDesktopSidebarCollapse && sidebarPreferences.sidebarCollapsed;
          const topLeftMosaicPanelId = showMosaicView && mainLayoutForRender
            ? WorkbenchMainLayout.panels(mainLayoutForRender)[0]?.id
            : null;
          return (
      <WorkbenchDragProvider controller={workbenchDragController}>
        <WorkbenchContextMenuProvider>
        <div
          className={`relative isolate h-dvh overflow-hidden md:grid md:min-h-screen md:h-auto md:overflow-visible md:items-start${isEffectiveDesktopSidebarCollapsed
            ? " md:grid-cols-[minmax(0,1fr)]"
            : " md:grid-cols-[minmax(16rem, 21rem) 1fr]"
            }`}
        >
          {ambientCanvasVariant ? <WorkbenchAmbientCanvas variant={ambientCanvasVariant} /> : null}
          <WorkbenchTabIcon state={tabIconState} />
          <WorkbenchSearchDialog
            controller={searchController}
            projects={explorer.projects}
            logicalProjects={explorer.logicalProjects}
            logicalSummaries={explorer.logicalSummaries}
            projectSummaries={projectThreadSummaries}
          />
          {usesDesktopSidebarCollapse ? (
            <WorkbenchIconButton
              type="button"
              label={isEffectiveDesktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              display="hover-border"
              title={isEffectiveDesktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              className={`fixed top-3 z-40 hidden md:inline-flex ${isEffectiveDesktopSidebarCollapsed ? "left-3" : "left-[calc(21rem_-_1.5rem)]"}`}
              onClick={() => setSidebarCollapsed(!isEffectiveDesktopSidebarCollapsed)}
            >
              {isEffectiveDesktopSidebarCollapsed ? <SidebarExpandIcon size={20} /> : <SidebarCollapseIcon size={20} />}
              <span className="sr-only">{isEffectiveDesktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}</span>
            </WorkbenchIconButton>
          ) : null}
          {isEffectiveDesktopSidebarCollapsed && showMosaicView ? (
            <WorkbenchIconButton
              type="button"
              label="Drag to create a new thread panel"
              display="hover-border"
              title="Drag to create a new thread panel"
              className="fixed left-14 top-3 z-40 hidden cursor-grab active:cursor-grabbing md:inline-flex"
              onClick={(event) => {
                event.preventDefault();
              }}
              onPointerDown={(event) => {
                beginWorkbenchPointerDrag(event, {
                  harness,
                  type: "new-thread",
                });
              }}
            >
              <SparkleIcon size={20} />
              <span className="sr-only">Drag to create a new thread panel</span>
            </WorkbenchIconButton>
          ) : null}
          <div
            className="mobile-workbench-track flex h-dvh w-[200vw] overflow-hidden transition-transform duration-200 ease-out md:contents md:h-auto md:w-auto md:overflow-visible md:transform-none"
            style={mobileTrackStyle}
          >
            <aside className={`flex h-dvh w-screen min-w-0 shrink-0 select-none flex-col overflow-hidden pr-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:pr-6${isEffectiveDesktopSidebarCollapsed ? " md:hidden" : ""}`}>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-[0.95rem] leading-6">
                        <DropTargetBoundary className="scrollbar-hover-reveal flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pt-3 pb-[calc(0.75rem+min(0.75rem,var(--workbench-safe-area-bottom,0px)))] pr-2">
                <header className="-mr-2 grid shrink-0 grid-cols-[1fr_auto_auto_auto] items-center gap-1 pb-2">
                  <a
                    className="min-w-0 truncate rounded-lg pl-5 text-xl font-semibold leading-tight text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                    href="/"
                    onClick={(event) => {
                      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                      event.preventDefault();
                      navigateToRoute(createHomeRoute());
                    }}
                  >
                    workbench
                  </a>
                  <WorkbenchIconButton
                    label="Open workspace search"
                    display="hover-border"
                    onClick={() => searchController.open()}
                    title="Open workspace search"
                    type="button"
                  >
                    <SearchIcon size={20} />
                    <span className="sr-only">Open workspace search</span>
                  </WorkbenchIconButton>
                  <WorkbenchIconButton
                    as="a"
                    label="Open statistics"
                    display="hover-border"
                    href={projectHref(statsRoute)}
                    onClick={openStatsFromLink}
                    title="Open statistics"
                  >
                    <StatsIcon size={20} />
                    <span className="sr-only">Open statistics</span>
                  </WorkbenchIconButton>
                  <WorkbenchIconButton
                    as="a"
                    label="Open settings"
                    display="hover-border"
                    href={settingsHref}
                    onClick={openSettingsFromLink}
                    title="Open settings"
                  >
                    <GearIcon size={20} />
                    <span className="sr-only">Open settings</span>
                  </WorkbenchIconButton>
                </header>
                <WorkbenchThreadSidebarActionsProvider
                  onPresentationDraftDeleted={(draftId, logicalProjectId) => {
                    const current = currentRouteRef.current;
                    if (current.view === "thread" && current.threadTarget?.kind === "draft"
                      && current.threadTarget.draftId === draftId) {
                      navigateToRoute(current.logical?.projectId
                        ? createLogicalProjectRoute(current.logical.projectId,
                          current.logical.browseLocation ?? null)
                        : createLogicalProjectRoute(logicalProjectId), { replace: true });
                    }
                  }}
                  onOpenThread={openThreadFromExplorer}
                  onOpenQualifiedThread={row => openQualifiedThread(row, route.logical?.projectId ?? null)}
                  onThreadSettled={handleThreadSettled}
                  projectId={explorer.currentProjectId || route.projectId}
                >
                  <ProjectSidebar
                    activeProjectId={viewedProjectId}
                    selectedProjectIds={selectionProjectIds}
                    orderedProjectIds={orderedProjectIds}
                    unsettledProjectIds={unsettledProjectIds}
                    unarchivedProjectIds={unarchivedProjectIds}
                    emptySelectionMessage={route.selectedProjectIds?.length === 0
                      ? "No projects selected." : route.selectedProjectIds === null
                        && !selectionProjectIds.length && !dynamicSelectionPending
                        ? "No projects have unarchived threads." : undefined}
                    logicalProjects={displayedLogicalProjects}
                    logicalSummaries={explorer.logicalSummaries}
                    logicalError={[
                      workbenchClient.mounted?.presentationClient?.snapshot().error,
                      workbenchClient.projectSourceError,
                    ].filter(Boolean).join(" ") || null}
                    logicalLoading={workbenchClient.mounted?.presentationClient?.snapshot().phase === "loading"}
                    onProjectLinkClick={selectProjectFromLink}
                    createProjectHref={projectHref(newProjectRoute)}
                    onCreateProject={event => {
                      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      navigateToRoute(newProjectRoute);
                    }}
                    projects={explorer.projects}
                  />
                  <section className="shrink-0 pb-3">
                    <WorkbenchSidebarSectionDisclosure
                      contentClassName="space-y-2"
                      icon={DraftThreadIcon}
                      preferenceKey="threadsOpen"
                      title="Threads"
                    >
                      <WorkbenchThreadSidebar
                        activeDragPayload={activeWorkbenchDrag?.payload ?? null}
                        attachedDaemonId={workbenchClient.mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId ?? null}
                        createProjectId={sidebarCreateProjectId}
                        emptySelectionMessage={route.selectedProjectIds === null
                          ? dynamicSelectionPending ? "Loading projects..." : "No projects have unarchived threads."
                          : undefined}
                        logicalProject={selectedLogicalProject}
                        logicalProjects={displayedLogicalProjects}
                        logicalThreads={explorer.logicalThreads}
                        presentation={workbenchClient.mounted?.presentationClient?.snapshot().data}
                        controls={controls}
                        selectedLocation={browseLocation}
                        onOpenQualifiedThread={row => openQualifiedThread(row, row.logicalProjectId)}
                        attentionLabelsByThreadId={threadAttentionLabelsById}
                        currentTarget={route.view === "thread" ? route.threadTarget : null}
                        harness={harness}
                        onBeginPointerDrag={beginWorkbenchPointerDrag}
                        onCreateThread={createThreadFromSidebar}
                        onOpenThread={openThreadFromExplorer}
                        projectId={browseProjectId}
                        projects={explorer.projects}
                        renderThreadTooltipDetails={renderThreadTooltipDetails}
                        selectedOwnerProjectId={route.view === "thread"
                          ? route.logical?.threadOwnerProjectId ?? (route.threadOwnerProjectId || route.projectId)
                          : viewedProjectId}
                        selectedProjectIds={selectionProjectIds}
                        showMosaicView={showMosaicView}
                      />
                    </WorkbenchSidebarSectionDisclosure>
                  </section>
                </WorkbenchThreadSidebarActionsProvider>
                  <WorkbenchFolderSidebar
                    folders={folderOptions}
                    label="Choose folder"
                    onSelect={location => {
                      navigateToRoute({
                        ...route,
                        folderAddress:
                          workbenchClient.mounted?.projectNavigator?.folderAddressFor(location) ?? null,
                      });
                    }}
                    selected={selectedFolderLocation}
                  >
                    {folderSelected ? <WorkbenchGitSidebar active={showGitView} onNavigate={event => {
                      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      navigateToRoute(route.logical?.projectId
                        ? createLogicalGitRoute(route.logical.projectId, browseLocation)
                        : createGitRoute(activeProjectId));
                    }} /> : (
                      <p className="m-0 px-2 py-1 text-[0.8rem] leading-5 text-fg/muted">
                        Choose a folder to see its working tree and files.
                      </p>
                    )}
                    {folderSelected ? <section className="shrink-0 pb-3">
                    <WorkbenchSidebarSectionDisclosure
                      actions={(
                        <div className="flex items-center gap-1">
                          <WorkbenchIconButton
                            type="button"
                            label={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            display="hover-border"
                            size="small"
                            aria-pressed={showUnopenableFiles}
                            disabled={!explorer.currentProjectId || isProjectTreeLoading}
                            title={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            className={workbenchNewEntryButtonClassName}
                            onClick={() => {
                              updateProjectSetting("showUnopenableFiles", !showUnopenableFiles);
                            }}
                          >
                            <FileVisibilityIcon visible={showUnopenableFiles} />
                            <span className="sr-only">
                              {showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            </span>
                          </WorkbenchIconButton>
                          <WorkbenchIconButton
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
                          </WorkbenchIconButton>
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
                            getFileDragPayload={(path) => ({
                              target: { filePath: path, kind: "file" },
                              type: "panel-target",
                            })}
                            getNodeContextMenu={getProjectNodeContextMenu}
                            isFileOpenable={canOpenFileFromExplorer}
                            modifiedPaths={modifiedPaths}
                            nodes={visibleTree}
                            onCreateInDirectory={openCreateDialog}
                            onFilePointerDragStart={(event, path) => {
                              beginWorkbenchPointerDrag(event, {
                                target: { filePath: path, kind: "file" },
                                type: "panel-target",
                              });
                            }}
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
                  </section> : null}
                  </WorkbenchFolderSidebar>
                  <WorkbenchBrowseSessionsSection controller={browseSessionController} />
                  <ReloadNecessary
                    appRuntime={appRuntime}
                    daemonRuntime={controls?.daemonRuntime ?? null}
                  />
                </DropTargetBoundary>
              </div>
            </aside>

            <main
              ref={mainPaneRef}
              className={`scrollbar-hover-reveal flex h-dvh w-screen min-w-0 shrink-0 flex-col overflow-x-hidden md:w-auto${showGitView
                ? " min-h-0 overflow-hidden px-5 pb-0 md:h-screen md:px-6"
                : showSettingsView || showStatsView || routeView
                ? " overflow-y-auto px-5 md:h-screen md:min-h-0 md:overflow-y-auto md:px-6"
                : isDirectThreadSurface
                ? " overflow-hidden px-0 pb-0 md:h-screen md:min-h-0 md:overflow-hidden"
                : showFullBleedMainView
                  ? " overflow-y-auto px-5 md:h-screen md:min-h-0 md:overflow-hidden md:px-0 md:pb-0"
                  : " overflow-y-auto px-5 md:h-auto md:min-h-screen md:overflow-visible md:px-6"
                }`}
            >
              <ThreadScrollViewport
                ref={directThreadScrollViewportRef}
                className="h-full"
                contentClassName="flex flex-col"
                enabled={isDirectThreadSurface}
                resetKey={`${threadSurfaceKey}:${selectedThreadIdForView || activeThreadId}`}
              >
              <header
                ref={shellHeaderRef}
                className={`
              sticky top-0 z-10 transform-gpu py-3 transition-[translate,opacity] duration-200 ease-out will-change-translate motion-reduce:transition-none ${isDirectMobileThreadSurface ? "pl-5 pr-5" : "-mx-5 pl-5 pr-5"} md:-mx-6 md:pr-6 ${isEffectiveDesktopSidebarCollapsed ? "md:pl-20" : "md:pl-11"}
              md:translate-y-0 md:opacity-100
              ${isMobileShellHeaderVisible
                    ? "-translate-y-1 opacity-100"
                    : "pointer-events-none -translate-y-[calc(100%+0.75rem)] opacity-0"
                  }
            `}
                hidden={!shouldShowShellHeader}
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 -z-10 md:mx-auto md:max-w-[58rem] bg-[linear-gradient(to bottom, var(--app-bg-solid) calc(100% - var(--spacing) * 6), transparent)] md:backdrop-blur-none"
                />
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="order-2 min-w-0 w-full flex-1 md:order-1">
                    {showThreadView && threadForThreadView?.isDraft && !isThreadShellTitleLoading ? (
                      <>
                        <p id="file-path" ref={filePathLabelRef} className="flex min-w-0 items-center gap-1 truncate text-base font-semibold leading-tight">
                          {activeRouteDraft?.attachments.length ? <ImageIcon className="shrink-0" size={16} /> : null}
                          <span className="truncate">{activeRouteDraft ? createDraftTitle(activeRouteDraft.prompt) : threadShellTitle}</span>
                        </p>
                        <p id="status-line" ref={statusLineRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted">{threadShellStatusLabel}</p>
                      </>
                    ) : showThreadView && threadShellSource && !isThreadShellTitleLoading ? (
                      <ThreadShellTitleInput
                        key={`${threadShellSource.harness}:${threadShellSource.id}`}
                        activityLabel={threadShellStatusLabel}
                        statusRef={statusLineRef}
                        title={threadShellTitle}
                        titleRef={filePathLabelRef}
                        onSave={controls ? async (title) => await controls.setThreadTitle({
                          harness: threadShellSource.harness,
                          threadId: threadShellSource.id,
                          title,
                        }) : undefined}
                      />
                    ) : (
                      <>
                        <p id="file-path" ref={filePathLabelRef} className="truncate text-base font-semibold leading-tight">
                          {isThreadShellTitleLoading ? (
                            <span className="block h-4 w-48 max-w-[60vw] rounded-full workbench-skeleton" aria-hidden="true" />
                          ) : routeView ? routeView.title : showGitView ? "Working tree" : showSettingsView ? `Settings / ${settingsPageTitle}` : showStatsView ? "Usage" : "Select a file"}
                        </p>
                        <p id="status-line" ref={statusLineRef} hidden={showSettingsView || showStatsView || Boolean(routeView)} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted">
                          {showGitView ? <WorkbenchGitRepositoryControl /> : "Markdown files open as rich text. Save with Ctrl/Cmd+S."}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="order-1 flex items-center justify-between gap-3 md:order-2 md:ml-auto md:flex-none md:justify-end">
                    <WorkbenchIconButton
                      type="button"
                      label="Back to file explorer"
                      display="hover-border"
                      title="Back to file explorer"
                      hidden={!isMobile || mobilePane !== "editor"}
                      className="md:hidden"
                      onClick={() => {
                        navigateToRoute(getMobileExplorerRoute(route, explorer.currentProjectId));
                      }}
                    >
                      <BackArrowIcon size={20} />
                      <span className="sr-only">Back to file explorer</span>
                    </WorkbenchIconButton>
                    <div className="flex items-center gap-1.5">
                      {showGitView ? <WorkbenchGitRefreshButton /> : null}
                      <WorkbenchZoomButton
                        ref={zoomButtonRef}
                        label="Editor text size"
                        disabled={!shouldShowShellHeader || (isMobile && !isMobileShellHeaderVisible)}
                        min={MIN_EDITOR_FONT_SIZE}
                        max={MAX_EDITOR_FONT_SIZE}
                        value={resolvedSettings.editorFontSize}
                        onPreview={setEditorFontSizePreview}
                        onChange={updateEditorFontSize}
                      />
                    </div>
                    <div className="flex items-center gap-1.5" hidden={Boolean(currentThread) || showThreadView || showSettingsView || showGitView || showStatsView || Boolean(routeView)}>
                      <WorkbenchIconButton
                        id="save-file"
                        ref={saveFileButtonRef}
                        type="button"
                        title="Save current file"
                        label="Save current file"
                        display="hover-border"
                        data-invalid="false"
                      >
                        <SaveIcon size={20} />
                        <span className="sr-only">Save current file</span>
                      </WorkbenchIconButton>
                      <WorkbenchIconButton
                        id="reset-draft"
                        ref={resetDraftButtonRef}
                        type="button"
                        title="Discard the current draft"
                        label="Discard the current draft"
                        display="hover-border"
                      >
                        <BinIcon size={20} />
                        <span className="sr-only">Discard the current draft</span>
                      </WorkbenchIconButton>
                    </div>
                  </div>
                </div>
              </header>

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
                        <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-fg/muted" title={`${routeOwnerMetadata.hostname}: ${routeOwnerMetadata.rootPath}`}>
                          {routeThreadContext?.project && "kind" in routeThreadContext.project
                            ? <WorkbenchProjectIcon project={routeThreadContext.project} variant="thread" />
                            : <ProjectIcon className="shrink-0" size={16} />}
                          <span className="min-w-0 truncate">
                            <WorkbenchProjectLocationLabel
                              displayPath={routeOwnerMetadata.displayPath}
                              hostname={routeOwnerMetadata.hostname}
                            />
                          </span>
                        </span>
                      ) : null}
                      composerSpellCheck={resolvedSettings.composerSpellCheck}
                      draftLeadingContent={projectRotator}
                      draftTargetControl={route.logical && logicalThreadProject && threadForThreadView?.isDraft ? (
                        <WorkbenchProjectLocationMenu
                          folders={projectFolderOptions([logicalThreadProject])}
                          selected={routeLaunchLocation ?? null}
                          label={`Start thread in ${logicalThreadProject.label} at`}
                          onSelect={location => {
                            void (async () => {
                              const submittedRoute = route;
                              const destination = logicalThreadProject.locations.find(item =>
                                item.target.daemonId === location.daemonId && item.target.projectId === location.projectId);
                              if (!destination?.project) throw new Error("That daemon folder is unavailable.");
                              if (!controls || !submittedRoute.logical?.threadOwnerProjectId
                                || !threadForThreadView?.isDraft) return;
                              const draftSession = activeDraftSessionRef.current;
                              if (!draftSession || !await draftSession.flush("retarget")) {
                                throw new Error("Save the draft before changing its folder.");
                              }
                              if (!isSameDraftRouteIntent(submittedRoute, currentRouteRef.current, threadForThreadView.id)) return;
                              const owner = workbenchClient.mounted?.presentationClient;
                              if (!owner) throw new Error("App presentation state is unavailable.");
                              const draft = owner.draft(threadForThreadView.id);
                              if (draft) await controls.retargetPresentationDraft(DraftIdSchema.parse(draft.id), location);
                              if (!isSameDraftRouteIntent(submittedRoute, currentRouteRef.current, threadForThreadView.id)) return;
                              const nextRoute = createLogicalThreadRoute(submittedRoute.logical.projectId,
                                submittedRoute.logical.threadOwnerProjectId, draft ? null : location,
                                draft ? { kind: "draft", draftId: DraftIdSchema.parse(draft.id) } : { kind: "new" });
                              if (draft) navigateToRoute(nextRoute, { replace: true });
                              else await controls.applyRoute(nextRoute);
                            })().catch(error => setSelectionError(
                              error instanceof Error ? error.message.slice(0, 500) : "Unable to change draft folder.",
                            ));
                          }}
                        />
                      ) : null}
                      onDraftSessionChange={session => { activeDraftSessionRef.current = session; }}
                      fontSizeRem={displayedEditorFontSize}
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
                      onOpenThread={(target) => { void openThreadFromExplorer(target, threadProjectId); }}
                      onSendMessage={sendThreadMessage}
                      onThreadComposerDraftChange={handleThreadComposerDraftChange}
                      onThreadComposerDraftClear={handleThreadComposerDraftClear}
                      onQuestionnaireError={setSelectionError}
                      onThreadSettingsChange={setThreadComposerSettings}
                      selectedThreadId={selectedThreadIdForView}
                      onSelectedThreadChange={handleSelectedThreadChange}
                      onThreadCodeBlockWrapChange={updateThreadCodeBlockWrapSetting}
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
                      threadCodeBlockWrap={resolvedSettings.threadCodeBlockWrap}
                      threadCodeDetails={resolvedSettings.threadCodeDetails}
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
                    folders={selectedSettingsProject
                      ? projectFolderOptions([selectedSettingsProject])
                      : []}
                    getDaemon={daemonId => workbenchClient.mounted?.workspace.daemon({ kind: "installation", daemonId }) ?? null}
                    logicalProject={selectedSettingsProject ? {
                      id: selectedSettingsProject.id,
                      label: selectedSettingsProject.displayName ?? selectedSettingsProject.label,
                      iconProject: selectedSettingsProject.locations.find(location => location.project)?.project ?? null,
                    } : null}
                    onError={setSelectionError}
                    onGitRootsSaved={async daemonId => {
                      await workbenchClient.mounted?.refreshInstallationProjects(daemonId);
                    }}
                    onPageChange={setSettingsPageTitle}
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
                  <WorkbenchDaemonClientContext.Provider value={selectedDaemon ?? null}>
                    <WorkbenchDaemonAssetOriginContext.Provider value={selectedAssetSource}>
                    <WorkbenchWorkingTreeView />
                    </WorkbenchDaemonAssetOriginContext.Provider>
                  </WorkbenchDaemonClientContext.Provider>
                ) : null}
                {routeView && !shouldRenderMainLayout ? (
                  <routeView.Component key={route.view} route={route} navigateToRoute={navigateToRoute} />
                ) : null}
                {showStatsView && !shouldRenderMainLayout ? (
                  <WorkbenchStatsView
                    onNavigateThread={openStatsThreadFromLink}
                    projects={explorer.projects}
                    scope={statsScope}
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
                    <div className="flex w-full max-w-[42rem] flex-col gap-8">
                      {!selectionProjectIds.length ? (
                        <p className="m-0 px-4 text-[0.9rem] text-fg/muted">
                          {route.selectedProjectIds === null
                            ? dynamicSelectionPending ? "Loading projects..." : "No projects have unarchived threads."
                            : "No projects selected. Select a project to see its threads."}
                        </p>
                      ) : <button
                        type="button"
                        className={`${workbenchOptionRowClassName} ${workbenchOptionHoverClassName} w-fit border-transparent px-4 py-2 text-[0.84rem] text-text md:py-2`}
                        disabled={!controls || !sidebarCreateProjectId
                          || Boolean(workbenchClient.mounted?.presentationClient && !selectedLogicalProjects.length && !browseLocation)}
                        onClick={() => {
                          if (!controls || !sidebarCreateProjectId) return;
                          createThreadFromSidebar(sidebarCreateProjectId);
                        }}
                      >
                        <span className="inline-flex size-4 items-center justify-center text-[1.05em] leading-none">+</span>
                        <span>{workbenchClient.mounted?.presentationClient && !selectedLogicalProjects.length
                          ? explorer.logicalProjects?.length ? "Project folder unavailable"
                            : "Waiting for project identities" : "Create new thread"}</span>
                      </button>}
                      {quickOpenPaths.length ? (
                        <div className="space-y-2">
                          {quickOpenPaths.map((path) => (
                            <button
                              key={path}
                              type="button"
                              className="flex w-full items-start justify-between gap-4 rounded-[1.15rem] px-4 py-3 text-left transition hover:bg-[color-mix(in srgb, var(--text) 4%, transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                              onClick={() => {
                                void openFileFromExplorer(path);
                              }}
                              title={path}
                            >
                              <span className="min-w-0 space-y-1">
                                <span className="inline-flex min-w-0 items-center gap-2">
                                  <span className="block truncate text-[0.95rem] font-medium text-text">{path}</span>
                                  {modifiedPaths.has(path) ? (
                                    <span
                                      aria-hidden="true"
                                      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#d0ad12]"
                                    />
                                  ) : null}
                                </span>
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] text-fg/muted">
                                  <span>{formatQuickOpenTimestamp(quickOpenUpdatedAtByPath[path])}</span>
                                  {explorer.changes[path] ? (
                                    <span>{formatQuickOpenChangeSummary(explorer.changes[path].additions, explorer.changes[path].deletions)}</span>
                                  ) : null}
                                  {modifiedPaths.has(path) ? (
                                    <span>Draft</span>
                                  ) : null}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {shouldRenderMainLayout && mainLayoutForRender && (!showFileView || isFileViewReady || activeWorkbenchDrag?.payload.type === "panel-target" || activeWorkbenchDrag?.payload.type === "thread-row") ? (
                  <WorkbenchWorkspace
                    controller={workspaceController}
                    onFocusPanel={() => { }}
                    onLayoutChange={updateMainLayout}
                    onPanelDrop={handleMainLayoutPanelDrop}
                    onPointerDrop={endWorkbenchPointerDrag}
                    onSplitResize={resizeMosaicSplit}
                    renderPanel={({ isFocused, mosaicPanel, panelId, target }) => {
                      const mosaicTarget = workspaceController.mosaicTargetForPanel(panelId);
                      const panelZoomDelta = mosaicPanel?.zoomDelta ?? 0;
                      const panelFontSizeRem = clampEditorFontSize(displayedEditorFontSize + panelZoomDelta * 0.08);
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
                      if (target.kind === "file") {
                        return (
                          <WorkbenchFilePanel
                            contained={showMosaicView}
                            controls={controls}
                            editorFontClassName={editorFontClassName}
                            fontSizeRem={panelFontSizeRem}
                            baseFontSizeRem={displayedEditorFontSize}
                            sidebarToggleInset={sidebarToggleInset}
                            isFocused={isFocused}
                            isMinimized={isMinimized}
                            isMinimizedVertical={isMinimizedVertical}
                            location={mosaicTarget?.source?.location}
                            onClose={showMosaicView ? () => {
                              closeMosaicPanel(mosaicTarget ?? target);
                            } : undefined}
                            onFocus={() => { }}
                            onHeaderPointerDragStart={showMosaicView ? (event) => {
                              beginWorkbenchPointerDrag(event, {
                                sourcePanelId: panelId,
                                target: mosaicTarget ?? target,
                                type: "panel-target",
                              });
                            } : undefined}
                            onMinimizeToggle={showMosaicView ? togglePanelMinimized : undefined}
                            onPanelZoomDeltaChange={showMosaicView ? updatePanelZoomDelta : undefined}
                            panelZoomDelta={panelZoomDelta}
                            path={target.filePath}
                            spellCheck={resolvedSettings.editorSpellCheck}
                          />
                        );
                      }

                      if (target.kind === "thread") {
                        const panelLogicalProjectId = mosaicTarget?.source?.logicalProjectId
                          ?? route.logical?.threadOwnerProjectId ?? route.logical?.projectId ?? null;
                        const panelSettings = resolveWorkbenchSettings(globalSettings,
                          panelLogicalProjectId
                            ? readLogicalProjectWorkbenchSettings(panelLogicalProjectId, clientState.records)
                            : createDefaultProjectWorkbenchSettings());
                        return (
                          <WorkbenchThreadPanel
                            routeOwned
                            composerSpellCheck={resolvedSettings.composerSpellCheck}
                            fallbackThreadSummary={target.target.kind === "provider" || target.target.kind === "subagent" ? threadSummariesById.get(getWorkbenchThreadTargetRootId(target.target)) ?? null : null}
                            getThreadHref={threadTarget => route.logical
                              && (threadTarget.kind === "provider" || threadTarget.kind === "subagent")
                              ? projectHref(createLogicalExistingThreadRoute(route.logical.projectId, threadTarget,
                                route.logical.browseLocation ?? null))
                              : undefined}
                            fontSizeRem={displayedEditorFontSize}
                            sidebarToggleInset={sidebarToggleInset}
                            isFocused={isFocused}
                            isMinimized={isMinimized}
                            isMinimizedVertical={isMinimizedVertical}
                            onDraftHarnessChange={nextHarness =>
                              handleHarnessChange(nextHarness, mosaicTarget?.source?.location)}
                            onOpenThread={openThreadFromExplorer}
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
                            onThreadCodeBlockWrapChange={nextValue => {
                              void (panelLogicalProjectId
                                ? writeLogicalProjectWorkbenchSetting(clientStateController, panelLogicalProjectId,
                                  "threadCodeBlockWrap", { enabled: true, value: nextValue })
                                : writeGlobalWorkbenchSetting(clientStateController, "threadCodeBlockWrap", nextValue))
                                .catch((error: Error) => setSelectionError(error.message));
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
                            threadCodeBlockWrap={panelSettings.threadCodeBlockWrap}
                            threadCodeDetails={panelSettings.threadCodeDetails}
                            threadTarget={target.target}
                            threadComposerDraft={getThreadComposerDraftForTarget(target.target)}
                            threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                            onClose={showMosaicView ? () => {
                              closeMosaicPanel(mosaicTarget ?? target);
                            } : undefined}
                            onHeaderPointerDragStart={showMosaicView ? (event) => {
                              beginWorkbenchPointerDrag(event, {
                                sourcePanelId: panelId,
                                target: mosaicTarget ?? target,
                                type: "panel-target",
                              });
                            } : undefined}
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
                {showFileView && !selectionError && isFileViewReady && !shouldRenderMainLayout ? (
                  <WorkbenchFilePanel
                    controls={controls}
                    editorFontClassName={editorFontClassName}
                    fontSizeRem={displayedEditorFontSize}
                    isFocused
                    location={browseLocation}
                    onFocus={() => { }}
                    path={effectiveFilePath}
                    spellCheck={resolvedSettings.editorSpellCheck}
                  />
                ) : null}
                {showFileView && selectionError ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-content items-center justify-center py-8">
                    <div className="shadow-float flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger/30 bg-[color: color-mix(in srgb, var(--bg) 94%, transparent)] [--fg-bg: color-mix(in srgb, var(--bg) 94%, var(--app-bg-solid))] px-5 py-4 text-left">
                      <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-danger uppercase">File</p>
                      <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open file</p>
                      <p className="m-0 break-all text-[0.84rem] leading-6 text-fg/muted">{selectionError}</p>
                    </div>
                  </div>
                ) : null}
                {showFileView && !selectionError && !isFileViewReady ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-content items-center justify-center py-8">
                    <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in srgb, var(--text) 10%, transparent)] bg-[color: color-mix(in srgb, var(--bg) 94%, transparent)] [--fg-bg: color-mix(in srgb, var(--bg) 94%, var(--app-bg-solid))] px-5 py-4 text-left">
                      <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-fg/muted uppercase">File</p>
                      <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Loading file...</p>
                      <p className="m-0 break-all text-[0.84rem] leading-6 text-fg/muted">{effectiveFilePath}</p>
                    </div>
                  </div>
                ) : null}
              </section>
              </ThreadScrollViewport>

              <WorkbenchDialog
                id="save-conflict-dialog"
                dialogRef={saveConflictDialogRef}
                titleId="save-conflict-title"
                summaryId="save-conflict-summary"
                eyebrow="Write conflict"
                title="This file changed on disk"
                actions={
                  <>
                    <button
                      id="save-conflict-keep-editing"
                      ref={saveConflictKeepEditingButtonRef}
                      type="button"
                      className={dialogButtonClassName}
                    >
                      Keep editing
                    </button>
                    <button
                      id="save-conflict-reload"
                      ref={saveConflictReloadButtonRef}
                      type="button"
                      className={dialogButtonClassName}
                    >
                      Reload from disk
                    </button>
                    <button
                      id="save-conflict-overwrite"
                      ref={saveConflictOverwriteButtonRef}
                      type="button"
                      className={dialogButtonClassName}
                    >
                      Overwrite anyway
                    </button>
                  </>
                }
              >
                <>
                  <p id="save-conflict-summary" ref={saveConflictSummaryRef} className="mt-3 text-sm leading-6 text-fg/muted">
                    Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.
                  </p>
                  <p id="save-conflict-expected" ref={saveConflictExpectedRef} className="mt-3 text-[0.84rem] tracking-[0.02em] text-fg/muted" />
                  <p id="save-conflict-actual" ref={saveConflictActualRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted" />
                </>
              </WorkbenchDialog>

              <WorkbenchDialog
                id="reset-draft-dialog"
                dialogRef={resetDraftDialogRef}
                titleId="reset-draft-title"
                summaryId="reset-draft-summary"
                eyebrow="Discard draft"
                title="Reset this draft?"
                actions={
                  <>
                    <button
                      id="reset-draft-cancel"
                      ref={resetDraftCancelButtonRef}
                      type="button"
                      className={dialogButtonClassName}
                    >
                      Cancel
                    </button>
                    <button
                      id="reset-draft-head"
                      ref={resetDraftHeadButtonRef}
                      type="button"
                      className={dialogButtonClassName}
                    >
                      Reset to HEAD
                    </button>
                    <button
                      id="reset-draft-saved"
                      ref={resetDraftSavedButtonRef}
                      type="button"
                      className={dialogButtonClassName}
                    >
                      Reset to saved
                    </button>
                  </>
                }
              >
                <p id="reset-draft-summary" className="mt-3 text-sm leading-6 text-fg/muted">
                  Reset to saved discards the current draft and reloads the file from disk. Reset to HEAD overwrites the file on disk with the current git HEAD version, then reloads it here.
                </p>
              </WorkbenchDialog>

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
          </div>

          <div
            id="floating-toolbar"
            ref={floatingToolbarRef}
            className={workbenchFloatingToolbarClassName}
            hidden
          >
            <div className={workbenchFloatingToolbarGroupClassName} data-toolbar-group="inline">
              <button
                data-command="bold"
                type="button"
                title="Bold"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                b
              </button>
              <button
                data-command="italic"
                type="button"
                title="Italic"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                i
              </button>
              <button
                data-command="inline-code"
                type="button"
                title="Inline code"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                code
              </button>
              <button
                data-command="comment"
                type="button"
                title="Inline comment"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                note
              </button>
              <button
                data-command="del"
                type="button"
                title="Deleted text"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                del
              </button>
              <button
                data-command="ins"
                type="button"
                title="Inserted text"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                ins
              </button>
            </div>
            <div className={workbenchFloatingToolbarGroupClassName} data-toolbar-group="block">
              <button
                data-command="h1"
                type="button"
                title="Heading 1"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                h1
              </button>
              <button
                data-command="h2"
                type="button"
                title="Heading 2"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                h2
              </button>
              <button
                data-command="unordered-list"
                type="button"
                title="Bullets"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                ul
              </button>
              <button
                data-command="ordered-list"
                type="button"
                title="Numbers"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                ol
              </button>
              <button
                data-command="quote"
                type="button"
                title="Quote"
                className="pointer-events-auto min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                &gt;
              </button>
            </div>
          </div>

          <div
            id="revision-hover-toolbar"
            ref={revisionHoverToolbarRef}
            className={workbenchRevisionHoverToolbarClassName}
            hidden
          >
            <button
              id="revision-hover-accept"
              ref={revisionHoverAcceptButtonRef}
              type="button"
              title="Accept revision"
              className={workbenchRevisionActionButtonClassName}
            >
              accept
            </button>
            <button
              id="revision-hover-reject"
              ref={revisionHoverRejectButtonRef}
              type="button"
              title="Reject revision"
              className={workbenchRevisionActionButtonClassName}
            >
              reject
            </button>
          </div>
        </div>
        </WorkbenchContextMenuProvider>
      </WorkbenchDragProvider>
          );
        }}
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
