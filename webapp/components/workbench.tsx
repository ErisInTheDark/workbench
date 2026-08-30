"use client";

/*
 * Exports:
 * - default Workbench: client shell for project browsing, editing, project-aware pinned navigation, and thread interaction. Keywords: workbench, project, pinned, editor, thread.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
  ExplorerSnapshot, FilePayload, OpenFileInEditorRequest, RevealProjectEntryRequest, ThreadPayload, ThreadSummary, TreeNode,
  WorkbenchBrowseSessionControlResponse,
  WorkbenchBrowseSessionListResponse,
  WorkbenchBrowseSessionSummary,
  WorkbenchAppRuntimeStore,
  WorkbenchComposerInputDraft,
  WorkbenchComposerSettings,
  WorkbenchControls,
  WorkbenchFileOpenTarget,
  WorkbenchHarness,
  WorkbenchListModelsOptions,
  WorkbenchLocalCapabilitySettings,
  WorkbenchLocalCapabilitySettingsResponse,
  WorkbenchPendingUserInputRequest,
  WorkbenchProjectOption,
  WorkbenchQuestionnaireDraft,
  WorkbenchReadThreadOptions,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadDocumentSnapshot,
  WorkbenchThreadSidebarStore,
  WorkbenchUserInputResponse
} from "../lib/types";
import { installBrowserRandomUuidPolyfill } from "../lib/workbench/browser-random-uuid-polyfill";
import { areDeeplyEqual } from "../lib/workbench/deep-equality";
import { writeTextToClipboard } from "../lib/workbench/dom/clipboard";
import WorkbenchDragController from "../lib/workbench/layout/WorkbenchDragController";
import { WORKBENCH_MAIN_PANEL_DROP_TARGET_ID, type WorkbenchDragPayload } from "../lib/workbench/layout/workbench-drag";
import WorkbenchMainLayout, {
  type WorkbenchDropPlacement,
  type WorkbenchMainLayout as WorkbenchMainLayoutState,
  type WorkbenchPanelTarget,
} from "../lib/workbench/layout/workbench-layout";
import {
  applyWorkbenchMosaicDrop,
  applyWorkbenchMosaicResize,
  closeWorkbenchMosaicTarget,
  createWorkbenchMainLayoutFromMosaic,
  moveWorkbenchMosaicTarget,
  replaceWorkbenchMosaicTarget,
  updateWorkbenchMosaicPanelOptions,
} from "../lib/workbench/layout/workbench-mosaic-layout";
import type { WorkspaceFileLinkRoot } from "../lib/workbench/markdown/markdown-links";
import { useWorkbenchRoute } from "../lib/workbench/navigation/use-workbench-route";
import {
  createWorkbenchMosaicSplit,
  createWorkbenchMosaicTarget,
  type WorkbenchMosaicNode,
  type WorkbenchMosaicPanelTarget,
} from "../lib/workbench/navigation/workbench-mosaic-route";
import {
  createFileRoute,
  createMosaicRoute,
  createPinnedThreadHref,
  createPinnedThreadRoute,
  createProjectRoute,
  createSettingsHref,
  createSettingsRoute,
  createThreadHref,
  createThreadRoute,
  getWorkbenchMosaicThreadRootIds,
  getWorkbenchThreadTargetRootId,
  getWorkbenchThreadTargetSelectedId,
  isWorkbenchRouteOwnerOfThread,
  isWorkbenchThreadTargetSelected,
  type WorkbenchRoute,
  type WorkbenchSettingsScope
} from "../lib/workbench/navigation/workbench-route";
import ProjectTreeFileIndex from "../lib/workbench/project/ProjectTreeFileIndex";
import { isWorkbenchOpenableFile } from "../lib/workbench/project/tree-utils";
import { createComposerProfilePersistence } from "../lib/workbench/state/composer-profile-api";
import {
  getPreferredMobilePane,
  MOBILE_MEDIA_QUERY,
  type MobilePane,
} from "../lib/workbench/state/mobile-pane-url-state";
import {
  createDefaultProjectWorkbenchSettings,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  readGlobalWorkbenchSettings,
  readProjectWorkbenchSettings,
  resolveWorkbenchSettings,
  WORKBENCH_SETTING_DEFINITIONS,
  writeGlobalWorkbenchSettings,
  writeProjectWorkbenchSettings,
  type WorkbenchEditorFontFamily,
  type WorkbenchGlobalSettings,
  type WorkbenchProjectSettings,
  type WorkbenchSettingKey,
} from "../lib/workbench/state/workbench-settings";
import WorkbenchComposerProfileController from "../lib/workbench/state/WorkbenchComposerProfileController";
import { getThreadDocumentFromSnapshot } from "../lib/workbench/thread/thread-document-keys";
import { ThreadMessageNotSentError } from "../lib/workbench/thread/thread-message-submission";
import { countDraftPromptTokens, type WorkbenchThreadDraft, type WorkbenchThreadSidebarEntry, type WorkbenchThreadTarget } from "../lib/workbench/thread/thread-state";
import type { WorkbenchDomSurfaces } from "../lib/workbench/workbench-dom";
import WorkbenchFilePanel from "./workbench/layout/WorkbenchFilePanel";
import WorkbenchMainLayoutView from "./workbench/layout/WorkbenchMainLayoutView";
import WorkbenchThreadPanel from "./workbench/layout/WorkbenchThreadPanel";
import DropTarget from "./workbench/drag/DropTarget";
import DropTargetBoundary from "./workbench/drag/DropTargetBoundary";
import WorkbenchDragProvider from "./workbench/drag/WorkbenchDragProvider";
import PrimaryButton from "./workbench/PrimaryButton";
import ReloadNecessary from "./workbench/ReloadNecessary";
import ProjectSidebar from "./workbench/ProjectSidebar";
import WorkbenchCurrentProjectHeading from "./workbench/WorkbenchCurrentProjectHeading";
import WorkbenchPinnedThreadSidebar from "./workbench/WorkbenchPinnedThreadSidebar";
import ThreadShellTitleInput from "./workbench/ThreadShellTitleInput";
import { formatThreadRelativeTimestamp, getThreadTitle } from "./workbench/thread-view/thread-view-formatters";
import ThreadLoadingSkeleton from "./workbench/thread-view/ThreadLoadingSkeleton";
import ThreadScrollViewport from "./workbench/thread-view/ThreadScrollViewport";
import ThreadView from "./workbench/thread-view/ThreadView";
import resolveThreadActivityTimestampMs from "./workbench/thread-view/thread-activity-timestamp";
import {
  workbenchFloatingToolbarClassName,
  workbenchFloatingToolbarGroupClassName,
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchRevisionHoverToolbarClassName
} from "./workbench/workbench-class-names";
import { dialogButtonClassName } from "./workbench/workbench-dialog-styles";
import {
  WorkbenchDialog,
} from "./workbench/workbench-dialogs";
import {
  BrowseSessionsList,
  ExplorerTree,
  FileVisibilityIcon,
  NewEntryIcon,
  SidebarLoadingSkeleton,
} from "./workbench/workbench-explorer";
import {
  ArchiveIcon,
  BackArrowIcon,
  BinIcon,
  BrowserSessionIcon,
  CopyIcon,
  DraftThreadIcon,
  FileMoveIcon,
  FolderOpenIcon,
  GearIcon,
  ReloadIcon,
  SaveIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SparkleIcon,
  StopIcon,
  ZoomInIcon,
  ZoomOutIcon
} from "./workbench/workbench-icons";
import WorkbenchAmbientCanvas, { type WorkbenchAmbientCanvasVariant } from "./workbench/WorkbenchAmbientCanvas";
import WorkbenchComposerProfileProvider from "./workbench/WorkbenchComposerProfileProvider";
import type { WorkbenchContextMenuDefinition } from "./workbench/WorkbenchContextMenuContext";
import WorkbenchContextMenuProvider from "./workbench/WorkbenchContextMenuProvider";
import WorkbenchOptionCards, { WorkbenchOptionCard } from "./workbench/WorkbenchOptionCards";
import WorkbenchSidebarPreferencesProvider from "./workbench/WorkbenchSidebarPreferencesProvider";
import {
  useWorkbenchClientStateController,
  useWorkbenchClientStateSnapshot,
} from "./workbench/workbench-client-state-context";
import WorkbenchSidebarSectionDisclosure from "./workbench/WorkbenchSidebarSectionDisclosure";
import WorkbenchStepSlider from "./workbench/WorkbenchStepSlider";
import WorkbenchTabIcon, { type WorkbenchTabIconState } from "./workbench/WorkbenchTabIcon";
import WorkbenchThreadSidebar from "./workbench/WorkbenchThreadSidebar";
import WorkbenchThreadSidebarActionsProvider from "./workbench/WorkbenchThreadSidebarActions";
import WorkbenchThreadTooltipDetails from "./workbench/WorkbenchThreadTooltipDetails";

installBrowserRandomUuidPolyfill();

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  currentProjectId: "",
  projects: [],
  root: "Project",
  rootPath: "",
  roots: [],
  tree: [],
  projectFileCandidates: ProjectTreeFileIndex.empty.candidates,
  projectFileIndexId: ProjectTreeFileIndex.empty.id,
  projectFileIndexKey: ProjectTreeFileIndex.empty.key,
  projectFilePaths: ProjectTreeFileIndex.empty.paths,
  subagents: [],
  threads: [],
  isProjectLoading: false,
  isThreadsLoading: false,
  changes: {},
  currentPath: "",
  currentThreadId: "",
  expandedDirectories: [""],
  locallyModifiedPaths: [],
  threadsError: "",
  fontSize: 1.08,
  workbenchStorageRootPath: "",
};
const EMPTY_THREAD_SIDEBAR_SUBSCRIBE = (_listener: () => void) => () => {};

const EMPTY_THREAD_DOCUMENT_SNAPSHOT: WorkbenchThreadDocumentSnapshot = {
  documentsByKey: {},
  keysByThreadId: {},
  selectedThreadKey: "",
};

const MOBILE_SHELL_HEADER_HIDE_THRESHOLD_PX = 24;
const MOBILE_SHELL_HEADER_SHOW_THRESHOLD_PX = 8;
const MOSAIC_RATE_LIMIT_REFRESH_INTERVAL_MS = 15_000;
const SETTINGS_ORDER: WorkbenchSettingKey[] = [
  "theme",
  "editorFontFamily",
  "editorSpellCheck",
  "composerSpellCheck",
  "fileOpenBehavior",
  "showUnopenableFiles",
  "threadCodeBlockWrap",
  "editorFontSize",
];
const DEFAULT_LOCAL_CAPABILITY_SETTINGS: WorkbenchLocalCapabilitySettings = {
  browseRawCommandsEnabled: false,
};
const EDITOR_FONT_CLASS_NAMES: Record<WorkbenchEditorFontFamily, string> = {
  mono: "font-mono",
  sans: "font-sans",
  serif: "font-serif",
};
const EDITOR_FONT_SIZE_OPTIONS = [0.9, 1, 1.08, 1.18, 1.32, 1.48].map((value, index) => ({
  label: String(index + 1),
  value,
}));

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

function createFileOpenTarget (path: string, projectId?: string | null): WorkbenchFileOpenTarget {
  return { path, projectId };
}

function readPositiveIntegerDatasetValue (value: string | undefined) {
  const numericValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : null;
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
    return node.target.kind === "thread" && node.target.target.kind === "provider" && node.target.target.threadId === threadId;
  }

  return node.children.some((child) => mosaicContainsThreadTarget(child, threadId));
}

function getPanelTargetMosaicNode (target: WorkbenchPanelTarget): WorkbenchMosaicNode | null {
  if (target.kind === "file" || target.kind === "thread") {
    return createWorkbenchMosaicTarget(target);
  }

  return null;
}

function createInitialMosaicNode (
  currentTarget: WorkbenchPanelTarget,
  droppedTarget: WorkbenchPanelTarget,
  placement: WorkbenchDropPlacement,
): WorkbenchMosaicNode | null {
  const currentNode = getPanelTargetMosaicNode(currentTarget);
  const droppedNode = getPanelTargetMosaicNode(droppedTarget);
  if (!droppedNode) {
    return currentNode;
  }

  if (!currentNode) {
    return createWorkbenchMosaicSplit([droppedNode]);
  }

  const children = placement === "left" || placement === "top"
    ? [droppedNode, currentNode]
    : [currentNode, droppedNode];

  return placement === "top" || placement === "bottom"
    ? createWorkbenchMosaicSplit([createWorkbenchMosaicSplit(children)])
    : createWorkbenchMosaicSplit(children);
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

function filterVisibleUserInputRequestsByThreadId (
  requestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>,
  locallyResolvedRequestKeysByThreadId: Record<string, string | undefined>,
) {
  let didFilter = false;
  const visibleEntries = Object.entries(requestsByThreadId).filter(([threadId, request]) => {
    const isLocallyResolved = locallyResolvedRequestKeysByThreadId[threadId] === request.requestKey;
    if (isLocallyResolved) {
      didFilter = true;
    }
    return !isLocallyResolved;
  });

  return didFilter
    ? Object.fromEntries(visibleEntries)
    : requestsByThreadId;
}

function pruneResolvedUserInputRequestKeys (
  resolvedRequestKeysByThreadId: Record<string, string | undefined>,
  requestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>,
) {
  let didChange = false;
  const nextResolvedRequestKeysByThreadId = { ...resolvedRequestKeysByThreadId };

  for (const [threadId, resolvedRequestKey] of Object.entries(resolvedRequestKeysByThreadId)) {
    const pendingRequest = requestsByThreadId[threadId];
    if (pendingRequest?.requestKey === resolvedRequestKey) {
      continue;
    }

    delete nextResolvedRequestKeysByThreadId[threadId];
    didChange = true;
  }

  return didChange
    ? nextResolvedRequestKeysByThreadId
    : resolvedRequestKeysByThreadId;
}

export default function Workbench ({ appRuntime = null }: { appRuntime?: WorkbenchAppRuntimeStore | null }) {
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const [composerProfileController] = useState(() => new WorkbenchComposerProfileController(clientStateController));
  useEffect(() => {
    void composerProfileController.initializePersistence(createComposerProfilePersistence());

    return () => {
      composerProfileController.dispose();
    };
  }, [composerProfileController]);
  const { navigateToRoute, route } = useWorkbenchRoute();
  const currentRouteRef = useRef<WorkbenchRoute>(route);
  currentRouteRef.current = route;
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [threadSidebarStore, setThreadSidebarStore] = useState<WorkbenchThreadSidebarStore | null>(null);
  const [currentThread, setCurrentThread] = useState<ThreadPayload | null>(null);
  const [threadDocuments, setThreadDocuments] = useState<WorkbenchThreadDocumentSnapshot>(EMPTY_THREAD_DOCUMENT_SNAPSHOT);
  const [threadRelativeTimeNowMs, setThreadRelativeTimeNowMs] = useState(() => Date.now());
  const [harnessUserInputRequestsByThreadId, setHarnessUserInputRequestsByThreadId] = useState<Record<string, WorkbenchPendingUserInputRequest>>({});
  const [locallyResolvedUserInputRequestKeysByThreadId, setLocallyResolvedUserInputRequestKeysByThreadId] = useState<Record<string, string | undefined>>({});
  const [selectionError, setSelectionError] = useState("");
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshot | null>(null);
  const [controls, setControls] = useState<WorkbenchControls | null>(null);
  const [harness, setHarness] = useState<WorkbenchHarness>(() => (
    clientStateController.records("globalPreference").find((record) => (
      record.preference.key === "harness"
    ))?.preference.value as WorkbenchHarness | undefined
  ) ?? "codex");
  const [isMobile, setIsMobile] = useState(false);
  const [mobileShellHeaderHeight, setMobileShellHeaderHeight] = useState(0);
  const [isMobileShellHeaderVisible, setIsMobileShellHeaderVisible] = useState(true);
  const [mobilePane, setMobilePane] = useState<MobilePane>("explorer");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [pendingDeleteFilePath, setPendingDeleteFilePath] = useState("");
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [projectActionError, setProjectActionError] = useState("");
  const [globalSettings, setGlobalSettings] = useState<WorkbenchGlobalSettings>(() => (
    readGlobalWorkbenchSettings(clientState.records)
  ));
  const [localCapabilitySettings, setLocalCapabilitySettings] = useState<WorkbenchLocalCapabilitySettings>(DEFAULT_LOCAL_CAPABILITY_SETTINGS);
  const [isLocalCapabilitySettingsLoading, setIsLocalCapabilitySettingsLoading] = useState(false);
  const [localCapabilitySettingsError, setLocalCapabilitySettingsError] = useState("");
  const [browseSessions, setBrowseSessions] = useState<WorkbenchBrowseSessionSummary[]>([]);
  const [isBrowseSessionsLoading, setIsBrowseSessionsLoading] = useState(false);
  const [browseSessionsError, setBrowseSessionsError] = useState("");
  const [projectSettingsByProjectId, setProjectSettingsByProjectId] = useState<Record<string, WorkbenchProjectSettings>>({});
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");
  const [quickOpenUpdatedAtByPath, setQuickOpenUpdatedAtByPath] = useState<Record<string, string>>({});
  const [mainLayout, setMainLayout] = useState<WorkbenchMainLayoutState>(() => WorkbenchMainLayout.fromTarget({ kind: "empty" }));
  const [mosaicDraftThreadsById, setMosaicDraftThreadsById] = useState<Record<string, ThreadPayload | undefined>>({});
  const [threadComposerDraftsByThreadId, setThreadComposerDraftsByThreadId] = useState<Record<string, WorkbenchComposerInputDraft | undefined>>({});
  const [threadQuestionnaireDraftsByKey, setThreadQuestionnaireDraftsByKey] = useState<Record<string, WorkbenchQuestionnaireDraft | undefined>>({});
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
  const zoomOutButtonRef = useRef<HTMLButtonElement>(null);
  const zoomInButtonRef = useRef<HTMLButtonElement>(null);
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
  const pendingEditorFontSizeSyncRef = useRef<number | null>(null);
  const retainedThreadRef = useRef<ThreadPayload | null>(null);
  const threadViewInstanceKeysByThreadIdRef = useRef(new Map<string, string>());
  const workbenchDragController = useMemo(() => new WorkbenchDragController(), []);
  const workbenchDragActivity = useSyncExternalStore(workbenchDragController.subscribe, workbenchDragController.getActivitySnapshot, workbenchDragController.getActivitySnapshot);
  const activeWorkbenchDrag = workbenchDragActivity.active && workbenchDragActivity.payload
    ? { payload: workbenchDragActivity.payload }
    : null;
  useEffect(() => () => { workbenchDragController.dispose(); }, [workbenchDragController]);

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
      || !zoomOutButtonRef.current
      || !zoomInButtonRef.current
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
        zoomInButton: zoomInButtonRef.current,
        zoomOutButton: zoomOutButtonRef.current,
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

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => { };
    let initTimeoutId: number | null = null;
    const scheduleWorkbenchStateUpdate = (callback: () => void) => {
      if (cancelled) {
        return;
      }

      startTransition(() => {
        if (cancelled) {
          return;
        }

        callback();
      });
    };

    initTimeoutId = window.setTimeout(() => {
      void import("../lib/WorkbenchClient").then(async ({ WorkbenchClient: initWorkbench }) => {
        const dom = getWorkbenchDomSurfaces();
        const nextCleanup = await initWorkbench({
          clientStateController,
          dom,
          initialRoute: currentRouteRef.current,
          onExplorerStateChange: (snapshot) => {
            scheduleWorkbenchStateUpdate(() => {
              setExplorer(snapshot);
            });
          },
          onCurrentThreadChange: (thread) => {
            scheduleWorkbenchStateUpdate(() => {
              setCurrentThread(thread);
            });
          },
          onThreadDocumentsChange: (snapshot) => {
            scheduleWorkbenchStateUpdate(() => {
              setThreadDocuments(snapshot);
            });
          },
          onPendingUserInputRequestsChange: (requestsByThreadId) => {
            scheduleWorkbenchStateUpdate(() => {
              setHarnessUserInputRequestsByThreadId(requestsByThreadId);
              setLocallyResolvedUserInputRequestKeysByThreadId((current) => (
                pruneResolvedUserInputRequestKeys(current, requestsByThreadId)
              ));
            });
          },
          onRateLimitsChange: (nextRateLimits) => {
            scheduleWorkbenchStateUpdate(() => {
              setRateLimits(nextRateLimits);
            });
          },
          onThreadSidebarStoreReady: (store) => {
            if (cancelled) return;
            setThreadSidebarStore(store);
          },
          onControlsReady: (nextControls) => {
            if (cancelled) {
              return;
            }

            setControls(nextControls);
          },
        });

        if (cancelled) {
          nextCleanup?.();
          return;
        }

        cleanup = nextCleanup ?? (() => { });
      });
    }, 0);

    return () => {
      cancelled = true;
      if (initTimeoutId !== null) {
        window.clearTimeout(initTimeoutId);
      }
      cleanup();
    };
  }, [clientStateController]);

  const selectedThreadProjectId = route.view === "thread"
    ? route.threadOwnerProjectId || explorer.currentProjectId || route.projectId
    : explorer.currentProjectId;
  useEffect(() => {
    if (!selectedThreadProjectId) {
      setThreadComposerDraftsByThreadId({});
      setThreadQuestionnaireDraftsByKey({});
      return;
    }

    setThreadComposerDraftsByThreadId(Object.fromEntries(
      clientState.records.flatMap((record) => (
        record.kind === "composerDraft"
        && record.daemonRegistrationId === clientState.daemonRegistrationId
        && record.projectId === selectedThreadProjectId
          ? [[record.threadId, record.value]]
          : []
      )),
    ));
    setThreadQuestionnaireDraftsByKey(Object.fromEntries(
      clientState.records.flatMap((record) => (
        record.kind === "questionnaireDraft"
        && record.daemonRegistrationId === clientState.daemonRegistrationId
        && record.projectId === selectedThreadProjectId
          ? [[`${record.threadId}:${record.requestKey}`, record.value]]
          : []
      )),
    ));
  }, [clientState.daemonRegistrationId, clientState.records, selectedThreadProjectId]);

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

  const routeMosaicNodeForControls = isMobile && route.view === "mosaic" ? route.mosaicNode : null;
  const routeToApplyToControls = useMemo(() => {
    if (route.view === "mosaic") {
      const mobileMosaicTarget = getRouteMosaicFallbackTarget(routeMosaicNodeForControls, isMobile);
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
      return route.threadOwnerProjectId && route.threadOwnerProjectId !== route.projectId
        ? createPinnedThreadRoute(route.projectId, route.threadOwnerProjectId, route.threadTarget ?? route.threadId)
        : createThreadRoute(route.projectId, route.threadTarget ?? route.threadId);
    }
    if (route.view === "settings") {
      return createSettingsRoute(route.projectId, route.settingsScope);
    }
    if (route.view === "project") {
      return createProjectRoute(route.projectId);
    }

    return route;
  }, [
    isMobile,
    route.error,
    route.filePath,
    route.projectId,
    route.settingsScope,
    route.threadId,
    route.threadTarget,
    route.view,
    routeMosaicNodeForControls,
  ]);

  useEffect(() => {
    if (!controls) {
      return;
    }

    if (routeToApplyToControls.view === "file" && !isWorkbenchOpenableFile(routeToApplyToControls.filePath)) {
      setSelectionError(`This file cannot be opened here: ${routeToApplyToControls.filePath}`);
      return;
    }

    setSelectionError("");
    let cancelled = false;
    void controls.applyRoute(routeToApplyToControls).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok && result.error) {
        setSelectionError(result.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [controls, routeToApplyToControls]);

  const expandedDirectories = new Set(explorer.expandedDirectories);
  const modifiedPaths = new Set(explorer.locallyModifiedPaths);
  const currentProject = explorer.projects.find((project) => project.id === explorer.currentProjectId) ?? null;
  const activeProjectId = explorer.currentProjectId || route.projectId;
  const refreshBrowseSessions = useCallback(async (
    projectId = activeProjectId,
    options: { signal?: AbortSignal } = {},
  ) => {
    if (!projectId) {
      setBrowseSessions([]);
      setBrowseSessionsError("");
      return;
    }

    setIsBrowseSessionsLoading(true);
    setBrowseSessionsError("");
    try {
      const response = await fetch(`/api/browse/sessions?projectId=${encodeURIComponent(projectId)}`, {
        cache: "no-store",
        signal: options.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unable to load Browse sessions." }));
        throw new Error(error.error);
      }

      const payload = await response.json() as WorkbenchBrowseSessionListResponse;
      if (!options.signal?.aborted) setBrowseSessions(payload.sessions);
    } catch (error) {
      if (!options.signal?.aborted) {
        setBrowseSessionsError(error instanceof Error ? error.message : "Unable to load Browse sessions.");
      }
    } finally {
      if (!options.signal?.aborted) setIsBrowseSessionsLoading(false);
    }
  }, [activeProjectId]);
  useEffect(() => {
    if (!activeProjectId) {
      setBrowseSessions([]);
      setBrowseSessionsError("");
      return;
    }

    let activeController: AbortController | null = null;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      try {
        await refreshBrowseSessions(activeProjectId, { signal: controller.signal });
      } finally {
        if (activeController === controller) {
          activeController = null;
          inFlight = false;
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);

    return () => {
      activeController?.abort();
      window.clearInterval(timer);
    };
  }, [activeProjectId, refreshBrowseSessions]);
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
    navigateToRoute(ownerProjectId === route.projectId
      ? createThreadRoute(route.projectId, target)
      : createPinnedThreadRoute(route.projectId, ownerProjectId, target), { replace: true });
  }, [explorer.subagents, navigateToRoute, route.projectId, route.threadOwnerProjectId, route.threadTarget, route.view]);
  const projectFileLinkRoots = useMemo(
    () => createProjectFileLinkRoots(explorer.projects, activeProjectId, explorer.roots),
    [activeProjectId, explorer.projects, explorer.roots],
  );
  const isProjectIdentityLoading = Boolean(route.projectId) && route.projectId !== explorer.currentProjectId;
  const isProjectTreeLoading = isProjectIdentityLoading || (explorer.isProjectLoading && explorer.tree.length === 0);
  const currentProjectDisplayName = currentProject
    ? `${currentProject.name || currentProject.id}${currentProject.kind === "workspace" ? " workspace" : ""}`
    : null;
  const pageTitle = formatWorkbenchPageTitle(currentProjectDisplayName ?? explorer.root ?? explorer.currentProjectId);
  const projectSettings = explorer.currentProjectId
    ? projectSettingsByProjectId[explorer.currentProjectId] ?? createDefaultProjectWorkbenchSettings()
    : createDefaultProjectWorkbenchSettings();
  const resolvedSettings = resolveWorkbenchSettings(globalSettings, projectSettings);
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
  const projectTabLabel = getProjectTabLabel(currentProjectDisplayName ?? explorer.root);
  const settingsScope = route.view === "settings" ? route.settingsScope : "global";
  const editorFontClassName = EDITOR_FONT_CLASS_NAMES[resolvedSettings.editorFontFamily];

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    setGlobalSettings(readGlobalWorkbenchSettings(clientState.records));
    const storedHarness = clientState.records.find((record) => (
      record.kind === "globalPreference" && record.preference.key === "harness"
    ));
    if (storedHarness?.kind === "globalPreference" && typeof storedHarness.preference.value === "string") {
      setHarness(storedHarness.preference.value as WorkbenchHarness);
    }
  }, [clientState.records]);

  useEffect(() => {
    if (!explorer.currentProjectId) return;
    setProjectSettingsByProjectId((current) => ({
      ...current,
      [explorer.currentProjectId]: readProjectWorkbenchSettings(
        clientState.daemonRegistrationId,
        explorer.currentProjectId,
        clientState.records,
      ),
    }));
  }, [clientState.daemonRegistrationId, clientState.records, explorer.currentProjectId]);

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

  useEffect(() => {
    let cancelled = false;
    setIsLocalCapabilitySettingsLoading(true);
    setLocalCapabilitySettingsError("");
    void fetch("/api/workbench-settings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load local capabilities (${response.status}).`);
        }
        return await response.json() as WorkbenchLocalCapabilitySettingsResponse;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setLocalCapabilitySettings(payload.localCapabilities);
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        setLocalCapabilitySettings(DEFAULT_LOCAL_CAPABILITY_SETTINGS);
        setLocalCapabilitySettingsError(error.message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLocalCapabilitySettingsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateBrowseRawCommandsEnabled = useCallback((enabled: boolean) => {
    const previousSettings = localCapabilitySettings;
    setLocalCapabilitySettings((current) => ({
      ...current,
      browseRawCommandsEnabled: enabled,
    }));
    setIsLocalCapabilitySettingsLoading(true);
    setLocalCapabilitySettingsError("");
    void fetch("/api/workbench-settings", {
      body: JSON.stringify({
        localCapabilities: {
          browseRawCommandsEnabled: enabled,
        },
      }),
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      method: "PUT",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to update local capabilities (${response.status}).`);
        }
        return await response.json() as WorkbenchLocalCapabilitySettingsResponse;
      })
      .then((payload) => {
        setLocalCapabilitySettings(payload.localCapabilities);
      })
      .catch((error: Error) => {
        setLocalCapabilitySettings(previousSettings);
        setLocalCapabilitySettingsError(error.message);
      })
      .finally(() => {
        setIsLocalCapabilitySettingsLoading(false);
      });
  }, [localCapabilitySettings]);

  const updateGlobalSetting = useCallback(<K extends WorkbenchSettingKey> (key: K, value: WorkbenchGlobalSettings[K]) => {
    setGlobalSettings((current) => {
      const nextSettings = {
        ...current,
        [key]: key === "editorFontSize" && typeof value === "number" ? clampEditorFontSize(value) : value,
      };
      void writeGlobalWorkbenchSettings(clientStateController, nextSettings).catch((error: Error) => {
        setSelectionError(error.message);
      });
      return nextSettings;
    });
  }, [clientStateController]);

  const updateProjectSetting = useCallback(<K extends WorkbenchSettingKey> (key: K, value: WorkbenchGlobalSettings[K]) => {
    const projectId = explorer.currentProjectId;
    if (!projectId) {
      return;
    }

    setProjectSettingsByProjectId((current) => {
      const currentSettings = current[projectId] ?? readProjectWorkbenchSettings(
        clientState.daemonRegistrationId,
        projectId,
        clientState.records,
      );
      const nextSettings = {
        ...currentSettings,
        [key]: {
          ...currentSettings[key],
          enabled: true,
          value: key === "editorFontSize" && typeof value === "number" ? clampEditorFontSize(value) : value,
        },
      } satisfies WorkbenchProjectSettings;
      void writeProjectWorkbenchSettings(clientStateController, projectId, nextSettings).catch((error: Error) => {
        setSelectionError(error.message);
      });
      return {
        ...current,
        [projectId]: nextSettings,
      };
    });
  }, [clientState.daemonRegistrationId, clientState.records, clientStateController, explorer.currentProjectId]);

  const resetProjectSettingOverride = useCallback((key: WorkbenchSettingKey) => {
    const projectId = explorer.currentProjectId;
    if (!projectId) {
      return;
    }

    setProjectSettingsByProjectId((current) => {
      const currentSettings = current[projectId] ?? readProjectWorkbenchSettings(
        clientState.daemonRegistrationId,
        projectId,
        clientState.records,
      );
      const nextSettings = {
        ...currentSettings,
        [key]: {
          ...currentSettings[key],
          enabled: false,
        },
      } satisfies WorkbenchProjectSettings;
      void writeProjectWorkbenchSettings(clientStateController, projectId, nextSettings).catch((error: Error) => {
        setSelectionError(error.message);
      });
      return {
        ...current,
        [projectId]: nextSettings,
      };
    });
  }, [clientState.daemonRegistrationId, clientState.records, clientStateController, explorer.currentProjectId]);

  const updateThreadCodeBlockWrapSetting = useCallback((nextValue: boolean) => {
    if (explorer.currentProjectId) {
      updateProjectSetting("threadCodeBlockWrap", nextValue);
      return;
    }

    updateGlobalSetting("threadCodeBlockWrap", nextValue);
  }, [explorer.currentProjectId, updateGlobalSetting, updateProjectSetting]);

  useEffect(() => {
    document.documentElement.dataset.workbenchTheme = resolvedSettings.theme;
  }, [resolvedSettings.theme]);

  useEffect(() => {
    pendingEditorFontSizeSyncRef.current = resolvedSettings.editorFontSize;
    controls?.setEditorFontSize(resolvedSettings.editorFontSize);
  }, [controls, resolvedSettings.editorFontSize]);

  useEffect(() => {
    if (pendingEditorFontSizeSyncRef.current !== null) {
      if (explorer.fontSize === pendingEditorFontSizeSyncRef.current) {
        pendingEditorFontSizeSyncRef.current = null;
      }
      return;
    }

    if (!controls || explorer.fontSize === resolvedSettings.editorFontSize) {
      return;
    }

    if (projectSettings.editorFontSize.enabled) {
      updateProjectSetting("editorFontSize", explorer.fontSize);
      return;
    }

    updateGlobalSetting("editorFontSize", explorer.fontSize);
  }, [
    controls,
    explorer.fontSize,
    projectSettings.editorFontSize.enabled,
    resolvedSettings.editorFontSize,
    updateGlobalSetting,
    updateProjectSetting,
  ]);

  const openSettingsScopeFromLink = useCallback((event: MouseEvent<HTMLAnchorElement>, scope: WorkbenchSettingsScope) => {
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
    navigateToRoute(createSettingsRoute(activeProjectId, scope));
  }, [activeProjectId, navigateToRoute]);

  const openSettingsFromLink = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    openSettingsScopeFromLink(event, "global");
  }, [openSettingsScopeFromLink]);

  const selectProjectFromLink = useCallback((event: MouseEvent<HTMLAnchorElement>, projectId: string) => {
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
    if (projectId === explorer.currentProjectId) {
      return;
    }

    setCurrentThread(null);
    navigateToRoute(createProjectRoute(projectId));
  }, [explorer.currentProjectId, navigateToRoute]);

  const openFileInWorkbench = useCallback(async (target: WorkbenchFileOpenTarget) => {
    const path = target.path;
    const targetProjectId = target.projectId ?? explorer.currentProjectId ?? route.projectId;
    if (!isWorkbenchOpenableFile(path)) {
      return false;
    }

    if (route.view === "file" && path === route.filePath && route.projectId === targetProjectId) {
      return true;
    }

    navigateToRoute(createFileRoute(targetProjectId, path));
    return true;
  }, [explorer.currentProjectId, navigateToRoute, route]);

  const openFileInVsCode = useCallback(async (target: WorkbenchFileOpenTarget) => {
    const payload: OpenFileInEditorRequest = {
      absolutePath: target.absolutePath ?? null,
      columnNumber: target.columnNumber ?? null,
      lineNumber: target.lineNumber ?? null,
      path: target.path,
      projectId: target.projectId ?? explorer.currentProjectId ?? route.projectId,
    };
    const response = await fetch("/api/file/open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to open file in VS Code." }));
      console.error(error.error);
      return false;
    }

    return true;
  }, [explorer.currentProjectId, route.projectId]);

  const openFileByPolicy = useCallback(async (target: WorkbenchFileOpenTarget) => {
    const path = target.path;
    if (target.absolutePath) {
      return await openFileInVsCode(target);
    }

    const isOpenableInWorkbench = isWorkbenchOpenableFile(path);
    if (resolvedSettings.fileOpenBehavior === "vscode") {
      return await openFileInVsCode(target);
    }

    if (isOpenableInWorkbench) {
      return await openFileInWorkbench(target);
    }

    if (resolvedSettings.fileOpenBehavior === "workbench-or-vscode") {
      return await openFileInVsCode(target);
    }

    return false;
  }, [openFileInVsCode, openFileInWorkbench, resolvedSettings.fileOpenBehavior]);

  const openFileFromExplorer = useCallback(async (path: string) => (
    await openFileByPolicy(createFileOpenTarget(path, explorer.currentProjectId || route.projectId))
  ), [explorer.currentProjectId, openFileByPolicy, route.projectId]);

  const openThreadFromExplorer = useCallback(async (target: import("../lib/workbench/thread/thread-state").WorkbenchThreadTarget, ownerProjectId?: string) => {
    const viewedProjectId = explorer.currentProjectId || route.projectId;
    const targetProjectId = ownerProjectId ?? viewedProjectId;
    if (route.view === "thread" && route.projectId === viewedProjectId && (route.threadOwnerProjectId || route.projectId) === targetProjectId && route.threadTarget && areDeeplyEqual(route.threadTarget, target)) {
      return true;
    }

    navigateToRoute(targetProjectId === viewedProjectId
      ? createThreadRoute(viewedProjectId, target)
      : createPinnedThreadRoute(viewedProjectId, targetProjectId, target));
    return true;
  }, [explorer.currentProjectId, navigateToRoute, route]);
  const updateBrowseSession = useCallback(async (session: WorkbenchBrowseSessionSummary, action: "forget" | "stop", options: { force?: boolean } = {}) => {
    if (!activeProjectId) {
      return;
    }

    const response = await fetch("/api/browse/sessions", {
      body: JSON.stringify({
        action,
        force: options.force === true,
        projectId: activeProjectId,
        session: session.name,
      }),
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to update Browse session." }));
      setBrowseSessionsError(error.error);
      return;
    }

    const payload = await response.json() as WorkbenchBrowseSessionControlResponse;
    if (payload.result?.ok === false) {
      setBrowseSessionsError(payload.result.error ?? "Unable to stop Browse session.");
    }
    await refreshBrowseSessions(activeProjectId);
  }, [activeProjectId, refreshBrowseSessions]);
  const getBrowseSessionContextMenu = useCallback((session: WorkbenchBrowseSessionSummary): WorkbenchContextMenuDefinition => ({
    id: `browse-session:${session.name}`,
    items: [
      {
        icon: <CopyIcon className="size-4" />,
        id: "copy-session",
        label: "Copy session name",
        onSelect: () => {
          void writeTextToClipboard(session.name);
        },
      },
      {
        icon: <StopIcon className="size-4" />,
        id: "stop-session",
        label: "Stop session",
        onSelect: () => {
          void updateBrowseSession(session, "stop");
        },
      },
      {
        icon: <StopIcon className="size-4" />,
        id: "force-stop-session",
        label: "Force stop session",
        onSelect: () => {
          void updateBrowseSession(session, "stop", { force: true });
        },
        tone: "danger",
      },
      {
        icon: <ArchiveIcon className="size-4" />,
        id: "forget-session",
        label: "Forget record",
        onSelect: () => {
          void updateBrowseSession(session, "forget");
        },
      },
    ],
    label: `Browse session actions for ${session.name}`,
  }), [updateBrowseSession]);
  const handleWorkbenchProjectFileLinkClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    if (!(event.target instanceof Element)) {
      return;
    }

    const control = event.target.closest("button[data-project-file-relative-path]");
    if (!(control instanceof HTMLButtonElement)) {
      return;
    }

    if (!control.closest("[data-thread-project-file-link-boundary='true']")) {
      return;
    }

    const path = control.dataset.projectFileRelativePath?.trim();
    if (!path) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void openFileByPolicy({
      absolutePath: control.dataset.projectFileAbsolutePath?.trim() || null,
      columnNumber: readPositiveIntegerDatasetValue(control.dataset.projectFileColumnNumber),
      lineNumber: readPositiveIntegerDatasetValue(control.dataset.projectFileLineNumber),
      path,
      projectId: control.dataset.projectFileProjectId?.trim() || null,
    });
  }, [openFileByPolicy]);

  const readThread = useCallback(async (threadId: string, nextHarness?: WorkbenchHarness, options?: WorkbenchReadThreadOptions) => {
    if (!controls) {
      return null;
    }

    return await controls.readThread(threadId, nextHarness, options);
  }, [controls]);

  const sendThreadMessage = useCallback(async (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => {
    if (!controls) {
      throw new ThreadMessageNotSentError();
    }
    const submittedRoute = currentRouteRef.current;
    let createdThread: ThreadPayload | null = null;
    let didMaterialize = false;

    const replaceMosaicDraftThread = (materializedThread: ThreadPayload, removeDraftState: boolean) => {
      if (removeDraftState) {
        setMosaicDraftThreadsById((current) => {
          const { [thread.id]: _removedDraft, new: _removedNewDraft, ...rest } = current;
          void _removedDraft;
          void _removedNewDraft;
          return rest;
        });
      }

      const currentRoute = currentRouteRef.current;
      if (currentRoute.view === "mosaic"
        && currentRoute.mosaicNode
        && materializedThread.id !== thread.id
        && mosaicContainsThreadTarget(currentRoute.mosaicNode, thread.id)
      ) {
        navigateToRoute(createMosaicRoute(
          currentRoute.projectId,
          replaceWorkbenchMosaicTarget(
            currentRoute.mosaicNode,
            { kind: "thread", target: { harness: thread.harness, kind: "provider", threadId: thread.id } },
            { kind: "thread", target: { harness: materializedThread.harness, kind: "provider", threadId: materializedThread.id } },
          ),
        ), { replace: true });
        return true;
      }

      return false;
    };

    const replaceCurrentDraftThreadRoute = (materializedThread: ThreadPayload, removeDraftState: boolean) => {
      if (materializedThread.id === thread.id) {
        return false;
      }

      if (replaceMosaicDraftThread(materializedThread, removeDraftState)) {
        return true;
      }

      const currentRoute = currentRouteRef.current;
      if (!isWorkbenchRouteOwnerOfThread(currentRoute, thread.id)) {
        return false;
      }

      const ownerProjectId = currentRoute.threadOwnerProjectId || currentRoute.projectId;
      navigateToRoute(ownerProjectId === currentRoute.projectId
        ? createThreadRoute(currentRoute.projectId, materializedThread.id)
        : createPinnedThreadRoute(currentRoute.projectId, ownerProjectId, materializedThread.id), { replace: true });
      return true;
    };

    const materializedOptions: WorkbenchSendThreadMessageOptions | undefined = thread.isDraft
      ? {
        ...options,
        onThreadCreated: (materializedThread) => {
          createdThread = materializedThread;
          const projectId = submittedRoute.projectId || explorer.currentProjectId;
          const submittedThreadKey = `${projectId}:${thread.harness}:${thread.id}`;
          const materializedThreadKey = `${projectId}:${materializedThread.harness}:${materializedThread.id}`;
          threadViewInstanceKeysByThreadIdRef.current.set(
            materializedThreadKey,
            threadViewInstanceKeysByThreadIdRef.current.get(submittedThreadKey) ?? thread.id,
          );
          options?.onThreadCreated?.(materializedThread);
          replaceCurrentDraftThreadRoute(materializedThread, false);
        },
        onThreadMaterialized: (materializedThread) => {
          didMaterialize = true;
          if (options?.composerProfileSlot) {
            composerProfileController.materializeSelection(options.composerProfileSlot, materializedThread.id, materializedThread.harness);
          }
          options?.onThreadMaterialized?.(materializedThread);
          replaceCurrentDraftThreadRoute(materializedThread, true);
        },
      }
      : options;
    let payload: ThreadPayload | null;
    try {
      payload = await controls.sendThreadMessage(thread, input, materializedOptions);
    } catch (error) {
      const currentRoute = currentRouteRef.current;
      if (!didMaterialize && createdThread && isWorkbenchRouteOwnerOfThread(currentRoute, createdThread.id)) {
        navigateToRoute(submittedRoute, { replace: true });
      }
      throw error;
    }
    if (payload) {
      if (thread.isDraft && options?.composerProfileSlot) {
        composerProfileController.materializeSelection(options.composerProfileSlot, payload.id, payload.harness);
      }
      if (thread.isDraft) {
        replaceCurrentDraftThreadRoute(payload, true);
      }
    }

    return payload;
  }, [composerProfileController, controls, navigateToRoute]);

  const activeSidebarDraftId = route.view === "thread" && route.threadTarget?.kind === "draft"
    ? route.threadTarget.draftId
    : "";
  const selectActiveSidebarDraft = useCallback((snapshot: ReturnType<WorkbenchThreadSidebarStore["getSnapshot"]>) => {
    if (!activeSidebarDraftId) return null;
    const entry = snapshot?.entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === activeSidebarDraftId);
    return entry?.entryKind === "draft" ? entry.draft : null;
  }, [activeSidebarDraftId]);
  const getActiveSidebarDraft = useCallback(() => selectActiveSidebarDraft(threadSidebarStore?.getSnapshot() ?? null), [selectActiveSidebarDraft, threadSidebarStore]);
  const activeSidebarDraft = useSyncExternalStore(
    threadSidebarStore?.subscribe ?? EMPTY_THREAD_SIDEBAR_SUBSCRIBE,
    getActiveSidebarDraft,
    getActiveSidebarDraft,
  );
  const selectedPinnedThreadDraft = route.view === "thread"
    && route.threadTarget?.kind === "draft"
    && route.threadOwnerProjectId
    && route.threadOwnerProjectId !== route.projectId
    ? controls?.getSelectedThreadDraft() ?? null
    : null;
  const activeRouteDraft = selectedPinnedThreadDraft ?? activeSidebarDraft;

  const getSidebarDraftComposerInput = useCallback((draft: WorkbenchThreadDraft | null): WorkbenchComposerInputDraft | null => {
    if (!draft) return null;
    const attachments = draft.attachments.flatMap((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return [];
      }
      const candidate = attachment as { id?: string; url?: string };
      return typeof candidate.id === "string" && typeof candidate.url === "string"
        ? [{ id: candidate.id, url: candidate.url }]
        : [];
    });
    return { attachments, text: draft.prompt, updatedAt: draft.updatedAt };
  }, []);

  const getThreadComposerDraftForTarget = useCallback((target: WorkbenchThreadTarget | null | undefined): WorkbenchComposerInputDraft | null => {
    if (!target || target.kind === "new") return null;
    if (target.kind === "provider" || target.kind === "subagent") return threadComposerDraftsByThreadId[target.threadId] ?? null;
    const entry = threadSidebarStore?.getSnapshot()?.entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === target.draftId);
    return entry?.entryKind === "draft" ? getSidebarDraftComposerInput(entry.draft) : null;
  }, [getSidebarDraftComposerInput, threadComposerDraftsByThreadId, threadSidebarStore]);

  const activeThreadComposerDraft = route.view === "thread" && route.threadTarget?.kind === "draft"
    ? getSidebarDraftComposerInput(activeRouteDraft)
    : getThreadComposerDraftForTarget(route.view === "thread" ? route.threadTarget : null);

  const handleThreadComposerDraftChange = useCallback((threadId: string, draft: WorkbenchComposerInputDraft, reason: "autosave" | "submission" = "autosave") => {
    if (!selectedThreadProjectId) {
      return;
    }
    const isProviderThread = threadId !== "new" && !threadId.startsWith("draft:");
    if (isProviderThread) {
      setThreadComposerDraftsByThreadId((current) => ({ ...current, [threadId]: draft }));
      void clientStateController.put({
        daemonRegistrationId: clientState.daemonRegistrationId,
        kind: "composerDraft",
        projectId: selectedThreadProjectId,
        threadId,
        value: draft,
      }).catch((error: Error) => setSelectionError(error.message));
      return;
    }
    if (!controls || route.view !== "thread") return;
    const target = route.threadTarget ?? { kind: "provider" as const, threadId: route.threadId };
    if (target.kind === "provider" || target.kind === "subagent") {
      return;
    }
    if (target.kind === "new" && reason !== "submission" && countDraftPromptTokens(draft.text) < 3) {
      return;
    }
    const now = Date.now();
    const privateDraftId = threadId.startsWith("draft:") ? threadId.slice("draft:".length) : "";
    const draftId = target.kind === "draft" ? target.draftId : privateDraftId || crypto.randomUUID();
    const existing = target.kind === "draft" ? activeRouteDraft : null;
    const profileSlot = target.kind === "draft"
      ? { draftId, harness: currentThread?.harness ?? existing?.harness ?? "codex", kind: "draft" as const, projectId: selectedThreadProjectId }
      : { kind: "new-thread" as const, projectId: selectedThreadProjectId };
    const profileSelection = composerProfileController.getSelection(profileSlot);
    const harness = currentThread?.harness ?? existing?.harness ?? "codex";
    const model = currentThread?.model ?? existing?.model ?? null;
    const threadDraft: WorkbenchThreadDraft = {
      agent: currentThread?.agentPath ?? existing?.agent ?? null,
      attachments: draft.attachments.map((attachment) => ({ id: attachment.id, url: attachment.url })) as WorkbenchThreadDraft["attachments"],
      clientUpdatedAt: now,
      composerSettings: {
        agentPath: currentThread?.agentPath ?? null,
        agentSource: null,
        harness,
        model: model ?? "",
        reasoningEffort: currentThread?.reasoningEffort ?? null,
        serviceTier: currentThread?.serviceTier === "fast" ? "fast" : null,
      },
      createdAt: existing?.createdAt ?? now,
      draftId,
      harness,
      model,
      profileId: profileSelection.kind === "profile" ? profileSelection.profileId : existing?.profileId ?? null,
      projectId: selectedThreadProjectId,
      prompt: draft.text,
      reasoningEffort: currentThread?.reasoningEffort ?? existing?.reasoningEffort ?? null,
      serviceTier: currentThread?.serviceTier ?? existing?.serviceTier ?? null,
      updatedAt: now,
    };
    controls.editThreadDraft(threadDraft, target.kind === "new" && target.folderId ? { folderId: target.folderId } : undefined);
    if (target.kind === "new") {
      composerProfileController.materializeDraftSelection(profileSlot, draftId, harness, selectedThreadProjectId);
      navigateToRoute(createThreadRoute(selectedThreadProjectId, { draftId, kind: "draft" }), { replace: true });
    }
  }, [
    activeRouteDraft,
    clientState.daemonRegistrationId,
    clientStateController,
    composerProfileController,
    controls,
    currentThread,
    navigateToRoute,
    route,
    selectedThreadProjectId,
  ]);

  const handleThreadComposerDraftClear = useCallback((threadId: string) => {
    if (!selectedThreadProjectId) return;
    const isProviderThread = threadId !== "new" && !threadId.startsWith("draft:");
    if (isProviderThread || threadComposerDraftsByThreadId[threadId]) {
      setThreadComposerDraftsByThreadId((current) => {
        if (!current[threadId]) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      void clientStateController.delete({
        daemonRegistrationId: clientState.daemonRegistrationId,
        kind: "composerDraft",
        projectId: selectedThreadProjectId,
        threadId,
      }).catch((error: Error) => setSelectionError(error.message));
      return;
    }
    const currentRoute = currentRouteRef.current;
    if (!controls || currentRoute.view !== "thread" || currentRoute.threadTarget?.kind !== "draft" || !isWorkbenchRouteOwnerOfThread(currentRoute, threadId)) {
      return;
    }
    void controls.deleteThreadDraft(currentRoute.threadTarget.draftId);
  }, [clientState.daemonRegistrationId, clientStateController, controls, selectedThreadProjectId, threadComposerDraftsByThreadId]);

  const handleThreadQuestionnaireDraftChange = useCallback((threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => {
    if (!selectedThreadProjectId || !requestKey) {
      return;
    }

    setThreadQuestionnaireDraftsByKey((current) => ({
      ...current,
      [`${threadId}:${requestKey}`]: draft,
    }));
    void clientStateController.put({
      daemonRegistrationId: clientState.daemonRegistrationId,
      kind: "questionnaireDraft",
      projectId: selectedThreadProjectId,
      requestKey,
      threadId,
      value: draft,
    }).catch((error: Error) => setSelectionError(error.message));
  }, [clientState.daemonRegistrationId, clientStateController, selectedThreadProjectId]);

  const handleThreadQuestionnaireDraftClear = useCallback((threadId: string, requestKey: string) => {
    if (!requestKey) {
      return;
    }

    setThreadQuestionnaireDraftsByKey((current) => {
      const key = `${threadId}:${requestKey}`;
      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });

    if (selectedThreadProjectId) {
      void clientStateController.delete({
        daemonRegistrationId: clientState.daemonRegistrationId,
        kind: "questionnaireDraft",
        projectId: selectedThreadProjectId,
        requestKey,
        threadId,
      }).catch((error: Error) => setSelectionError(error.message));
    }
  }, [clientState.daemonRegistrationId, clientStateController, selectedThreadProjectId]);

  const stopThread = useCallback(async (thread: ThreadPayload) => {
    if (!controls) {
      return null;
    }

    return await controls.stopThread(thread);
  }, [controls]);

  const compactThread = useCallback(async (thread: ThreadPayload) => {
    if (!controls) {
      return null;
    }

    return await controls.compactThread(thread);
  }, [controls]);

  const listThreadModels = useCallback(async (nextHarness: WorkbenchHarness, options?: WorkbenchListModelsOptions) => {
    if (!controls) {
      return [];
    }

    return await controls.listModels(nextHarness, options);
  }, [controls]);

  const setThreadModel = useCallback((threadId: string, model: string) => {
    controls?.setCurrentThreadModel(threadId, model);
  }, [controls]);

  const setThreadReasoningEffort = useCallback((threadId: string, effort: string | null) => {
    controls?.setCurrentThreadReasoningEffort(threadId, effort);
  }, [controls]);

  const setThreadServiceTier = useCallback((threadId: string, serviceTier: string | null) => {
    controls?.setCurrentThreadServiceTier(threadId, serviceTier);
  }, [controls]);

  const setThreadAgent = useCallback((threadId: string, agentPath: string | null) => {
    controls?.setCurrentThreadAgent(threadId, agentPath);
  }, [controls]);

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

  const submitUserInputRequest = useCallback(async (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => {
    if (!controls) {
      return;
    }

    const pendingRequestKey = harnessUserInputRequestsByThreadId[threadId]?.requestKey ?? null;
    await controls.submitPendingUserInputRequest(threadId, response, options);
    if (!pendingRequestKey) {
      return;
    }

    setLocallyResolvedUserInputRequestKeysByThreadId((current) => (
      current[threadId] === pendingRequestKey
        ? current
        : {
          ...current,
          [threadId]: pendingRequestKey,
        }
    ));
  }, [controls, harnessUserInputRequestsByThreadId]);

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
  const showSettingsView = route.view === "settings";
  const showFullBleedMainView = showMosaicView;
  const createThreadFromSidebar = useCallback((folderId?: string) => {
    if (showMosaicView || !controls) return;
    navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, folderId ? { folderId, kind: "new" } : { kind: "new" }));
  }, [controls, explorer.currentProjectId, navigateToRoute, route.projectId, showMosaicView]);
  const handleThreadSettled = useCallback((settledTarget: WorkbenchThreadTarget, ownerProjectId?: string) => {
    const currentRoute = currentRouteRef.current;
    if (currentRoute.view !== "thread"
      || (ownerProjectId && currentRoute.projectId !== ownerProjectId)
      || !isWorkbenchThreadTargetSelected(settledTarget, currentRoute.threadTarget)) {
      return;
    }

    navigateToRoute(createThreadRoute(currentRoute.projectId, { kind: "new" }));
  }, [navigateToRoute]);
  const usesDesktopSidebarCollapse = !isMobile;
  const effectiveThreadTarget = mobileMosaicFallbackTarget?.kind === "thread" ? mobileMosaicFallbackTarget.target : route.threadTarget;
  const effectiveThreadId = effectiveThreadTarget ? getWorkbenchThreadTargetRootId(effectiveThreadTarget) : route.threadId;
  const effectiveSelectedThreadId = effectiveThreadTarget ? getWorkbenchThreadTargetSelectedId(effectiveThreadTarget) : effectiveThreadId;
  const effectiveFilePath = mobileMosaicFallbackTarget?.kind === "file" ? mobileMosaicFallbackTarget.filePath : route.filePath;
  const showEmptyState = !showThreadView && !showFileView && !showSettingsView && !showMosaicView;
  const showRouteError = Boolean(selectionError) && !showThreadView && !showFileView && !showSettingsView && !showMosaicView;
  if (currentThread) {
    retainedThreadRef.current = currentThread;
  }
  const retainedThread = retainedThreadRef.current;
  const effectiveThreadRoute = effectiveThreadTarget
    ? route.view === "thread" && route.threadOwnerProjectId && route.threadOwnerProjectId !== route.projectId
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
      isWorkbenchRouteOwnerOfThread(effectiveThreadRoute, thread.id)
      || isWorkbenchRouteOwnerOfThread(effectiveThreadRoute, getThreadViewInstanceKey(thread))
    )
  );
  const documentThreadForThreadView = showThreadView
    ? getThreadDocumentFromSnapshot(threadDocuments, effectiveThreadId)
    : null;
  const threadForThreadView = documentThreadForThreadView
    ?? (isThreadOwnedByEffectiveRoute(currentThread)
      ? currentThread
      : null)
    ?? (isThreadOwnedByEffectiveRoute(retainedThread)
      ? retainedThread
      : null);
  const handleSelectedThreadChange = useCallback((selectedThreadId: string) => {
    if (!effectiveThreadTarget || effectiveThreadTarget.kind === "new" || effectiveThreadTarget.kind === "draft") return;
    const rootThreadId = getWorkbenchThreadTargetRootId(effectiveThreadTarget);
    const harness = effectiveThreadTarget.harness ?? threadForThreadView?.harness;
    const target = selectedThreadId === rootThreadId
      ? { harness, kind: "provider" as const, threadId: rootThreadId }
      : { harness, kind: "subagent" as const, parentThreadId: rootThreadId, threadId: selectedThreadId };
    const ownerProjectId = route.view === "thread" ? route.threadOwnerProjectId || route.projectId : activeProjectId;
    navigateToRoute(ownerProjectId === activeProjectId
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
  const visibleUserInputRequestsByThreadId = useMemo(() => (
    filterVisibleUserInputRequestsByThreadId(
      harnessUserInputRequestsByThreadId,
      locallyResolvedUserInputRequestKeysByThreadId,
    )
  ), [harnessUserInputRequestsByThreadId, locallyResolvedUserInputRequestKeysByThreadId]);
  const threadAttentionLabelsById = useMemo(() => Object.fromEntries(
    Object.entries(visibleUserInputRequestsByThreadId).flatMap(([threadId, pending]) => {
      const title = pending.request.title.trim();
      return title ? [[threadId, title]] : [];
    }),
  ), [visibleUserInputRequestsByThreadId]);
  const pendingQuestionnaireThreadIds = useMemo(
    () => new Set(Object.entries(visibleUserInputRequestsByThreadId)
      .map(([threadId]) => threadId)),
    [visibleUserInputRequestsByThreadId],
  );
  const threadProjectId = route.view === "thread" ? route.threadOwnerProjectId || activeProjectId : activeProjectId;
  const threadProject = explorer.projects.find((project) => project.id === threadProjectId) ?? null;
  const isForeignThreadProject = Boolean(threadProjectId && threadProjectId !== activeProjectId);
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
    const pendingRequest = visibleUserInputRequestsByThreadId[threadId]
      ?? (entry.pendingQuestionnaire ? {
        ...entry.pendingQuestionnaire,
        harness: entry.identity.harness,
        itemId: entry.pendingQuestionnaire.itemId ?? null,
        threadId,
        turnId: entry.pendingQuestionnaire.turnId ?? null,
      } satisfies WorkbenchPendingUserInputRequest : null);
    const proposalId = entry.gitArc?.proposals.find(({ status }) => status === "proposed")?.proposalId ?? null;
    const hasPlannedWork = Boolean(entry.gitArcPlan?.scopePaths.length);
    if (!pendingRequest && !proposalId && !hasPlannedWork) return null;
    const rootThreadId = entry.entryKind === "subagent" ? entry.parentThreadId : threadId;
    const cwd = entry.entryKind === "subagent"
      ? entry.cwd
      : threadSummariesById.get(threadId)?.cwd ?? null;
    const questionnaireDraft = pendingRequest
      ? threadQuestionnaireDraftsByKey[`${threadId}:${pendingRequest.requestKey}`] ?? null
      : null;
    return (
      <WorkbenchThreadTooltipDetails
        cwd={cwd}
        harness={entry.identity.harness}
        materialized={materializedThreadRootIds.has(rootThreadId)}
        onDraftChange={(draft) => handleThreadQuestionnaireDraftChange(threadId, pendingRequest?.requestKey ?? "", draft)}
        onDraftClear={() => handleThreadQuestionnaireDraftClear(threadId, pendingRequest?.requestKey ?? "")}
        onOpenThread={openThreadFromExplorer}
        onReadThread={controls ? readThread : null}
        onSubmitUserInputRequest={submitUserInputRequest}
        pendingRequest={pendingRequest}
        projectFilePaths={explorer.projectFilePaths}
        projectId={activeProjectId}
        projectRootPath={explorer.rootPath}
        proposalId={proposalId}
        questionnaireDraft={questionnaireDraft}
        spellCheck={resolvedSettings.composerSpellCheck}
        threadId={threadId}
        threadSidebarStore={threadSidebarStore}
        workspaceRoots={projectFileLinkRoots}
      />
    );
  }, [
    activeProjectId,
    controls,
    explorer.projectFilePaths,
    explorer.rootPath,
    handleThreadQuestionnaireDraftChange,
    handleThreadQuestionnaireDraftClear,
    materializedThreadRootIds,
    openThreadFromExplorer,
    projectFileLinkRoots,
    readThread,
    resolvedSettings.composerSpellCheck,
    submitUserInputRequest,
    threadQuestionnaireDraftsByKey,
    threadSidebarStore,
    threadSummariesById,
    visibleUserInputRequestsByThreadId,
  ]);
  const getSidebarLifecycleSignal = useCallback(() => {
    const entries = threadSidebarStore?.getSnapshot()?.entries ?? [];
    if (entries.some((entry) => entry.entryKind !== "draft" && entry.lifecycle.kind === "needsAttention")) return "needsAttention";
    if (entries.some((entry) => entry.entryKind !== "draft" && entry.lifecycle.kind === "working")) return "working";
    return "idle";
  }, [threadSidebarStore]);
  const sidebarLifecycleSignal = useSyncExternalStore(
    threadSidebarStore?.subscribe ?? EMPTY_THREAD_SIDEBAR_SUBSCRIBE,
    getSidebarLifecycleSignal,
    getSidebarLifecycleSignal,
  );
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
  const shouldShowShellHeader = !showFullBleedMainView && !showFileView && !showEmptyState && (!isMobile || mobilePane === "editor");
  const mainPaneScrollKey = showThreadView
    ? `thread:${activeThreadId}`
    : showFileView
      ? `file:${activeFilePath}`
      : showSettingsView
        ? "settings"
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
  const routeMosaicProjection = useMemo(() => (
    showMosaicView && route.mosaicNode
      ? createWorkbenchMainLayoutFromMosaic(route.mosaicNode)
      : null
  ), [route.mosaicNode, showMosaicView]);
  const routePanelTarget = useMemo<WorkbenchPanelTarget>(() => {
    if (showFileView) {
      return { filePath: effectiveFilePath, kind: "file" };
    }
    if (showThreadView) {
      return { kind: "thread", target: effectiveThreadTarget ?? { kind: "new" } };
    }
    if (showSettingsView) {
      return { kind: "settings", scope: settingsScope };
    }

    return { kind: "empty" };
  }, [effectiveFilePath, effectiveThreadTarget, settingsScope, showFileView, showSettingsView, showThreadView]);
  const temporaryDropLayout = useMemo(() => (
    !isMobile && !showMosaicView && activeWorkbenchDrag?.payload.type === "panel-target"
      ? WorkbenchMainLayout.fromTarget(routePanelTarget)
      : null
  ), [activeWorkbenchDrag?.payload.type, isMobile, routePanelTarget, showMosaicView]);
  const mainLayoutForRender = routeMosaicProjection?.layout ?? temporaryDropLayout;
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

  const navigateToPanelTarget = useCallback((target: WorkbenchPanelTarget, options?: { replace?: boolean }) => {
    if (target.kind === "file") {
      navigateToRoute(createFileRoute(explorer.currentProjectId || route.projectId, target.filePath), options);
      return;
    }
    if (target.kind === "thread") {
      navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, target.target), options);
      return;
    }
    if (target.kind === "settings") {
      navigateToRoute(createSettingsRoute(explorer.currentProjectId || route.projectId, target.scope), options);
      return;
    }

    navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId), options);
  }, [explorer.currentProjectId, navigateToRoute, route.projectId]);

  useEffect(() => {
    if (showMosaicView) {
      return;
    }

    setMainLayout((current) => WorkbenchMainLayout.replaceFocusedPanel(current, routePanelTarget));
  }, [routePanelTarget, showMosaicView]);

  const updateMainLayout = useCallback((nextLayout: WorkbenchMainLayoutState) => {
    setMainLayout(nextLayout);
    const focusedPanel = WorkbenchMainLayout.findPanel(nextLayout, nextLayout.focusedPanelId);
    if (focusedPanel) {
      navigateToPanelTarget(focusedPanel.target);
    }
  }, [navigateToPanelTarget]);

  const focusMainPanel = useCallback((panelId: string) => {
    const nextLayout = WorkbenchMainLayout.focusPanel(mainLayout, panelId);
    setMainLayout(nextLayout);
    const focusedPanel = WorkbenchMainLayout.findPanel(nextLayout, nextLayout.focusedPanelId);
    if (focusedPanel) {
      navigateToPanelTarget(focusedPanel.target);
    }
  }, [mainLayout, navigateToPanelTarget]);

  const navigateToMosaicNode = useCallback((mosaicNode: WorkbenchMosaicNode, options?: { replace?: boolean }) => {
    navigateToRoute(createMosaicRoute(explorer.currentProjectId || route.projectId, mosaicNode), options);
  }, [explorer.currentProjectId, navigateToRoute, route.projectId]);

  const handleMainLayoutPanelDrop = useCallback((drop: { panelId: string; placement: WorkbenchDropPlacement }, payload: Extract<WorkbenchDragPayload, { readonly type: "new-thread" | "panel-target" | "thread-row" }>) => {
    if (payload.type === "new-thread" && !controls) {
      return;
    }

    let target: WorkbenchPanelTarget = payload.type === "panel-target" || payload.type === "thread-row" ? payload.target : { kind: "empty" };
    if (payload.type === "new-thread") {
      const draftThread = controls!.createThreadDraft(payload.harness);
      setMosaicDraftThreadsById((current) => ({
        ...current,
        [draftThread.id]: draftThread,
      }));
      target = { kind: "thread", target: { kind: "provider", threadId: draftThread.id } };
    }
    if (route.view === "mosaic" && route.mosaicNode && routeMosaicProjection) {
      const panelPath = routeMosaicProjection.panelPathsById[drop.panelId];
      if (!panelPath) {
        return;
      }

      const dropPanel = WorkbenchMainLayout.findPanel(routeMosaicProjection.layout, drop.panelId);
      if (payload.type === "panel-target" && payload.sourcePanelId && dropPanel && (dropPanel.target.kind === "file" || dropPanel.target.kind === "thread")) {
        navigateToMosaicNode(moveWorkbenchMosaicTarget(route.mosaicNode, dropPanel.target, drop.placement, target));
        return;
      }

      navigateToMosaicNode(applyWorkbenchMosaicDrop(route.mosaicNode, panelPath, drop.placement, target));
      return;
    }

    const nextMosaicNode = createInitialMosaicNode(routePanelTarget, target, drop.placement);
    if (nextMosaicNode) {
      navigateToMosaicNode(nextMosaicNode);
    }
  }, [controls, navigateToMosaicNode, route.mosaicNode, route.view, routeMosaicProjection, routePanelTarget]);

  const updateMosaicPanelOptions = useCallback((panelId: string, options: { minimized?: boolean; zoomDelta?: number }) => {
    if (route.view !== "mosaic" || !route.mosaicNode || !routeMosaicProjection) {
      return;
    }

    const panelPath = routeMosaicProjection.panelPathsById[panelId];
    if (!panelPath) {
      return;
    }

    navigateToMosaicNode(updateWorkbenchMosaicPanelOptions(route.mosaicNode, panelPath, options), { replace: true });
  }, [navigateToMosaicNode, route.mosaicNode, route.view, routeMosaicProjection]);

  const resizeMosaicSplit = useCallback((splitId: string, firstPercent: number) => {
    if (route.view !== "mosaic" || !route.mosaicNode || !routeMosaicProjection) {
      return;
    }

    const resizeGroup = routeMosaicProjection.resizeGroupsById[splitId];
    if (!resizeGroup) {
      return;
    }

    navigateToMosaicNode(applyWorkbenchMosaicResize(route.mosaicNode, resizeGroup, firstPercent), { replace: true });
  }, [navigateToMosaicNode, route.mosaicNode, route.view, routeMosaicProjection]);

  const closeMosaicPanel = useCallback((target: WorkbenchPanelTarget) => {
    if (route.view !== "mosaic" || !route.mosaicNode) {
      return;
    }

    const nextNode = closeWorkbenchMosaicTarget(route.mosaicNode, target);
    if (nextNode) {
      navigateToMosaicNode(nextNode);
      return;
    }

    navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
  }, [explorer.currentProjectId, navigateToMosaicNode, navigateToRoute, route.mosaicNode, route.projectId, route.view]);

  const revealProjectEntry = useCallback(async (path: string) => {
    const projectId = explorer.currentProjectId || route.projectId;
    if (!projectId) {
      return;
    }

    setProjectActionError("");
    try {
      const request: RevealProjectEntryRequest = { path, projectId };
      const response = await fetch("/api/file/reveal", {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unable to show that entry in the file explorer." }));
        throw new Error(typeof error.error === "string" ? error.error : "Unable to show that entry in the file explorer.");
      }
    } catch (error) {
      setProjectActionError(error instanceof Error ? error.message : "Unable to show that entry in the file explorer.");
    }
  }, [explorer.currentProjectId, route.projectId]);

  const closeDeletedFileViews = useCallback((filePath: string) => {
    setMainLayout((current) => WorkbenchMainLayout.panels(current)
      .filter((panel) => panel.target.kind === "file" && panel.target.filePath === filePath)
      .reduce((next, panel) => WorkbenchMainLayout.closePanel(next, panel.id), current));

    if (route.view === "mosaic" && route.mosaicNode) {
      const nextNode = closeWorkbenchMosaicTarget(route.mosaicNode, { filePath, kind: "file" });
      if (nextNode) {
        navigateToMosaicNode(nextNode);
      } else {
        navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
      }
      return;
    }
    if (route.view === "file" && route.filePath === filePath) {
      navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
    }
  }, [explorer.currentProjectId, navigateToMosaicNode, navigateToRoute, route]);

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
        icon: <FileMoveIcon className="size-4" />,
        id: "reveal",
        label: "Show in File Explorer",
        onSelect: () => {
          void revealProjectEntry(node.path);
        },
      },
      ...(node.type === "file" ? [{
        icon: <BinIcon />,
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
    if (isMobile || event.button !== 0 || payload.type === "thread-folder") return;
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
      const response = await fetch(`/api/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
      if (!response.ok) {
        return null;
      }

      const payload = await response.json() as FilePayload;
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
  }, [explorer.currentProjectId, quickOpenPaths, route.projectId, showEmptyState]);

  const renderSettingControl = (
    key: WorkbenchSettingKey,
    value: WorkbenchGlobalSettings[WorkbenchSettingKey],
    disabled: boolean,
    onChange: (nextValue: WorkbenchGlobalSettings[WorkbenchSettingKey]) => void,
  ) => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    if (key === "editorFontSize") {
      return (
        <WorkbenchStepSlider
          ariaLabel={definition.label}
          disabled={disabled}
          steps={EDITOR_FONT_SIZE_OPTIONS}
          value={typeof value === "number" ? value : 1.08}
          onChange={(nextValue) => {
            onChange(nextValue);
          }}
        />
      );
    }

    if (definition.type === "boolean" && typeof value === "boolean") {
      return (
        <WorkbenchOptionCard
          description={definition.description}
          isChecked={value}
          isSingleChoice={false}
          label={definition.label}
          onClick={() => {
            onChange(!value);
          }}
        />
      );
    }

    if (definition.options) {
      return (
        <WorkbenchOptionCards<WorkbenchGlobalSettings[WorkbenchSettingKey]>
          ariaLabel={definition.label}
          columns={key === "theme" ? "two" : "one"}
          disabled={disabled}
          mode="radio"
          options={definition.options}
          value={value}
          onChange={(nextValue) => {
            if (!disabled) {
              onChange(nextValue);
            }
          }}
        />
      );
    }

    return null;
  };

  const renderGlobalSettingRow = (key: WorkbenchSettingKey) => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    if (definition.type === "boolean") {
      return (
        <section key={key} className="rounded-[0.85rem] py-1">
          {renderSettingControl(key, globalSettings[key], false, (nextValue) => {
            updateGlobalSetting(key, nextValue as never);
          })}
        </section>
      );
    }

    return (
      <section key={key} className="space-y-3 rounded-[0.85rem] py-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">{definition.label}</h3>
            <p className="mt-1 mb-0 text-[0.82rem] leading-6 text-muted">{definition.description}</p>
          </div>
        </div>
        {renderSettingControl(key, globalSettings[key], false, (nextValue) => {
          updateGlobalSetting(key, nextValue as never);
        })}
      </section>
    );
  };

  const renderLocalCapabilitySettings = () => (
    <section className="space-y-3 rounded-[0.85rem] py-1">
      <div className="min-w-0">
        <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">Local command capabilities</h3>
        <p className="mt-1 mb-0 text-[0.82rem] leading-6 text-muted">
          Dangerous local server capabilities. These settings are stored server-side so API routes can enforce them.
        </p>
      </div>
      <WorkbenchOptionCard
        description="Allow Workbench agents to send raw browse CLI args through /api/browse. Typed Browse API actions stay available. Default off."
        disabled={isLocalCapabilitySettingsLoading}
        isChecked={localCapabilitySettings.browseRawCommandsEnabled}
        isSingleChoice={false}
        label="Enable raw browse commands"
        onClick={() => {
          updateBrowseRawCommandsEnabled(!localCapabilitySettings.browseRawCommandsEnabled);
        }}
      />
      {localCapabilitySettingsError ? (
        <p className="m-0 text-[0.78rem] leading-5 text-danger">{localCapabilitySettingsError}</p>
      ) : null}
    </section>
  );

  const renderProjectSettingRow = (key: WorkbenchSettingKey) => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    const override = projectSettings[key];
    const inheritedValue = globalSettings[key];
    const displayedValue = override.enabled ? override.value : inheritedValue;
    if (definition.type === "boolean" && typeof displayedValue === "boolean") {
      return (
        <section key={key} className="relative rounded-[0.85rem] py-1">
          <WorkbenchOptionCard
            className={override.enabled ? "pr-12" : undefined}
            description={definition.description}
            isChecked={displayedValue}
            isSingleChoice={false}
            label={definition.label}
            onClick={() => {
              updateProjectSetting(key, !displayedValue as never);
            }}
          />
          {override.enabled ? (
            <button
              type="button"
              aria-label={`Reset ${definition.label} to global`}
              title={`Reset ${definition.label} to global`}
              className={`${workbenchIconButtonClassName} absolute top-1/2 right-3 -translate-y-1/2`}
              onClick={() => {
                resetProjectSettingOverride(key);
              }}
            >
              <ReloadIcon />
            </button>
          ) : null}
        </section>
      );
    }

    return (
      <section
        key={key}
        className="space-y-3 rounded-[0.85rem] py-1"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">{definition.label}</h3>
            <p className="mt-1 mb-0 text-[0.82rem] leading-6 text-muted">{definition.description}</p>
          </div>
          {override.enabled ? (
            <button
              type="button"
              aria-label={`Reset ${definition.label} to global`}
              title={`Reset ${definition.label} to global`}
              className={`${workbenchIconButtonClassName} shrink-0`}
              onClick={() => {
                resetProjectSettingOverride(key);
              }}
            >
              <ReloadIcon />
            </button>
          ) : null}
        </div>
        {renderSettingControl(key, displayedValue, false, (nextValue) => {
          updateProjectSetting(key, nextValue as never);
        })}
      </section>
    );
  };

  const handleHarnessChange = (nextHarness: WorkbenchHarness) => {
    if (nextHarness === harness && currentThread?.harness === nextHarness) {
      return;
    }

    void clientStateController.put({
      kind: "globalPreference",
      preference: { key: "harness", value: nextHarness },
    }).catch((error: Error) => setSelectionError(error.message));
    setHarness(nextHarness);
    controls?.setDraftThreadHarness(nextHarness);
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
        navigateToRoute(createFileRoute(explorer.currentProjectId || route.projectId, createdPath));
      }
    } catch (error) {
      setIsCreatingEntry(false);
      setCreateDialogError(error instanceof Error ? error.message : `Couldn't create the ${type === "file" ? "file" : "folder"}.`);
    }
  };

  return (
    <WorkbenchComposerProfileProvider controller={composerProfileController}>
      <WorkbenchSidebarPreferencesProvider
        projectId={explorer.currentProjectId || route.projectId}
      >
        {({ preferences: sidebarPreferences, setSidebarCollapsed }) => {
          const isEffectiveDesktopSidebarCollapsed = usesDesktopSidebarCollapse && sidebarPreferences.sidebarCollapsed;
          return (
      <WorkbenchDragProvider controller={workbenchDragController}>
        <WorkbenchContextMenuProvider>
        <div
          className={`relative isolate h-dvh overflow-hidden md:grid md:min-h-screen md:h-auto md:overflow-visible md:items-start${isEffectiveDesktopSidebarCollapsed
            ? " md:grid-cols-[minmax(0,1fr)]"
            : " md:grid-cols-[minmax(16rem,21rem)_1fr]"
            }`}
          onClick={handleWorkbenchProjectFileLinkClick}
        >
          {ambientCanvasVariant ? <WorkbenchAmbientCanvas variant={ambientCanvasVariant} /> : null}
          <WorkbenchTabIcon state={tabIconState} />
          {isEffectiveDesktopSidebarCollapsed ? (
            <>
              <button
                type="button"
                aria-label="Show sidebar"
                title="Show sidebar"
                className={`${workbenchIconButtonClassName} fixed left-3 top-3 z-40 hidden text-muted md:inline-flex`}
                onClick={() => {
                  setSidebarCollapsed(false);
                }}
              >
                <SidebarExpandIcon />
                <span className="sr-only">Show sidebar</span>
              </button>
              {showMosaicView ? (
                <button
                  type="button"
                  aria-label="Drag to create a new thread panel"
                  title="Drag to create a new thread panel"
                  className={`${workbenchIconButtonClassName} fixed left-14 top-3 z-40 hidden cursor-grab text-muted active:cursor-grabbing md:inline-flex`}
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
                  <SparkleIcon className="size-5" />
                  <span className="sr-only">Drag to create a new thread panel</span>
                </button>
              ) : null}
            </>
          ) : null}
          <div
            className="mobile-workbench-track flex h-dvh w-[200vw] overflow-hidden transition-transform duration-200 ease-out md:contents md:h-auto md:w-auto md:overflow-visible md:transform-none"
            style={mobileTrackStyle}
          >
            <aside className={`flex h-dvh w-screen min-w-0 shrink-0 select-none flex-col overflow-hidden py-3 pr-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:pr-6${isEffectiveDesktopSidebarCollapsed ? " md:hidden" : ""}`}>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-[0.95rem] leading-6">
                <DropTargetBoundary className="explorer-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto pr-2">
                <header className="-mr-2 grid shrink-0 grid-cols-[1fr_auto_auto] items-center gap-1 pb-5">
                  <span className="min-w-0 truncate pl-5 text-xl font-semibold leading-tight text-text">workbench</span>
                  <a
                    aria-label="Open settings"
                    className={`${workbenchIconButtonClassName} shrink-0 text-muted`}
                    href={createSettingsHref(activeProjectId, "global")}
                    onClick={openSettingsFromLink}
                    title="Open settings"
                  >
                    <GearIcon />
                    <span className="sr-only">Open settings</span>
                  </a>
                  {usesDesktopSidebarCollapse ? (
                    <button
                      aria-label="Hide sidebar"
                      className={`${workbenchIconButtonClassName} hidden shrink-0 text-muted md:inline-flex`}
                      onClick={() => setSidebarCollapsed(true)}
                      title="Hide sidebar"
                      type="button"
                    >
                      <SidebarCollapseIcon />
                      <span className="sr-only">Hide sidebar</span>
                    </button>
                  ) : null}
                </header>
                <WorkbenchThreadSidebarActionsProvider
                  controls={controls}
                  onOpenThread={openThreadFromExplorer}
                  onThreadSettled={handleThreadSettled}
                  projectId={explorer.currentProjectId || route.projectId}
                  store={threadSidebarStore}
                  threadSummariesById={threadSummariesById}
                >
                  <WorkbenchPinnedThreadSidebar
                    currentTarget={route.view === "thread" ? route.threadTarget : null}
                    onOpenThread={openThreadFromExplorer}
                    projectId={explorer.currentProjectId || route.projectId}
                    projects={explorer.projects}
                    selectedOwnerProjectId={route.view === "thread" ? route.threadOwnerProjectId || route.projectId : explorer.currentProjectId || route.projectId}
                  />
                  <ProjectSidebar
                    activeProjectId={activeProjectId}
                    onProjectLinkClick={selectProjectFromLink}
                    projects={explorer.projects}
                    store={threadSidebarStore}
                  />
                  {currentProject ? <WorkbenchCurrentProjectHeading project={currentProject} /> : null}
                  <section className="shrink-0 pb-5">
                    <WorkbenchSidebarSectionDisclosure
                      contentClassName="space-y-2"
                      icon={DraftThreadIcon}
                      preferenceKey="threadsOpen"
                      title="Threads"
                    >
                      <WorkbenchThreadSidebar
                        attentionLabelsByThreadId={threadAttentionLabelsById}
                        currentTarget={route.view === "thread" ? route.threadTarget : null}
                        harness={harness}
                        isDragActive={Boolean(activeWorkbenchDrag)}
                        onBeginPointerDrag={beginWorkbenchPointerDrag}
                        onCreateThread={createThreadFromSidebar}
                        onOpenThread={openThreadFromExplorer}
                        projectId={explorer.currentProjectId || route.projectId}
                        renderThreadTooltipDetails={renderThreadTooltipDetails}
                        showMosaicView={showMosaicView}
                      />
                    </WorkbenchSidebarSectionDisclosure>
                  </section>
                </WorkbenchThreadSidebarActionsProvider>

                  <section className="shrink-0 pb-5">
                    <WorkbenchSidebarSectionDisclosure
                      actions={(
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            aria-pressed={showUnopenableFiles}
                            disabled={!explorer.currentProjectId || isProjectTreeLoading}
                            title={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}${showUnopenableFiles ? " bg-accent-soft text-accent" : ""}`}
                            onClick={() => {
                              updateProjectSetting("showUnopenableFiles", !showUnopenableFiles);
                            }}
                          >
                            <FileVisibilityIcon visible={showUnopenableFiles} />
                            <span className="sr-only">
                              {showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label="Create in project"
                            title="Create in project"
                            className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}`}
                            disabled={!explorer.currentProjectId || isProjectTreeLoading}
                            onClick={() => {
                              openCreateDialog("");
                            }}
                          >
                            <NewEntryIcon />
                            <span className="sr-only">Create in project</span>
                          </button>
                        </div>
                      )}
                      contentClassName="space-y-2"
                      icon={FolderOpenIcon}
                      preferenceKey="explorerOpen"
                      title="Explorer"
                    >
                      {!explorer.projects.length && !isProjectIdentityLoading ? (
                        <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted md:pr-4.5">
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
                  </section>
                  {browseSessions.length ? (
                    <section className="shrink-0 pb-5">
                      <WorkbenchSidebarSectionDisclosure
                        contentClassName="space-y-2"
                        icon={BrowserSessionIcon}
                        preferenceKey="browseSessionsOpen"
                        title="Browse sessions"
                      >
                        <BrowseSessionsList
                          getSessionContextMenu={getBrowseSessionContextMenu}
                          isLoading={isBrowseSessionsLoading}
                          sessions={browseSessions}
                        />
                        {browseSessionsError ? (
                          <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">
                            {browseSessionsError}
                          </p>
                        ) : null}
                      </WorkbenchSidebarSectionDisclosure>
                    </section>
                  ) : null}
                  <ReloadNecessary
                    appRuntime={appRuntime}
                    reloadScopes={controls?.reloadScopes ?? null}
                    store={threadSidebarStore}
                  />
                </DropTargetBoundary>
              </div>
            </aside>

            <main
              ref={mainPaneRef}
              className={`explorer-scrollbar flex h-dvh w-screen min-w-0 shrink-0 flex-col overflow-x-hidden md:w-auto${isDirectThreadSurface
                ? " overflow-hidden px-0 pb-0 md:h-screen md:min-h-0 md:overflow-hidden md:px-6 md:pb-5"
                : showFullBleedMainView
                  ? " overflow-y-auto px-5 pb-5 md:h-screen md:min-h-0 md:overflow-hidden md:px-0 md:pb-0"
                  : " overflow-y-auto px-5 pb-5 md:h-auto md:min-h-screen md:overflow-visible md:px-6 md:pb-5"
                }`}
            >
              <ThreadScrollViewport
                ref={directThreadScrollViewportRef}
                className="h-full"
                contentClassName="flex flex-col"
                enabled={isDirectThreadSurface}
                resetKey={`${activeProjectId}:${selectedThreadIdForView || activeThreadId}`}
              >
              <header
                ref={shellHeaderRef}
                className={`
              sticky top-0 z-10 transform-gpu py-3 transition-[translate,opacity] duration-200 ease-out will-change-translate motion-reduce:transition-none ${isDirectMobileThreadSurface ? "px-5" : "-mx-5 px-5"} md:-mx-6 md:px-6
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
                  className="pointer-events-none absolute inset-0 -z-10 md:mx-auto md:max-w-[58rem] bg-[linear-gradient(to_bottom,var(--shell-fade-bg)_calc(100%-var(--spacing)*6),transparent)] md:backdrop-blur-none"
                />
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="order-2 min-w-0 w-full flex-1 md:order-1" hidden={Boolean(currentThread?.isDraft)}>
                    {showThreadView && threadShellSource && !isThreadShellTitleLoading ? (
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
                          ) : showSettingsView ? "Settings" : "Select a file"}
                        </p>
                        <p id="status-line" ref={statusLineRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted">
                          {showSettingsView ? "Theme and local Workbench preferences." : "Markdown files open as rich text. Save with Ctrl/Cmd+S."}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="order-1 flex items-center justify-between gap-3 md:order-2 md:ml-auto md:flex-none md:justify-end">
                    <button
                      type="button"
                      aria-label="Back to file explorer"
                      title="Back to file explorer"
                      hidden={!isMobile || mobilePane !== "editor"}
                      className={`${workbenchIconButtonClassName} shrink-0 md:hidden`}
                      onClick={() => {
                        navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
                      }}
                    >
                      <BackArrowIcon />
                      <span className="sr-only">Back to file explorer</span>
                    </button>
                    <div className="flex items-center gap-1.5">
                      <button
                        id="zoom-out"
                        ref={zoomOutButtonRef}
                        type="button"
                        title="Decrease editor text size"
                        aria-label="Decrease editor text size"
                        className={workbenchIconButtonClassName}
                      >
                        <ZoomOutIcon />
                        <span className="sr-only">Decrease editor text size</span>
                      </button>
                      <button
                        id="zoom-in"
                        ref={zoomInButtonRef}
                        type="button"
                        title="Increase editor text size"
                        aria-label="Increase editor text size"
                        className={workbenchIconButtonClassName}
                      >
                        <ZoomInIcon />
                        <span className="sr-only">Increase editor text size</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5" hidden={Boolean(currentThread) || showThreadView || showSettingsView}>
                      <button
                        id="save-file"
                        ref={saveFileButtonRef}
                        type="button"
                        title="Save current file"
                        aria-label="Save current file"
                        className={workbenchIconButtonClassName}
                        data-invalid="false"
                      >
                        <SaveIcon />
                        <span className="sr-only">Save current file</span>
                      </button>
                      <button
                        id="reset-draft"
                        ref={resetDraftButtonRef}
                        type="button"
                        title="Discard the current draft"
                        aria-label="Discard the current draft"
                        className={workbenchIconButtonClassName}
                      >
                        <BinIcon />
                        <span className="sr-only">Discard the current draft</span>
                      </button>
                    </div>
                  </div>
                </div>
              </header>

              <section
                className={`relative ${isDirectThreadSurface ? "min-h-0 flex-1" : "md:min-h-0 md:flex-1"}${showFullBleedMainView ? " min-h-0 overflow-hidden" : ""}`}
                aria-busy={isSelectionPending}
              >
                {showThreadView && !shouldRenderMainLayout ? (
                  isThreadViewReady && threadForThreadView ? (
                    <ThreadView
                      key={`${threadProjectId}:${threadViewInstanceKey}`}
                      thread={threadForThreadView}
                      composerSpellCheck={resolvedSettings.composerSpellCheck}
                      fontSizeRem={resolvedSettings.editorFontSize}
                      getThreadHref={(target) => isForeignThreadProject
                        ? createPinnedThreadHref(activeProjectId, threadProjectId, target)
                        : createThreadHref(activeProjectId, target)}
                      mobileFullBleed={isDirectMobileThreadSurface}
                      livePendingUserInputRequestsByThreadId={visibleUserInputRequestsByThreadId}
                      onDraftHarnessChange={handleHarnessChange}
                      onListModels={listThreadModels}
                      onOpenThread={(target) => { void openThreadFromExplorer(target, threadProjectId); }}
                      onReadThread={readThread}
                      onCompactThread={compactThread}
                      onSendMessage={sendThreadMessage}
                      onStopThread={stopThread}
                      onSubmitUserInputRequest={submitUserInputRequest}
                      onThreadComposerDraftChange={handleThreadComposerDraftChange}
                      onThreadComposerDraftClear={handleThreadComposerDraftClear}
                      onThreadQuestionnaireDraftChange={handleThreadQuestionnaireDraftChange}
                      onThreadQuestionnaireDraftClear={handleThreadQuestionnaireDraftClear}
                      onThreadAgentChange={setThreadAgent}
                      onThreadReasoningEffortChange={setThreadReasoningEffort}
                      onThreadServiceTierChange={setThreadServiceTier}
                      onThreadSettingsChange={setThreadComposerSettings}
                      onThreadModelChange={setThreadModel}
                      onUpdateThreadState={controls.updateThreadState}
                      selectedThreadId={selectedThreadIdForView}
                      onSelectedThreadChange={handleSelectedThreadChange}
                      onThreadCodeBlockWrapChange={updateThreadCodeBlockWrapSetting}
                      projectId={threadProjectId}
                      projectFileCandidates={isForeignThreadProject ? [] : explorer.projectFileCandidates}
                      projectFileIndexId={isForeignThreadProject ? `${threadProjectId}:foreign-pin:no-index` : explorer.projectFileIndexId}
                      projectFilePaths={isForeignThreadProject ? [] : explorer.projectFilePaths}
                      projectFileLinkRoots={threadProjectFileLinkRoots}
                      projectRootPath={threadProjectRootPath}
                      projectRoots={threadProjectRoots}
                      knownSubagents={explorer.subagents}
                      rateLimits={rateLimits}
                      scrollViewportRef={directThreadScrollViewportRef}
                      threadCodeBlockWrap={resolvedSettings.threadCodeBlockWrap}
                      threadComposerDraft={activeThreadComposerDraft}
                      threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                      threadDocuments={threadDocuments}
                      threadGoalControls={controls.threadGoals}
                      threadSidebarStore={threadSidebarStore}
                      threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
                      viewInstanceKey={threadViewInstanceKey}
                    />
                  ) : selectionError ? (
                    <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                      <div className="shadow-float flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger/30 bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                        <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-danger uppercase">Thread</p>
                        <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open thread</p>
                        <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{selectionError}</p>
                      </div>
                    </div>
                  ) : (
                    <ThreadLoadingSkeleton fillAvailableHeight />
                  )
                ) : null}
                {showSettingsView && !shouldRenderMainLayout ? (
                  <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-8 py-8">
                    <section className="space-y-6">
                      <div className="flex flex-wrap items-end justify-between gap-4">
                        <div className="space-y-2">
                          <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">Preferences</p>
                          <h1 className="m-0 text-[1.65rem] font-semibold leading-tight text-text">Settings</h1>
                        </div>
                        <div className="flex min-w-0 items-end gap-4" role="tablist" aria-label="Settings scope">
                          <a
                            href={createSettingsHref(activeProjectId, "global")}
                            role="tab"
                            aria-selected={settingsScope === "global"}
                            className={`border-b-2 px-0 pb-1 text-[0.9rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${settingsScope === "global"
                              ? " border-text text-text"
                              : " border-transparent text-muted hover:text-text"}`}
                            onClick={(event) => {
                              openSettingsScopeFromLink(event, "global");
                            }}
                          >
                            Global
                          </a>
                          <a
                            href={createSettingsHref(activeProjectId, "project")}
                            role="tab"
                            aria-selected={settingsScope === "project"}
                            className={`min-w-0 border-b-2 px-0 pb-1 text-[0.9rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${settingsScope === "project"
                              ? " border-text text-text"
                              : " border-transparent text-muted hover:text-text"}`}
                            onClick={(event) => {
                              openSettingsScopeFromLink(event, "project");
                            }}
                          >
                            <span className="block max-w-[12rem] truncate">{projectTabLabel}</span>
                          </a>
                        </div>
                      </div>

                      <div className="space-y-7" role="tabpanel">
                        {settingsScope === "global"
                          ? (
                            <>
                              {SETTINGS_ORDER.map((key) => renderGlobalSettingRow(key))}
                              {renderLocalCapabilitySettings()}
                            </>
                          )
                          : SETTINGS_ORDER.map((key) => renderProjectSettingRow(key))}
                      </div>
                    </section>
                  </div>
                ) : null}
                {showRouteError && !shouldRenderMainLayout ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                    <div className="shadow-float flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger/30 bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                      <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-danger uppercase">Route</p>
                      <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open route</p>
                      <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{selectionError}</p>
                    </div>
                  </div>
                ) : showEmptyState && !shouldRenderMainLayout ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                    <div className="flex w-full max-w-[42rem] flex-col gap-8">
                      <PrimaryButton
                        type="button"
                        className="w-fit gap-2"
                        onClick={() => {
                          if (!controls) {
                            return;
                          }
                          const draftThread = controls.createThreadDraft(harness);
                          navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, draftThread.id));
                        }}
                      >
                        <span className="inline-flex size-4 items-center justify-center text-[1.05em] leading-none">+</span>
                        <span>Create new thread</span>
                      </PrimaryButton>
                      {quickOpenPaths.length ? (
                        <div className="space-y-2">
                          {quickOpenPaths.map((path) => (
                            <button
                              key={path}
                              type="button"
                              className="flex w-full items-start justify-between gap-4 rounded-[1.15rem] px-4 py-3 text-left transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
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
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] text-muted">
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
                  <WorkbenchMainLayoutView
                    layout={mainLayoutForRender}
                    onFocusPanel={() => { }}
                    onLayoutChange={updateMainLayout}
                    onPanelDrop={handleMainLayoutPanelDrop}
                    onPointerDrop={endWorkbenchPointerDrag}
                    onSplitResize={resizeMosaicSplit}
                    renderPanel={({ isFocused, mosaicPanel, panelId, target }) => {
                      const panelZoomDelta = mosaicPanel?.zoomDelta ?? 0;
                      const panelFontSizeRem = clampEditorFontSize(resolvedSettings.editorFontSize + panelZoomDelta * 0.08);
                      const isMinimized = Boolean(mosaicPanel?.minimized);
                      const isMinimizedVertical = isMinimized && mosaicPanel?.parentDirection === "horizontal";
                      const hasSidebarRestoreInset = isEffectiveDesktopSidebarCollapsed
                        && showMosaicView
                        && panelId === mainLayoutForRender.focusedPanelId;
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
                            hasSidebarRestoreInset={hasSidebarRestoreInset}
                            isFocused={isFocused}
                            isMinimized={isMinimized}
                            isMinimizedVertical={isMinimizedVertical}
                            onClose={showMosaicView ? () => {
                              closeMosaicPanel(target);
                            } : undefined}
                            onFocus={() => { }}
                            onHeaderPointerDragStart={showMosaicView ? (event) => {
                              beginWorkbenchPointerDrag(event, {
                                sourcePanelId: panelId,
                                target,
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
                        return (
                          <WorkbenchThreadPanel
                            composerSpellCheck={resolvedSettings.composerSpellCheck}
                            fallbackThreadSummary={target.target.kind === "provider" || target.target.kind === "subagent" ? threadSummariesById.get(getWorkbenchThreadTargetRootId(target.target)) ?? null : null}
                            fontSizeRem={resolvedSettings.editorFontSize}
                            hasSidebarRestoreInset={hasSidebarRestoreInset}
                            isFocused={isFocused}
                            isMinimized={isMinimized}
                            isMinimizedVertical={isMinimizedVertical}
                            knownSubagents={explorer.subagents}
                            livePendingUserInputRequestsByThreadId={visibleUserInputRequestsByThreadId}
                            onDraftHarnessChange={handleHarnessChange}
                            onListModels={listThreadModels}
                            onOpenThread={openThreadFromExplorer}
                            onReadThread={readThread}
                            onCompactThread={compactThread}
                            onCreateDraftThread={() => controls?.createThreadDraft(harness) ?? null}
                            onSendMessage={sendThreadMessage}
                            onStopThread={stopThread}
                            onSubmitUserInputRequest={submitUserInputRequest}
                            onThreadComposerDraftChange={handleThreadComposerDraftChange}
                            onThreadComposerDraftClear={handleThreadComposerDraftClear}
                            onThreadQuestionnaireDraftChange={handleThreadQuestionnaireDraftChange}
                            onThreadQuestionnaireDraftClear={handleThreadQuestionnaireDraftClear}
                            onThreadAgentChange={setThreadAgent}
                            onThreadReasoningEffortChange={setThreadReasoningEffort}
                            onThreadServiceTierChange={setThreadServiceTier}
                            onThreadSettingsChange={setThreadComposerSettings}
                            onThreadModelChange={setThreadModel}
                            onUpdateThreadState={controls.updateThreadState}
                            selectedThreadId={getWorkbenchThreadTargetSelectedId(target.target)}
                            onSelectedThreadChange={(selectedThreadId) => {
                              if (!route.mosaicNode || target.target.kind === "new" || target.target.kind === "draft") return;
                              const rootThreadId = getWorkbenchThreadTargetRootId(target.target);
                              const nextTarget: WorkbenchMosaicPanelTarget = {
                                kind: "thread",
                                target: selectedThreadId === rootThreadId
                                  ? { harness: target.target.harness, kind: "provider", threadId: rootThreadId }
                                  : { harness: target.target.harness, kind: "subagent", parentThreadId: rootThreadId, threadId: selectedThreadId },
                              };
                              navigateToRoute(createMosaicRoute(route.projectId, replaceWorkbenchMosaicTarget(route.mosaicNode, target, nextTarget)));
                            }}
                            onThreadCodeBlockWrapChange={updateThreadCodeBlockWrapSetting}
                            projectId={activeProjectId}
                            projectFileCandidates={explorer.projectFileCandidates}
                            projectFileIndexId={explorer.projectFileIndexId}
                            projectFilePaths={explorer.projectFilePaths}
                            projectRootPath={explorer.rootPath}
                            projectRoots={explorer.roots}
                            rateLimits={rateLimits}
                            threadCodeBlockWrap={resolvedSettings.threadCodeBlockWrap}
                            threadComposerDraft={getThreadComposerDraftForTarget(target.target)}
                            threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                            threadDocuments={threadDocuments}
                            threadGoalControls={controls?.threadGoals ?? null}
                            threadSidebarStore={threadSidebarStore}
                            threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
                            onClose={showMosaicView ? () => {
                              closeMosaicPanel(target);
                            } : undefined}
                            onHeaderPointerDragStart={showMosaicView ? (event) => {
                              beginWorkbenchPointerDrag(event, {
                                sourcePanelId: panelId,
                                target,
                                type: "panel-target",
                              });
                            } : undefined}
                            onMinimizeToggle={showMosaicView ? togglePanelMinimized : undefined}
                            onPanelZoomDeltaChange={showMosaicView ? updatePanelZoomDelta : undefined}
                            panelZoomDelta={panelZoomDelta}
                            thread={target.target.kind === "provider" || target.target.kind === "subagent" ? getThreadDocumentFromSnapshot(threadDocuments, getWorkbenchThreadTargetRootId(target.target)) ?? mosaicDraftThreadsById[getWorkbenchThreadTargetRootId(target.target)] ?? (currentThread?.id === getWorkbenchThreadTargetRootId(target.target) ? currentThread : null) : null}
                            threadId={getWorkbenchThreadTargetRootId(target.target)}
                          />
                        );
                      }

                      return (
                        <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                          <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                            <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">Workbench</p>
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
                    fontSizeRem={resolvedSettings.editorFontSize}
                    isFocused
                    onFocus={() => { }}
                    path={effectiveFilePath}
                    spellCheck={resolvedSettings.editorSpellCheck}
                  />
                ) : null}
                {showFileView && selectionError ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                    <div className="shadow-float flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger/30 bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                      <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-danger uppercase">File</p>
                      <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open file</p>
                      <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{selectionError}</p>
                    </div>
                  </div>
                ) : null}
                {showFileView && !selectionError && !isFileViewReady ? (
                  <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                    <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                      <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">File</p>
                      <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Loading file...</p>
                      <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{effectiveFilePath}</p>
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
                  <p id="save-conflict-summary" ref={saveConflictSummaryRef} className="mt-3 text-sm leading-6 text-muted">
                    Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.
                  </p>
                  <p id="save-conflict-expected" ref={saveConflictExpectedRef} className="mt-3 text-[0.84rem] tracking-[0.02em] text-muted" />
                  <p id="save-conflict-actual" ref={saveConflictActualRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted" />
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
                <p id="reset-draft-summary" className="mt-3 text-sm leading-6 text-muted">
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
                  <p id="delete-file-summary" className="mt-3 text-sm leading-6 text-muted">
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
                  <p id="create-entry-summary" className="mt-3 text-sm leading-6 text-muted">
                    Enter a name for the new file or folder. New files are created as markdown files.
                  </p>
                  <label className="mt-4 block text-sm text-muted" htmlFor="create-entry-name">
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
                    className="mt-2 w-full rounded-xl bg-[color-mix(in_srgb,var(--bg)_86%,transparent)] px-3 py-2 text-base outline-none ring-0 transition focus:bg-[color-mix(in_srgb,var(--bg)_94%,transparent)]"
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
              className="pointer-events-auto min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
            >
              accept
            </button>
            <button
              id="revision-hover-reject"
              ref={revisionHoverRejectButtonRef}
              type="button"
              title="Reject revision"
              className="pointer-events-auto min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
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
  );
}
