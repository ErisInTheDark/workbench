"use client";

/*
 * Exports:
 * - default Workbench: client shell for project browsing, editing, and thread interaction. Keywords: workbench, project, editor, thread.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
  ExplorerSnapshot, FilePayload, OpenFileInEditorRequest, OrchestratorReloadRequest, OrchestratorReloadResponse, ThreadPayload, ThreadSummary, TreeNode,
  WorkbenchCollaborationThreadRegistry,
  WorkbenchControls,
  WorkbenchFileOpenTarget,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchProjectOption,
  WorkbenchQuestionnaireDraft,
  WorkbenchReadThreadOptions,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadComposerDraft,
  WorkbenchThreadSavedComposerDraft,
  WorkbenchUserInputResponse
} from "../lib/types";
import {
  claimWorkbenchCollaborationAutoWake,
  readWorkbenchCollaborationThreadRegistry,
  writeWorkbenchCollaborationThreadRegistry,
} from "../lib/workbench/collaboration/collaboration-registry-api";
import {
  EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY,
  mergeWorkbenchCollaborationThreadRegistry,
  normalizeWorkbenchCollaborationThreadRegistry,
} from "../lib/workbench/collaboration/collaboration-registry";
import { areDeeplyEqual } from "../lib/workbench/deep-equality";
import { useWorkbenchRoute } from "../lib/workbench/navigation/use-workbench-route";
import {
  createCollaborationHref,
  createCollaborationRoute,
  createFileRoute,
  createMosaicRoute,
  createProjectHref,
  createProjectRoute,
  createSettingsHref,
  createSettingsRoute,
  createThreadRoute,
  type WorkbenchRoute,
  type WorkbenchSettingsScope,
} from "../lib/workbench/navigation/workbench-route";
import {
  createWorkbenchMosaicSplit,
  createWorkbenchMosaicTarget,
  type WorkbenchMosaicNode,
  type WorkbenchMosaicPanelTarget,
} from "../lib/workbench/navigation/workbench-mosaic-route";
import ProjectTreeFileIndex from "../lib/workbench/project/ProjectTreeFileIndex";
import { isWorkbenchOpenableFile } from "../lib/workbench/project/tree-utils";
import type { WorkspaceFileLinkRoot } from "../lib/workbench/markdown/markdown-links";
import {
  createWorkbenchCollaborationScratchpadRelativePath,
  createWorkbenchCollaborationScratchpadWritableRoot,
} from "../lib/workbench/collaboration/collaboration-scratchpad-path";
import {
  persistHarness,
  readStoredHarness,
} from "../lib/workbench/state/browser-state";
import {
  EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES,
  areWorkbenchThreadSidebarPreferencesEqual,
  createWorkbenchThreadPreferenceKey,
  normalizeWorkbenchThreadSidebarPreferences,
  readStoredWorkbenchThreadSidebarPreferences,
  writeStoredWorkbenchThreadSidebarPreferences,
  type WorkbenchThreadSidebarPreferences,
} from "../lib/workbench/state/thread-sidebar-preferences";
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
import {
  deletePersistedThreadComposerDraft,
  deletePersistedThreadQuestionnaireDraft,
  deletePersistedThreadSavedComposerDraft,
  getPersistedThreadComposerDraftRecords,
  getPersistedThreadQuestionnaireDraftRecords,
  getPersistedThreadSavedComposerDraftRecords,
  putPersistedThreadComposerDraft,
  putPersistedThreadQuestionnaireDraft,
  putPersistedThreadSavedComposerDraft,
} from "../lib/workbench/thread/thread-composer-drafts";
import { writeTextToClipboard } from "../lib/workbench/dom/clipboard";
import type { WorkbenchDomSurfaces } from "../lib/workbench/workbench-dom";
import ThreadLoadingSkeleton from "./workbench/thread-view/ThreadLoadingSkeleton";
import ThreadView from "./workbench/thread-view/ThreadView";
import { formatThreadRelativeTimestamp, getThreadTitle } from "./workbench/thread-view/thread-view-primitives";
import useThreadActivityTimestamp from "./workbench/thread-view/use-thread-activity-timestamp";
import WorkbenchCollaborationView from "./workbench/collaboration/WorkbenchCollaborationView";
import WorkbenchContextMenuProvider, { type WorkbenchContextMenuDefinition } from "./workbench/WorkbenchContextMenuProvider";
import WorkbenchFilePanel from "./workbench/layout/WorkbenchFilePanel";
import WorkbenchMainLayoutView from "./workbench/layout/WorkbenchMainLayoutView";
import WorkbenchThreadPanel from "./workbench/layout/WorkbenchThreadPanel";
import WorkbenchMainLayout, {
  type WorkbenchDropPlacement,
  type WorkbenchMainLayout as WorkbenchMainLayoutState,
  type WorkbenchPanelTarget,
} from "../lib/workbench/layout/workbench-layout";
import type { WorkbenchDragPayload } from "../lib/workbench/layout/workbench-drag";
import {
  applyWorkbenchMosaicDrop,
  applyWorkbenchMosaicResize,
  closeWorkbenchMosaicTarget,
  createWorkbenchMainLayoutFromMosaic,
  moveWorkbenchMosaicTarget,
  replaceWorkbenchMosaicTarget,
  updateWorkbenchMosaicPanelOptions,
} from "../lib/workbench/layout/workbench-mosaic-layout";
import {
  readStoredWorkbenchSidebarSectionOrder,
  writeStoredWorkbenchSidebarSectionOrder,
  type WorkbenchSidebarSectionId,
} from "../lib/workbench/layout/workbench-layout-storage";
import {
  workbenchDiffGutterClassName,
  workbenchFloatingToolbarClassName,
  workbenchFloatingToolbarGroupClassName,
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchRevisionHoverToolbarClassName,
} from "./workbench/workbench-class-names";
import {
  dialogButtonClassName,
  WorkbenchDialog,
} from "./workbench/workbench-dialogs";
import {
  ExplorerTree,
  FileVisibilityIcon,
  NewEntryIcon,
  SidebarLoadingSkeleton,
  ThreadsList,
} from "./workbench/workbench-explorer";
import {
  ArchiveIcon,
  BackArrowIcon,
  BinIcon,
  CollaborationIcon,
  CopyIcon,
  GearIcon,
  PinIcon,
  ReloadIcon,
  SaveIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  ZoomInIcon,
  ZoomOutIcon
} from "./workbench/workbench-icons";
import WorkbenchAmbientCanvas, { type WorkbenchAmbientCanvasVariant } from "./workbench/WorkbenchAmbientCanvas";
import WorkbenchOptionCards, { WorkbenchOptionCard } from "./workbench/WorkbenchOptionCards";
import WorkbenchStepSlider from "./workbench/WorkbenchStepSlider";
import WorkbenchTabIcon, { type WorkbenchTabIconState } from "./workbench/WorkbenchTabIcon";

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

const MOBILE_SHELL_HEADER_HIDE_THRESHOLD_PX = 24;
const MOBILE_SHELL_HEADER_SHOW_THRESHOLD_PX = 8;
const MOSAIC_RATE_LIMIT_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_RELOAD_REQUEST: OrchestratorReloadRequest = {
  scopes: ["orchestrator-logic", "codex-bridge", "opencode-bridge", "next-dev"],
};
const SETTINGS_ORDER: WorkbenchSettingKey[] = [
  "theme",
  "collaborationScratchpadPath",
  "collaborationCollaboratorPrompt",
  "editorFontFamily",
  "editorSpellCheck",
  "composerSpellCheck",
  "fileOpenBehavior",
  "showUnopenableFiles",
  "threadCodeBlockWrap",
  "editorFontSize",
];
const COLLABORATION_THREAD_IDS_STORAGE_KEY = "workbench:collaboration:thread-registries";

function readStoredCollaborationThreadRegistries() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLABORATION_THREAD_IDS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([projectId, value]) => [projectId, normalizeWorkbenchCollaborationThreadRegistry(value)]));
  } catch {
    return {};
  }
}

function writeStoredCollaborationThreadRegistries(registriesByProjectId: Record<string, WorkbenchCollaborationThreadRegistry>) {
  try {
    window.localStorage.setItem(COLLABORATION_THREAD_IDS_STORAGE_KEY, JSON.stringify(registriesByProjectId));
  } catch {
    // Collaboration remains usable when localStorage is unavailable.
  }
}

function areCollaborationThreadRegistriesEqual(
  left: WorkbenchCollaborationThreadRegistry,
  right: WorkbenchCollaborationThreadRegistry,
) {
  return areDeeplyEqual(
    normalizeWorkbenchCollaborationThreadRegistry(left),
    normalizeWorkbenchCollaborationThreadRegistry(right),
  );
}

function hasCollaborationThreadRegistryData(registry: WorkbenchCollaborationThreadRegistry) {
  return !areCollaborationThreadRegistriesEqual(registry, EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY);
}

const EDITOR_FONT_CLASS_NAMES: Record<WorkbenchEditorFontFamily, string> = {
  mono: "font-mono",
  sans: "font-sans",
  serif: "font-serif",
};
const EDITOR_FONT_SIZE_OPTIONS = [0.9, 1, 1.08, 1.18, 1.32, 1.48].map((value, index) => ({
  label: String(index + 1),
  value,
}));

function createUniqueFileLinkRootId(id: string, usedIds: Set<string>) {
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

function createProjectFileLinkRoots(
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

function isReloadResponse (value: unknown): value is OrchestratorReloadResponse {
  return !!value
    && typeof value === "object"
    && "ok" in value
    && "state" in value;
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

function getFirstMosaicTarget(node: WorkbenchMosaicNode | null): WorkbenchMosaicPanelTarget | null {
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

function getRouteMosaicFallbackTarget(routeNode: WorkbenchMosaicNode | null, isMobile: boolean): WorkbenchMosaicPanelTarget | null {
  return isMobile ? getFirstMosaicTarget(routeNode) : null;
}

function mosaicContainsThreadTarget(node: WorkbenchMosaicNode | null, threadId: string): boolean {
  if (!node) {
    return false;
  }

  if (node.type === "target") {
    return node.target.kind === "thread" && node.target.threadId === threadId;
  }

  return node.children.some((child) => mosaicContainsThreadTarget(child, threadId));
}

function getPanelTargetMosaicNode(target: WorkbenchPanelTarget): WorkbenchMosaicNode | null {
  if (target.kind === "file" || target.kind === "thread") {
    return createWorkbenchMosaicTarget(target);
  }

  return null;
}

function createInitialMosaicNode(
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

interface ProjectGroup {
  label: string;
  projects: WorkbenchProjectOption[];
}

interface ProjectTimeGroup {
  folderGroups: ProjectGroup[];
  label: ProjectRecencyLabel;
}

interface GroupedProjects {
  libraryProjects: WorkbenchProjectOption[];
  timeGroups: ProjectTimeGroup[];
}

interface PendingWorkbenchPointerDrag {
  currentX: number;
  currentY: number;
  isDragging: boolean;
  payload: WorkbenchDragPayload;
  startX: number;
  startY: number;
}

const PROJECT_RECENCY_DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;
const PROJECT_RECENCY_BUCKETS = [
  { label: "last week", maxAgeMs: 7 * PROJECT_RECENCY_DAY_MS },
  { label: "last month", maxAgeMs: 31 * PROJECT_RECENCY_DAY_MS },
  { label: "last 3 months", maxAgeMs: 93 * PROJECT_RECENCY_DAY_MS },
  { label: "last 6 months", maxAgeMs: 186 * PROJECT_RECENCY_DAY_MS },
  { label: "last year", maxAgeMs: 366 * PROJECT_RECENCY_DAY_MS },
  { label: "ever", maxAgeMs: Number.POSITIVE_INFINITY },
] as const;

type ProjectRecencyLabel = typeof PROJECT_RECENCY_BUCKETS[number]["label"];

function getProjectDisplayPath (project: WorkbenchProjectOption) {
  const relativePath = project.relativePath || project.id || ".";
  if (project.kind === "workspace") {
    return `${relativePath} · ${project.roots.length} roots`;
  }

  return relativePath;
}

function getProjectGroupLabel (project: WorkbenchProjectOption) {
  const normalizedPath = (project.relativePath || project.id || ".").replace(/\\/g, "/").replace(/\/+$/u, "") || ".";
  if (normalizedPath === "." || !normalizedPath.includes("/")) {
    return ".";
  }

  return normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) || ".";
}

function getProjectTitle (project: WorkbenchProjectOption) {
  return project.kind === "workspace"
    ? project.roots.map((root) => `${root.id}: ${root.rootPath}`).join("\n")
    : project.rootPath;
}

function getProjectRecencyLabel (project: WorkbenchProjectOption, nowMs: number): ProjectRecencyLabel {
  if (project.lastCommitTimeMs === null) {
    return "ever";
  }

  const ageMs = Math.max(0, nowMs - project.lastCommitTimeMs);
  return PROJECT_RECENCY_BUCKETS.find((bucket) => ageMs <= bucket.maxAgeMs)?.label ?? "ever";
}

function getGroupedProjects (projects: WorkbenchProjectOption[]): GroupedProjects {
  const libraryProjects: WorkbenchProjectOption[] = [];
  const nowMs = Date.now();
  const timeGroupsByLabel = new Map<ProjectRecencyLabel, ProjectTimeGroup>();
  const folderGroupsByTimeLabel = new Map<ProjectRecencyLabel, Map<string, ProjectGroup>>();

  for (const project of projects) {
    if (project.kind === "workbench-library") {
      libraryProjects.push(project);
      continue;
    }

    const timeLabel = getProjectRecencyLabel(project, nowMs);
    let timeGroup = timeGroupsByLabel.get(timeLabel);
    if (!timeGroup) {
      timeGroup = { label: timeLabel, folderGroups: [] };
      timeGroupsByLabel.set(timeLabel, timeGroup);
    }

    let folderGroupsByLabel = folderGroupsByTimeLabel.get(timeLabel);
    if (!folderGroupsByLabel) {
      folderGroupsByLabel = new Map<string, ProjectGroup>();
      folderGroupsByTimeLabel.set(timeLabel, folderGroupsByLabel);
    }

    const folderLabel = getProjectGroupLabel(project);
    const existingFolderGroup = folderGroupsByLabel.get(folderLabel);
    if (existingFolderGroup) {
      existingFolderGroup.projects.push(project);
      continue;
    }

    const folderGroup = { label: folderLabel, projects: [project] };
    folderGroupsByLabel.set(folderLabel, folderGroup);
    timeGroup.folderGroups.push(folderGroup);
  }

  const timeGroups = PROJECT_RECENCY_BUCKETS
    .map((bucket) => timeGroupsByLabel.get(bucket.label))
    .filter((group): group is ProjectTimeGroup => Boolean(group));

  return { libraryProjects, timeGroups };
}

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

export default function Workbench () {
  const { navigateToRoute, route } = useWorkbenchRoute();
  const currentRouteRef = useRef<WorkbenchRoute>(route);
  currentRouteRef.current = route;
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [currentThread, setCurrentThread] = useState<ThreadPayload | null>(null);
  const [threadRelativeTimeNowMs, setThreadRelativeTimeNowMs] = useState(() => Date.now());
  const [harnessUserInputRequestsByThreadId, setHarnessUserInputRequestsByThreadId] = useState<Record<string, WorkbenchPendingUserInputRequest>>({});
  const [locallyResolvedUserInputRequestKeysByThreadId, setLocallyResolvedUserInputRequestKeysByThreadId] = useState<Record<string, string | undefined>>({});
  const [selectionError, setSelectionError] = useState("");
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshot | null>(null);
  const [controls, setControls] = useState<WorkbenchControls | null>(null);
  const [harness, setHarness] = useState<WorkbenchHarness>(() => {
    if (typeof window === "undefined") {
      return "codex";
    }

    return readStoredHarness();
  });
  const [isMobile, setIsMobile] = useState(false);
  const [mobileShellHeaderHeight, setMobileShellHeaderHeight] = useState(0);
  const [isMobileShellHeaderVisible, setIsMobileShellHeaderVisible] = useState(true);
  const [mobilePane, setMobilePane] = useState<MobilePane>("explorer");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"main" | "projects">("main");
  const [globalSettings, setGlobalSettings] = useState<WorkbenchGlobalSettings>(() => {
    if (typeof window === "undefined") {
      return readGlobalWorkbenchSettings();
    }

    return readGlobalWorkbenchSettings();
  });
  const [projectSettingsByProjectId, setProjectSettingsByProjectId] = useState<Record<string, WorkbenchProjectSettings>>({});
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");
  const [isReloadingRuntime, setIsReloadingRuntime] = useState(false);
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState(false);
  const [quickOpenUpdatedAtByPath, setQuickOpenUpdatedAtByPath] = useState<Record<string, string>>({});
  const [reloadError, setReloadError] = useState("");
  const [reloadMessage, setReloadMessage] = useState("");
  const [mainLayout, setMainLayout] = useState<WorkbenchMainLayoutState>(() => WorkbenchMainLayout.fromTarget({ kind: "empty" }));
  const [mosaicDraftThreadsById, setMosaicDraftThreadsById] = useState<Record<string, ThreadPayload | undefined>>({});
  const [sidebarSectionOrder, setSidebarSectionOrder] = useState<WorkbenchSidebarSectionId[]>(() => {
    if (typeof window === "undefined") {
      return ["project", "threads", "files"];
    }

    return readStoredWorkbenchSidebarSectionOrder();
  });
  const [sidebarDropTargetId, setSidebarDropTargetId] = useState<WorkbenchSidebarSectionId | "end" | null>(null);
  const [threadComposerDraftsByThreadId, setThreadComposerDraftsByThreadId] = useState<Record<string, WorkbenchThreadComposerDraft | undefined>>({});
  const [threadQuestionnaireDraftsByKey, setThreadQuestionnaireDraftsByKey] = useState<Record<string, WorkbenchQuestionnaireDraft | undefined>>({});
  const [threadSavedComposerDrafts, setThreadSavedComposerDrafts] = useState<WorkbenchThreadSavedComposerDraft[]>([]);
  const [threadSidebarPreferences, setThreadSidebarPreferences] = useState<WorkbenchThreadSidebarPreferences>(() => {
    if (typeof window === "undefined") {
      return EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES;
    }

    return readStoredWorkbenchThreadSidebarPreferences(route.projectId);
  });
  const [collaborationThreadRegistriesByProjectId, setCollaborationThreadRegistriesByProjectId] = useState<Record<string, WorkbenchCollaborationThreadRegistry>>(() => {
    if (typeof window === "undefined") {
      return {};
    }

    return readStoredCollaborationThreadRegistries();
  });
  const collaborationRegistryHydrationGenerationRef = useRef(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const mainPaneRef = useRef<HTMLElement>(null);
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
  const projectsPaneRef = useRef<HTMLDivElement>(null);
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
  const pendingWorkbenchDragRef = useRef<PendingWorkbenchPointerDrag | null>(null);
  const workbenchDragGhostRef = useRef<HTMLDivElement>(null);
  const suppressNextWorkbenchClickRef = useRef(false);
  const [activeWorkbenchDrag, setActiveWorkbenchDrag] = useState<{
    payload: WorkbenchDragPayload;
    x: number;
    y: number;
  } | null>(null);

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
          dom,
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
  }, []);

  useEffect(() => {
    if (!explorer.currentProjectId) {
      setThreadComposerDraftsByThreadId({});
      setThreadQuestionnaireDraftsByKey({});
      setThreadSavedComposerDrafts([]);
      return;
    }

    let cancelled = false;
    void Promise.all([
      getPersistedThreadComposerDraftRecords(explorer.currentProjectId),
      getPersistedThreadQuestionnaireDraftRecords(explorer.currentProjectId),
      getPersistedThreadSavedComposerDraftRecords(explorer.currentProjectId),
    ]).then(([composerRecords, questionnaireRecords, savedComposerRecords]) => {
      if (cancelled) {
        return;
      }

      setThreadComposerDraftsByThreadId(Object.fromEntries(
        composerRecords.map((record) => [record.threadId, {
          attachments: record.attachments,
          text: record.text,
          updatedAt: record.updatedAt,
        }]),
      ));
      setThreadQuestionnaireDraftsByKey(Object.fromEntries(
        questionnaireRecords.map((record) => [`${record.threadId}:${record.requestKey}`, {
          customValues: record.customValues,
          selectedValues: record.selectedValues,
          updatedAt: record.updatedAt,
        }]),
      ));
      setThreadSavedComposerDrafts(savedComposerRecords.map((record) => ({
        attachments: record.attachments,
        createdAt: record.createdAt,
        id: record.id,
        text: record.text,
        updatedAt: record.updatedAt,
      })));
    });

    return () => {
      cancelled = true;
    };
  }, [explorer.currentProjectId]);

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

  useEffect(() => {
    if (!isMobile || !isDesktopSidebarCollapsed) {
      return;
    }

    setIsDesktopSidebarCollapsed(false);
  }, [isDesktopSidebarCollapsed, isMobile]);

  const routeMosaicNodeForControls = isMobile && route.view === "mosaic" ? route.mosaicNode : null;
  const routeToApplyToControls = useMemo(() => {
    if (route.view === "mosaic") {
      const mobileMosaicTarget = getRouteMosaicFallbackTarget(routeMosaicNodeForControls, isMobile);
      if (mobileMosaicTarget?.kind === "file") {
        return createFileRoute(route.projectId, mobileMosaicTarget.filePath);
      }
      if (mobileMosaicTarget?.kind === "thread") {
        return createThreadRoute(route.projectId, mobileMosaicTarget.threadId);
      }

      return createProjectRoute(route.projectId);
    }

    if (route.view === "file") {
      return createFileRoute(route.projectId, route.filePath);
    }
    if (route.view === "thread") {
      return createThreadRoute(route.projectId, route.threadId);
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
  const collaborationThreadRegistry = collaborationThreadRegistriesByProjectId[activeProjectId] ?? EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
  const collaborationThreadIdSet = useMemo(() => new Set(collaborationThreadRegistry.threadIds), [collaborationThreadRegistry.threadIds]);
  const archivedSidebarThreadKeySet = useMemo(() => new Set(threadSidebarPreferences.archivedThreadKeys), [threadSidebarPreferences.archivedThreadKeys]);
  const pinnedSidebarThreadKeySet = useMemo(() => new Set(threadSidebarPreferences.pinnedThreadKeys), [threadSidebarPreferences.pinnedThreadKeys]);
  const collaborationThreadSummaries = useMemo(() => explorer.threads.filter((thread) => collaborationThreadIdSet.has(thread.id)), [collaborationThreadIdSet, explorer.threads]);
  const collaborationStartedSuggestionThreadIdSet = useMemo(() => (
    new Set(Object.values(collaborationThreadRegistry.startedSuggestionThreads).map((startedThread) => startedThread.threadId))
  ), [collaborationThreadRegistry.startedSuggestionThreads]);
  const collaborationStartedSuggestionThreadSummaries = useMemo(() => (
    collaborationStartedSuggestionThreadIdSet.size
      ? explorer.threads.filter((thread) => collaborationStartedSuggestionThreadIdSet.has(thread.id))
      : []
  ), [collaborationStartedSuggestionThreadIdSet, explorer.threads]);
  const visibleSidebarThreads = useMemo(() => (
    explorer.threads.filter((thread) => (
      !collaborationThreadIdSet.has(thread.id)
      && !archivedSidebarThreadKeySet.has(createWorkbenchThreadPreferenceKey(thread))
    ))
  ), [archivedSidebarThreadKeySet, collaborationThreadIdSet, explorer.threads]);
  const threadSummariesById = useMemo(() => new Map<string, ThreadSummary>(explorer.threads.map((thread) => [thread.id, thread])), [explorer.threads]);
  const pinnedSidebarThreads = useMemo(() => (
    visibleSidebarThreads.filter((thread) => pinnedSidebarThreadKeySet.has(createWorkbenchThreadPreferenceKey(thread)))
  ), [pinnedSidebarThreadKeySet, visibleSidebarThreads]);
  const regularSidebarThreads = useMemo(() => (
    visibleSidebarThreads.filter((thread) => !pinnedSidebarThreadKeySet.has(createWorkbenchThreadPreferenceKey(thread)))
  ), [pinnedSidebarThreadKeySet, visibleSidebarThreads]);
  useEffect(() => {
    setThreadSidebarPreferences(activeProjectId ? readStoredWorkbenchThreadSidebarPreferences(activeProjectId) : EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES);
  }, [activeProjectId]);
  useEffect(() => {
    if (!activeProjectId) {
      return;
    }

    const generation = collaborationRegistryHydrationGenerationRef.current + 1;
    collaborationRegistryHydrationGenerationRef.current = generation;
    let cancelled = false;

    void readWorkbenchCollaborationThreadRegistry(activeProjectId)
      .then(async (diskRegistry) => {
        if (cancelled || collaborationRegistryHydrationGenerationRef.current !== generation) {
          return;
        }

        const localRegistry = collaborationThreadRegistriesByProjectId[activeProjectId] ?? EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
        const mergedRegistry = hasCollaborationThreadRegistryData(localRegistry)
          ? {
            ...mergeWorkbenchCollaborationThreadRegistry(diskRegistry, localRegistry),
            autoWakeEnabled: diskRegistry.autoWakeEnabled || localRegistry.autoWakeEnabled,
          }
          : diskRegistry;
        setCollaborationThreadRegistriesByProjectId((current) => {
          const existing = current[activeProjectId] ?? EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
          if (areCollaborationThreadRegistriesEqual(existing, mergedRegistry)) {
            return current;
          }

          const next = {
            ...current,
            [activeProjectId]: mergedRegistry,
          };
          writeStoredCollaborationThreadRegistries(next);
          return next;
        });

        if (!areCollaborationThreadRegistriesEqual(diskRegistry, mergedRegistry)) {
          const savedRegistry = await writeWorkbenchCollaborationThreadRegistry(activeProjectId, mergedRegistry);
          if (cancelled || collaborationRegistryHydrationGenerationRef.current !== generation) {
            return;
          }

          setCollaborationThreadRegistriesByProjectId((current) => {
            const existing = current[activeProjectId] ?? EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
            if (areCollaborationThreadRegistriesEqual(existing, savedRegistry)) {
              return current;
            }

            const next = {
              ...current,
              [activeProjectId]: savedRegistry,
            };
            writeStoredCollaborationThreadRegistries(next);
            return next;
          });
        }
      })
      .catch(() => {
        // Browser-local Collaboration state remains usable when disk sync is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);
  const projectFileLinkRoots = useMemo(
    () => createProjectFileLinkRoots(explorer.projects, activeProjectId, explorer.roots),
    [activeProjectId, explorer.projects, explorer.roots],
  );
  const isSidebarProjectLoading = explorer.isProjectLoading || (Boolean(route.projectId) && route.projectId !== explorer.currentProjectId);
  const isSidebarThreadsLoading = explorer.isThreadsLoading || isSidebarProjectLoading;
  const currentProjectDisplayName = currentProject
    ? `${currentProject.name || currentProject.id}${currentProject.kind === "workspace" ? " workspace" : ""}`
    : null;
  const currentProjectTitle = currentProject?.kind === "workspace"
    ? currentProject.roots.map((root) => `${root.id}: ${root.rootPath}`).join("\n")
    : currentProject?.rootPath ?? explorer.rootPath;
  const pageTitle = formatWorkbenchPageTitle(currentProjectDisplayName ?? explorer.root ?? explorer.currentProjectId);
  const projectSettings = explorer.currentProjectId
    ? projectSettingsByProjectId[explorer.currentProjectId] ?? createDefaultProjectWorkbenchSettings()
    : createDefaultProjectWorkbenchSettings();
  const resolvedSettings = resolveWorkbenchSettings(globalSettings, projectSettings);
  const collaborationScratchpadPath = resolvedSettings.collaborationScratchpadPath.trim()
    || createWorkbenchCollaborationScratchpadRelativePath(activeProjectId);
  const collaborationScratchpadWritableRoot = resolvedSettings.collaborationScratchpadPath.trim()
    ? ""
    : createWorkbenchCollaborationScratchpadWritableRoot(explorer.workbenchStorageRootPath, activeProjectId);
  const showUnopenableFiles = resolvedSettings.showUnopenableFiles;
  const visibleTree = useMemo(
    () => {
      if (isSidebarProjectLoading) {
        return [];
      }

      return showUnopenableFiles ? explorer.tree : filterVisibleTreeNodes(explorer.tree);
    },
    [explorer.tree, isSidebarProjectLoading, showUnopenableFiles],
  );
  const groupedProjects = useMemo(() => getGroupedProjects(explorer.projects), [explorer.projects]);
  const projectTabLabel = getProjectTabLabel(currentProjectDisplayName ?? explorer.root);
  const settingsScope = route.view === "settings" ? route.settingsScope : "global";
  const editorFontClassName = EDITOR_FONT_CLASS_NAMES[resolvedSettings.editorFontFamily];

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    if (!explorer.currentProjectId || projectSettingsByProjectId[explorer.currentProjectId]) {
      return;
    }

    setProjectSettingsByProjectId((current) => ({
      ...current,
      [explorer.currentProjectId]: readProjectWorkbenchSettings(explorer.currentProjectId),
    }));
  }, [explorer.currentProjectId, projectSettingsByProjectId]);

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

  const openProjectPicker = useCallback(() => {
    setSidebarMode("projects");
  }, []);

  const closeProjectPicker = useCallback(() => {
    setSidebarMode("main");
  }, []);

  const handleProjectsPaneKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    closeProjectPicker();
  }, [closeProjectPicker]);

  const updateGlobalSetting = useCallback(<K extends WorkbenchSettingKey> (key: K, value: WorkbenchGlobalSettings[K]) => {
    setGlobalSettings((current) => {
      const nextSettings = {
        ...current,
        [key]: key === "editorFontSize" && typeof value === "number" ? clampEditorFontSize(value) : value,
      };
      writeGlobalWorkbenchSettings(nextSettings);
      return nextSettings;
    });
  }, []);

  const updateProjectSetting = useCallback(<K extends WorkbenchSettingKey> (key: K, value: WorkbenchGlobalSettings[K]) => {
    const projectId = explorer.currentProjectId;
    if (!projectId) {
      return;
    }

    setProjectSettingsByProjectId((current) => {
      const currentSettings = current[projectId] ?? readProjectWorkbenchSettings(projectId);
      const nextSettings = {
        ...currentSettings,
        [key]: {
          ...currentSettings[key],
          enabled: true,
          value: key === "editorFontSize" && typeof value === "number" ? clampEditorFontSize(value) : value,
        },
      } satisfies WorkbenchProjectSettings;
      writeProjectWorkbenchSettings(projectId, nextSettings);
      return {
        ...current,
        [projectId]: nextSettings,
      };
    });
  }, [explorer.currentProjectId]);

  const resetProjectSettingOverride = useCallback((key: WorkbenchSettingKey) => {
    const projectId = explorer.currentProjectId;
    if (!projectId) {
      return;
    }

    setProjectSettingsByProjectId((current) => {
      const currentSettings = current[projectId] ?? readProjectWorkbenchSettings(projectId);
      const nextSettings = {
        ...currentSettings,
        [key]: {
          ...currentSettings[key],
          enabled: false,
        },
      } satisfies WorkbenchProjectSettings;
      writeProjectWorkbenchSettings(projectId, nextSettings);
      return {
        ...current,
        [projectId]: nextSettings,
      };
    });
  }, [explorer.currentProjectId]);

  const updateThreadCodeBlockWrapSetting = useCallback((nextValue: boolean) => {
    if (explorer.currentProjectId) {
      updateProjectSetting("threadCodeBlockWrap", nextValue);
      return;
    }

    updateGlobalSetting("threadCodeBlockWrap", nextValue);
  }, [explorer.currentProjectId, updateGlobalSetting, updateProjectSetting]);

  useEffect(() => {
    if (sidebarMode !== "projects") {
      return;
    }

    projectsPaneRef.current?.focus();
  }, [sidebarMode]);

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
    setSidebarMode("main");
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
      closeProjectPicker();
      return;
    }

    setCurrentThread(null);
    navigateToRoute(createProjectRoute(projectId));
    setSidebarMode("main");
  }, [closeProjectPicker, explorer.currentProjectId, navigateToRoute]);

  const renderProjectLink = useCallback((project: WorkbenchProjectOption) => {
    const isCurrentProject = project.id === activeProjectId;
    const projectSubtitle = getProjectDisplayPath(project);
    return (
      <a
        key={project.id}
        href={createProjectHref(project.id)}
        title={getProjectTitle(project)}
        className={`relative block min-w-0 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1${isCurrentProject ? " text-accent after:absolute after:bottom-1 after:right-0 after:top-1 after:w-[2px] after:bg-accent" : " text-foreground/85"}`}
        onClick={(event) => {
          void selectProjectFromLink(event, project.id);
        }}
      >
        <span className={`block truncate text-[0.94rem] leading-tight${isCurrentProject ? " font-semibold" : ""}`}>
          {project.name || project.id}{project.kind === "workspace" ? " workspace" : ""}
        </span>
        <span className="mt-1 block truncate font-mono text-[0.74rem] leading-tight text-current opacity-70">{projectSubtitle}</span>
      </a>
    );
  }, [activeProjectId, selectProjectFromLink]);

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

  const openThreadFromExplorer = useCallback(async (threadId: string) => {
    if (route.view === "thread" && threadId === route.threadId) {
      return true;
    }

    navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, threadId));
    return true;
  }, [explorer.currentProjectId, navigateToRoute, route]);
  const updateThreadSidebarPreferences = useCallback((updater: (current: WorkbenchThreadSidebarPreferences) => WorkbenchThreadSidebarPreferences) => {
    const projectId = activeProjectId;
    if (!projectId) {
      return;
    }

    setThreadSidebarPreferences((current) => {
      const nextPreferences = normalizeWorkbenchThreadSidebarPreferences(updater(current));
      if (areWorkbenchThreadSidebarPreferencesEqual(current, nextPreferences)) {
        return current;
      }

      writeStoredWorkbenchThreadSidebarPreferences(projectId, nextPreferences);
      return nextPreferences;
    });
  }, [activeProjectId]);
  const getThreadContextMenu = useCallback((thread: ThreadSummary): WorkbenchContextMenuDefinition => {
    const threadKey = createWorkbenchThreadPreferenceKey(thread);
    const label = thread.name || thread.preview || thread.id;
    const isPinned = pinnedSidebarThreadKeySet.has(threadKey);

    return {
      id: `thread:${threadKey}`,
      items: [
        {
          icon: <CopyIcon className="size-4" />,
          id: "copy-id",
          label: "Copy ID",
          onSelect: () => {
            void writeTextToClipboard(thread.id);
          },
        },
        {
          icon: <PinIcon className="size-4" />,
          id: isPinned ? "unpin" : "pin",
          label: isPinned ? "Unpin thread" : "Pin thread",
          onSelect: () => {
            updateThreadSidebarPreferences((current) => ({
              ...current,
              pinnedThreadKeys: isPinned
                ? current.pinnedThreadKeys.filter((pinnedThreadKey) => pinnedThreadKey !== threadKey)
                : [...current.pinnedThreadKeys.filter((pinnedThreadKey) => pinnedThreadKey !== threadKey), threadKey],
            }));
          },
        },
        {
          icon: <ArchiveIcon className="size-4" />,
          id: "archive",
          label: "Archive thread",
          onSelect: () => {
            updateThreadSidebarPreferences((current) => ({
              archivedThreadKeys: [...current.archivedThreadKeys.filter((archivedThreadKey) => archivedThreadKey !== threadKey), threadKey],
              pinnedThreadKeys: current.pinnedThreadKeys.filter((pinnedThreadKey) => pinnedThreadKey !== threadKey),
            }));
          },
          tone: "danger",
        },
      ],
      label: `Thread actions for ${label}`,
    };
  }, [pinnedSidebarThreadKeySet, updateThreadSidebarPreferences]);
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

  const markThreadSeen = useCallback((thread: ThreadPayload) => {
    controls?.markThreadSeen(thread);
  }, [controls]);

  const sendThreadMessage = useCallback(async (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => {
    if (!controls) {
      return null;
    }

    const replaceMosaicDraftThread = (materializedThread: ThreadPayload) => {
      setMosaicDraftThreadsById((current) => {
        const { [thread.id]: _removedDraft, new: _removedNewDraft, ...rest } = current;
        void _removedDraft;
        void _removedNewDraft;
        return rest;
      });

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
            { kind: "thread", threadId: thread.id },
            { kind: "thread", threadId: materializedThread.id },
          ),
        ), { replace: true });
        return true;
      }

      return false;
    };

    const replaceCurrentDraftThreadRoute = (materializedThread: ThreadPayload) => {
      if (materializedThread.id === thread.id) {
        return false;
      }

      if (replaceMosaicDraftThread(materializedThread)) {
        return true;
      }

      const currentRoute = currentRouteRef.current;
      if (currentRoute.view !== "thread" || currentRoute.threadId !== thread.id) {
        return false;
      }

      navigateToRoute(createThreadRoute(currentRoute.projectId, materializedThread.id), { replace: true });
      return true;
    };

    const materializedOptions: WorkbenchSendThreadMessageOptions | undefined = thread.isDraft
      ? {
        ...options,
        onThreadMaterialized: (materializedThread) => {
          options?.onThreadMaterialized?.(materializedThread);
          replaceCurrentDraftThreadRoute(materializedThread);
        },
      }
      : options;
    const payload = await controls.sendThreadMessage(thread, input, materializedOptions);
    if (payload) {
      if (thread.isDraft) {
        replaceCurrentDraftThreadRoute(payload);
      }

      const draftThreadIdsToClear = Array.from(new Set([
        thread.id,
        payload.id,
        ...(thread.isDraft ? ["new"] : []),
      ]));

      setThreadComposerDraftsByThreadId((current) => {
        if (!draftThreadIdsToClear.some((threadId) => current[threadId])) {
          return current;
        }

        const next = { ...current };
        for (const threadId of draftThreadIdsToClear) {
          delete next[threadId];
        }
        return next;
      });
      for (const threadId of draftThreadIdsToClear) {
        void deletePersistedThreadComposerDraft(explorer.currentProjectId, threadId);
      }
    }

    return payload;
  }, [controls, navigateToRoute]);

  const handleThreadComposerDraftChange = useCallback((threadId: string, draft: WorkbenchThreadComposerDraft) => {
    if (!explorer.currentProjectId) {
      return;
    }

    setThreadComposerDraftsByThreadId((current) => ({
      ...current,
      [threadId]: draft,
    }));
    void putPersistedThreadComposerDraft(explorer.currentProjectId, threadId, draft);
  }, [explorer.currentProjectId]);

  const handleThreadComposerDraftClear = useCallback((threadId: string) => {
    setThreadComposerDraftsByThreadId((current) => {
      if (!current[threadId]) {
        return current;
      }

      const next = { ...current };
      delete next[threadId];
      return next;
    });

    if (explorer.currentProjectId) {
      void deletePersistedThreadComposerDraft(explorer.currentProjectId, threadId);
    }
  }, [explorer.currentProjectId]);

  const handleThreadSavedComposerDraftSave = useCallback((draft: WorkbenchThreadSavedComposerDraft) => {
    if (!explorer.currentProjectId) {
      return;
    }

    setThreadSavedComposerDrafts((current) => [
      draft,
      ...current.filter((candidate) => candidate.id !== draft.id),
    ]);
    void putPersistedThreadSavedComposerDraft(explorer.currentProjectId, draft);
  }, [explorer.currentProjectId]);

  const handleThreadSavedComposerDraftDelete = useCallback((draftId: string) => {
    setThreadSavedComposerDrafts((current) => current.filter((draft) => draft.id !== draftId));

    if (explorer.currentProjectId) {
      void deletePersistedThreadSavedComposerDraft(explorer.currentProjectId, draftId);
    }
  }, [explorer.currentProjectId]);

  const handleThreadQuestionnaireDraftChange = useCallback((threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => {
    if (!explorer.currentProjectId || !requestKey) {
      return;
    }

    setThreadQuestionnaireDraftsByKey((current) => ({
      ...current,
      [`${threadId}:${requestKey}`]: draft,
    }));
    void putPersistedThreadQuestionnaireDraft(explorer.currentProjectId, threadId, requestKey, draft);
  }, [explorer.currentProjectId]);

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

    if (explorer.currentProjectId) {
      void deletePersistedThreadQuestionnaireDraft(explorer.currentProjectId, threadId, requestKey);
    }
  }, [explorer.currentProjectId]);

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

  const listThreadModels = useCallback(async (nextHarness: WorkbenchHarness) => {
    if (!controls) {
      return [];
    }

    return await controls.listModels(nextHarness);
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

  const reloadLocalRuntime = useCallback(async () => {
    setReloadError("");
    setReloadMessage("Requesting orchestrator logic reload, Codex bridge restart, and Next.js dev restart...");
    setIsReloadingRuntime(true);

    try {
      const response = await fetch("/api/orchestrator/reload", {
        body: JSON.stringify(DEFAULT_RELOAD_REQUEST),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await response.json() as OrchestratorReloadResponse | { error?: string };
      if (!response.ok || !isReloadResponse(payload) || !payload.ok) {
        throw new Error(
          "error" in payload && typeof payload.error === "string"
            ? payload.error
            : "Unable to reload the local runtime.",
        );
      }

      let settledPayload: OrchestratorReloadResponse | null = payload;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (settledPayload.state !== "running") {
          break;
        }

        await new Promise((resolve) => {
          window.setTimeout(resolve, 250);
        });
        const statusResponse = await fetch("/api/orchestrator/reload", { cache: "no-store" });
        const statusPayload = await statusResponse.json() as OrchestratorReloadResponse | { error?: string };
        if (!statusResponse.ok || !isReloadResponse(statusPayload) || !statusPayload.ok) {
          settledPayload = null;
          break;
        }
        settledPayload = statusPayload;
      }

      if (settledPayload?.state === "failed") {
        throw new Error(settledPayload.error ?? "The orchestrator reported that reload failed.");
      }

      const finalPayload = settledPayload ?? payload;
      const appliedLabel = finalPayload.appliedScopes.length ? finalPayload.appliedScopes.join(", ") : "no immediate scopes";
      const queuedLabel = finalPayload.queuedScopes.length ? finalPayload.queuedScopes.join(", ") : "nothing queued";
      setReloadMessage(`Reload ${finalPayload.state === "succeeded" ? "completed" : "requested"}. Applied: ${appliedLabel}. Queued: ${queuedLabel}.`);
    } catch (error) {
      setReloadMessage("");
      setReloadError(error instanceof Error ? error.message : "Unable to reload the local runtime.");
    } finally {
      setIsReloadingRuntime(false);
    }
  }, []);

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
  const showCollaborationView = route.view === "collaboration";
  const showFullBleedMainView = showMosaicView || showCollaborationView;
  const usesDesktopSidebarCollapse = !isMobile;
  const isEffectiveDesktopSidebarCollapsed = usesDesktopSidebarCollapse && isDesktopSidebarCollapsed;
  const effectiveThreadId = mobileMosaicFallbackTarget?.kind === "thread" ? mobileMosaicFallbackTarget.threadId : route.threadId;
  const effectiveFilePath = mobileMosaicFallbackTarget?.kind === "file" ? mobileMosaicFallbackTarget.filePath : route.filePath;
  const showEmptyState = !showThreadView && !showFileView && !showSettingsView && !showCollaborationView && !showMosaicView;
  const showRouteError = Boolean(selectionError) && !showThreadView && !showFileView && !showSettingsView && !showCollaborationView && !showMosaicView;
  if (currentThread) {
    retainedThreadRef.current = currentThread;
  }
  const retainedThread = retainedThreadRef.current;
  const threadForThreadView = showThreadView && currentThread?.id === effectiveThreadId
    ? currentThread
    : showThreadView && retainedThread?.id === effectiveThreadId
      ? retainedThread
      : null;
  const threadSummaryForThreadView = showThreadView ? threadSummariesById.get(effectiveThreadId) ?? null : null;
  const threadShellSource = threadForThreadView ?? threadSummaryForThreadView;
  const threadShellActivityTimestampMs = useThreadActivityTimestamp(threadShellSource, threadSummaryForThreadView);
  const isThreadShellTitleLoading = showThreadView && !threadShellSource;
  const threadShellTitle = threadShellSource ? getThreadTitle(threadShellSource) : "";
  const threadShellStatusLabel = threadShellActivityTimestampMs
    ? formatThreadRelativeTimestamp(threadShellActivityTimestampMs / 1000, threadRelativeTimeNowMs)
    : "";
  const isThreadViewReady = showThreadView && Boolean(threadForThreadView);
  const isFileViewReady = showFileView && !currentThread && explorer.currentPath === effectiveFilePath;
  const isSelectionPending = !selectionError && ((showThreadView && !isThreadViewReady) || (showFileView && !isFileViewReady));
  const activeThreadId = showThreadView ? effectiveThreadId : "";
  const activeFilePath = showFileView ? effectiveFilePath : "";
  const sidebarTrackTransform = sidebarMode === "projects" ? "translateX(0)" : "translateX(-50%)";
  const visibleUserInputRequestsByThreadId = useMemo(() => (
    filterVisibleUserInputRequestsByThreadId(
      harnessUserInputRequestsByThreadId,
      locallyResolvedUserInputRequestKeysByThreadId,
    )
  ), [harnessUserInputRequestsByThreadId, locallyResolvedUserInputRequestKeysByThreadId]);
  const pendingQuestionnaireThreadIds = useMemo(
    () => new Set(Object.keys(visibleUserInputRequestsByThreadId)),
    [visibleUserInputRequestsByThreadId],
  );
  const hasPendingQuestionnaire = Boolean(currentThread
    && pendingQuestionnaireThreadIds.has(currentThread.id)
    && isThreadStatusWaitingOnUserInput(currentThread.status))
    || visibleSidebarThreads.some((thread) => (
      pendingQuestionnaireThreadIds.has(thread.id)
      && isThreadStatusWaitingOnUserInput(thread.status)
    ));
  const hasActiveThread = Boolean(currentThread && isThreadStatusActive(currentThread.status))
    || visibleSidebarThreads.some((thread) => Boolean(thread.unreadBadge?.hasActiveTurn));
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
      : showCollaborationView
        ? "collaboration"
      : "";
  useEffect(() => {
    if (!showThreadView || !threadShellSource) {
      return;
    }

    setThreadRelativeTimeNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setThreadRelativeTimeNowMs(Date.now());
    }, THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [showThreadView, threadShellActivityTimestampMs, threadShellSource?.id]);
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
      return { kind: "thread", threadId: effectiveThreadId };
    }
    if (showSettingsView) {
      return { kind: "settings", scope: settingsScope };
    }

    return { kind: "empty" };
  }, [effectiveFilePath, effectiveThreadId, settingsScope, showFileView, showSettingsView, showThreadView]);
  const temporaryDropLayout = useMemo(() => (
    !isMobile && !showMosaicView && activeWorkbenchDrag?.payload.type === "panel-target"
      ? WorkbenchMainLayout.fromTarget(routePanelTarget)
      : null
  ), [activeWorkbenchDrag?.payload.type, isMobile, routePanelTarget, showMosaicView]);
  const mainLayoutForRender = routeMosaicProjection?.layout ?? temporaryDropLayout;
  const shouldRenderMainLayout = Boolean(mainLayoutForRender);

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
      navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, target.threadId), options);
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

  const handleMainLayoutPanelDrop = useCallback((drop: { panelId: string; placement: WorkbenchDropPlacement }, payload: Extract<WorkbenchDragPayload, { readonly type: "new-thread" | "panel-target" }>) => {
    if (payload.type === "new-thread" && !controls) {
      return;
    }

    let target: WorkbenchPanelTarget = payload.type === "panel-target" ? payload.target : { kind: "empty" };
    if (payload.type === "new-thread") {
      const draftThread = controls!.createThreadDraft(payload.harness);
      setMosaicDraftThreadsById((current) => ({
        ...current,
        [draftThread.id]: draftThread,
      }));
      target = { kind: "thread", threadId: draftThread.id };
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

  const sidebarSectionOrderIndex = useMemo(() => (
    Object.fromEntries(sidebarSectionOrder.map((sectionId, index) => [sectionId, index])) as Record<WorkbenchSidebarSectionId, number>
  ), [sidebarSectionOrder]);

  const moveSidebarSection = useCallback((sourceId: WorkbenchSidebarSectionId, targetId: WorkbenchSidebarSectionId) => {
    setSidebarSectionOrder((current) => {
      if (sourceId === targetId) {
        return current;
      }

      const withoutSource = current.filter((sectionId) => sectionId !== sourceId);
      const targetIndex = withoutSource.indexOf(targetId);
      const nextOrder = targetIndex < 0
        ? [...withoutSource, sourceId]
        : [
          ...withoutSource.slice(0, targetIndex),
          sourceId,
          ...withoutSource.slice(targetIndex),
        ];
      writeStoredWorkbenchSidebarSectionOrder(nextOrder);
      return nextOrder;
    });
  }, []);

  const moveSidebarSectionToEnd = useCallback((sourceId: WorkbenchSidebarSectionId) => {
    setSidebarSectionOrder((current) => {
      const withoutSource = current.filter((sectionId) => sectionId !== sourceId);
      const nextOrder = [...withoutSource, sourceId];
      writeStoredWorkbenchSidebarSectionOrder(nextOrder);
      return nextOrder;
    });
  }, []);

  const getSidebarSectionDragProps = useCallback((sectionId: WorkbenchSidebarSectionId) => ({
    style: { order: sidebarSectionOrderIndex[sectionId] ?? 0 },
  }), [sidebarSectionOrderIndex]);

  const endWorkbenchPointerDrag = useCallback(() => {
    pendingWorkbenchDragRef.current = null;
    setActiveWorkbenchDrag(null);
    setSidebarDropTargetId(null);
  }, []);

  const beginWorkbenchPointerDrag = useCallback((event: ReactPointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => {
    if (isMobile || event.button !== 0) {
      return;
    }
    if (
      payload.type === "sidebar-section"
      && event.target instanceof HTMLElement
      && event.target !== event.currentTarget
      && event.target.closest("button,a,input,textarea,select,[contenteditable='true']")
    ) {
      return;
    }

    pendingWorkbenchDragRef.current = {
      currentX: event.clientX,
      currentY: event.clientY,
      isDragging: false,
      payload,
      startX: event.clientX,
      startY: event.clientY,
    };

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const pendingDrag = pendingWorkbenchDragRef.current;
      if (!pendingDrag) {
        return;
      }

      pendingDrag.currentX = pointerEvent.clientX;
      pendingDrag.currentY = pointerEvent.clientY;
      if (workbenchDragGhostRef.current) {
        workbenchDragGhostRef.current.style.transform = `translate3d(${pointerEvent.clientX + 12}px, ${pointerEvent.clientY + 12}px, 0)`;
      }
      const distance = Math.hypot(
        pointerEvent.clientX - pendingDrag.startX,
        pointerEvent.clientY - pendingDrag.startY,
      );
      if (!pendingDrag.isDragging && distance < 5) {
        return;
      }

      const didStartDragging = !pendingDrag.isDragging;
      pendingDrag.isDragging = true;
      suppressNextWorkbenchClickRef.current = true;
      pointerEvent.preventDefault();
      if (didStartDragging) {
        setActiveWorkbenchDrag({
          payload: pendingDrag.payload,
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        });
      }
    };

    const handlePointerUp = (pointerEvent: PointerEvent) => {
      if (pendingWorkbenchDragRef.current?.isDragging) {
        pointerEvent.preventDefault();
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.setTimeout(() => {
        endWorkbenchPointerDrag();
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  }, [endWorkbenchPointerDrag, isMobile]);

  const handleWorkbenchClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!suppressNextWorkbenchClickRef.current) {
      return;
    }

    suppressNextWorkbenchClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!activeWorkbenchDrag || typeof document === "undefined") {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    const previousOverflow = document.body.style.overflow;
    const previousOverscrollBehavior = document.body.style.overscrollBehavior;
    const previousTouchAction = document.body.style.touchAction;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.touchAction = "none";

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscrollBehavior;
      document.body.style.touchAction = previousTouchAction;
    };
  }, [activeWorkbenchDrag]);

  const getWorkbenchDragGhostLabel = useCallback((payload: WorkbenchDragPayload) => {
    if (payload.type === "sidebar-section") {
      return payload.sectionId;
    }
    if (payload.type === "new-thread") {
      return "New thread";
    }
    if (payload.target.kind === "file") {
      return payload.target.filePath;
    }
    if (payload.target.kind === "thread") {
      return payload.target.threadId;
    }

    return payload.target.kind;
  }, []);

  useEffect(() => {
    if (!isMobile || mobilePane !== "editor" || !mainPaneScrollKey) {
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
  }, [isMobile, mainPaneScrollKey, mobilePane]);

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

    const getCurrentScrollY = () => (
      isMobile
        ? mainPaneRef.current?.scrollTop ?? 0
        : Math.max(window.scrollY, 0)
    );

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
    const scrollTarget = isMobile ? mainPaneRef.current : window;
    scrollTarget?.addEventListener("scroll", handleScroll, { passive: true });
    viewport?.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollTarget?.removeEventListener("scroll", handleScroll);
      viewport?.removeEventListener("scroll", handleScroll);
      cancelPendingFrame();
    };
  }, [activeFilePath, activeThreadId, isMobile, mobileShellHeaderHeight, shouldShowShellHeader]);

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

    if (definition.type === "text" && typeof value === "string") {
      return (
        <input
          type="text"
          className="w-full rounded-lg border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-transparent px-3 py-2 text-[0.9rem] leading-6 text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-45"
          disabled={disabled}
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      );
    }

    if (definition.type === "textarea" && typeof value === "string") {
      return (
        <textarea
          className="explorer-scrollbar min-h-56 w-full resize-y rounded-lg border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-transparent px-3 py-2 font-mono text-[0.82rem] leading-6 text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-45"
          disabled={disabled}
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
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

    persistHarness(nextHarness);
    setHarness(nextHarness);
    controls?.setDraftThreadHarness(nextHarness);
  };

  const clearSelectionFromUi = useCallback(() => {
    navigateToRoute(createProjectRoute(explorer.currentProjectId || route.projectId));
    if (!controls) {
      startTransition(() => {
        setCurrentThread(null);
        setRateLimits(null);
        setExplorer((current) => ({
          ...current,
          currentPath: "",
          currentThreadId: "",
        }));
      });
    }
  }, [controls, explorer.currentProjectId, navigateToRoute, route.projectId]);

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

  const handleCollaborationThreadRegistryChange = useCallback((registry: WorkbenchCollaborationThreadRegistry) => {
    if (!activeProjectId) {
      return;
    }

    const normalizedRegistry = normalizeWorkbenchCollaborationThreadRegistry(registry);
    setCollaborationThreadRegistriesByProjectId((current) => {
      const existing = current[activeProjectId] ?? EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
      if (areCollaborationThreadRegistriesEqual(existing, normalizedRegistry)) {
        return current;
      }

      const next = {
        ...current,
        [activeProjectId]: normalizedRegistry,
      };
      writeStoredCollaborationThreadRegistries(next);
      return next;
    });
    void writeWorkbenchCollaborationThreadRegistry(activeProjectId, normalizedRegistry)
      .then((savedRegistry) => {
        setCollaborationThreadRegistriesByProjectId((current) => {
          const existing = current[activeProjectId] ?? EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
          if (areCollaborationThreadRegistriesEqual(existing, savedRegistry)) {
            return current;
          }

          const next = {
            ...current,
            [activeProjectId]: savedRegistry,
          };
          writeStoredCollaborationThreadRegistries(next);
          return next;
        });
      })
      .catch(() => {
        // Browser-local Collaboration state remains usable when disk sync is unavailable.
      });
  }, [activeProjectId]);

  const handleStartCollaborationSuggestionThread = useCallback(async (
    input: UserInput[],
    draftThread: ThreadPayload,
  ): Promise<{ status: "started"; threadId: string } | { error: string; status: "failed" }> => {
    if (!controls) {
      return {
        error: "Workbench controls are not ready.",
        status: "failed",
      };
    };

    try {
      let materializedThreadId = "";
      const payload = await sendThreadMessage(draftThread, input, {
        onThreadMaterialized: (materializedThread) => {
          materializedThreadId = materializedThread.id;
        },
        selectThread: false,
      });

      const threadId = payload?.id || materializedThreadId;
      if (!threadId) {
        return {
          error: "Workbench did not return a thread id for the started suggestion.",
          status: "failed",
        };
      }

      return {
        status: "started",
        threadId,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Unable to start suggestion thread.",
        status: "failed",
      };
    }
  }, [controls, sendThreadMessage]);

  return (
    <WorkbenchContextMenuProvider>
      <div
        className={`relative isolate h-dvh overflow-hidden md:grid md:min-h-screen md:h-auto md:overflow-visible md:items-start${isEffectiveDesktopSidebarCollapsed
          ? " md:grid-cols-[minmax(0,1fr)]"
          : " md:grid-cols-[minmax(16rem,21rem)_1fr]"
        }`}
        onClickCapture={handleWorkbenchClickCapture}
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
              setIsDesktopSidebarCollapsed(false);
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
              <span className="inline-flex size-5 items-center justify-center text-[1.15rem] leading-none">+</span>
              <span className="sr-only">Drag to create a new thread panel</span>
            </button>
          ) : null}
        </>
      ) : null}
      {activeWorkbenchDrag ? (
        <div
          ref={workbenchDragGhostRef}
          className="pointer-events-none fixed z-50 max-w-[18rem] truncate rounded-[0.7rem] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-3 py-1.5 text-[0.78rem] font-medium text-text shadow-float backdrop-blur"
          style={{
            left: 0,
            top: 0,
            transform: `translate3d(${activeWorkbenchDrag.x + 12}px, ${activeWorkbenchDrag.y + 12}px, 0)`,
          }}
        >
          {getWorkbenchDragGhostLabel(activeWorkbenchDrag.payload)}
        </div>
      ) : null}
      <div
        className="mobile-workbench-track flex h-dvh w-[200vw] overflow-hidden transition-transform duration-200 ease-out md:contents md:h-auto md:w-auto md:overflow-visible md:transform-none"
        style={mobileTrackStyle}
      >
        <aside className={`flex h-dvh w-screen min-w-0 shrink-0 select-none flex-col overflow-hidden px-5 py-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:px-6${isEffectiveDesktopSidebarCollapsed ? " md:hidden" : ""}`}>
          <div className="-ml-3 min-h-0 flex-1 overflow-hidden text-[0.95rem] leading-6">
            <div
              className="flex h-full w-[200%] flex-row-reverse transition-transform duration-200 ease-out"
              style={{ transform: sidebarTrackTransform }}
            >
              <div className="explorer-scrollbar flex min-h-0 w-1/2 flex-col overflow-y-auto pb-8 pl-2 pr-2">
                <section
                  className={`relative space-y-2 pb-6 transition-opacity${activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId === "project" ? " opacity-45" : ""}`}
                  {...getSidebarSectionDragProps("project")}
                  onPointerDown={(event) => {
                    beginWorkbenchPointerDrag(event, { sectionId: "project", type: "sidebar-section" });
                  }}
                  onPointerMove={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId !== "project") {
                      setSidebarDropTargetId("project");
                    }
                  }}
                  onPointerUp={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId !== "project") {
                      moveSidebarSection(activeWorkbenchDrag.payload.sectionId, "project");
                      endWorkbenchPointerDrag();
                    }
                  }}
                >
                  {sidebarDropTargetId === "project" ? <div className="pointer-events-none absolute -top-1 left-2 right-6 z-10 h-1 rounded-full bg-accent" aria-hidden="true" /> : null}
                  <div className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:-ml-2"
                      title={isSidebarProjectLoading ? "Loading project" : currentProjectTitle}
                      onClick={openProjectPicker}
                    >
                      <span className="min-w-0 relative -top-0.5">
                        {isSidebarProjectLoading ? (
                          <span className="block h-6 w-40 max-w-full rounded-md workbench-skeleton" aria-hidden="true" />
                        ) : (
                          <span className="block truncate text-xl font-semibold leading-tight text-text">{currentProjectDisplayName ?? (explorer.currentProjectId || "No project")}</span>
                        )}
                      </span>
                      <span className="shrink-0 relative -top-0.5 text-muted" aria-hidden="true">‹</span>
                    </button>
                    {usesDesktopSidebarCollapse ? (
                      <button
                        type="button"
                        aria-label="Hide sidebar"
                        title="Hide sidebar"
                        className={`${workbenchIconButtonClassName} hidden shrink-0 text-muted md:inline-flex`}
                        onClick={() => {
                          setIsDesktopSidebarCollapsed(true);
                        }}
                      >
                        <SidebarCollapseIcon />
                        <span className="sr-only">Hide sidebar</span>
                      </button>
                    ) : null}
                  </div>
                </section>

                <section className="pb-4 pr-2 md:pr-4.5">
                  <a
                    href={createCollaborationHref(activeProjectId)}
                    className={`flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:-ml-2${showCollaborationView ? " bg-accent-soft text-accent" : " text-muted"}`}
                    onClick={(event) => {
                      event.preventDefault();
                      navigateToRoute(createCollaborationRoute(explorer.currentProjectId || route.projectId));
                    }}
                  >
                    <CollaborationIcon />
                    <span className="min-w-0 truncate text-[0.95rem] font-semibold">Collaboration</span>
                  </a>
                </section>

                <section
                  className={`relative space-y-2 pb-6 transition-opacity${activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId === "threads" ? " opacity-45" : ""}`}
                  {...getSidebarSectionDragProps("threads")}
                  onPointerDown={(event) => {
                    beginWorkbenchPointerDrag(event, { sectionId: "threads", type: "sidebar-section" });
                  }}
                  onPointerMove={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId !== "threads") {
                      setSidebarDropTargetId("threads");
                    }
                  }}
                  onPointerUp={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId !== "threads") {
                      moveSidebarSection(activeWorkbenchDrag.payload.sectionId, "threads");
                      endWorkbenchPointerDrag();
                    }
                  }}
                >
                  {sidebarDropTargetId === "threads" ? <div className="pointer-events-none absolute -top-1 left-2 right-6 z-10 h-1 rounded-full bg-accent" aria-hidden="true" /> : null}
                  <div className="flex items-center justify-between gap-3 pr-2 md:pr-4.5">
                    <p className="m-0 text-base font-semibold leading-tight">Threads</p>
                  </div>
                  {isSidebarThreadsLoading ? (
                    <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />
                  ) : (
                    <nav aria-label="Threads">
                      <ThreadsList
                        createThreadLabel="Create new thread"
                        currentThreadId={activeThreadId}
                        getThreadDragPayload={(thread) => ({
                          target: { kind: "thread", threadId: thread.id },
                          type: "panel-target",
                        })}
                        onThreadPointerDragStart={(event, thread) => {
                          beginWorkbenchPointerDrag(event, {
                            target: { kind: "thread", threadId: thread.id },
                            type: "panel-target",
                          });
                        }}
                        onCreateThreadPointerDragStart={showMosaicView ? (event) => {
                          beginWorkbenchPointerDrag(event, {
                            harness,
                            type: "new-thread",
                          });
                        } : undefined}
                        isDraftSelected={Boolean(currentThread?.isDraft)}
                        getThreadContextMenu={getThreadContextMenu}
                        nodes={regularSidebarThreads}
                        pendingQuestionnaireThreadIds={pendingQuestionnaireThreadIds}
                        pinnedNodes={pinnedSidebarThreads}
                        onCreateThread={() => {
                          if (showMosaicView) {
                            return;
                          }
                          if (!controls) {
                            return;
                          }
                          const draftThread = controls.createThreadDraft(harness);
                          navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, draftThread.id));
                        }}
                        onOpenThread={(threadId) => {
                          void openThreadFromExplorer(threadId);
                        }}
                      />
                    </nav>
                  )}
                  {explorer.threadsError ? (
                    <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted">
                      {explorer.threadsError}
                    </p>
                  ) : null}
                </section>

                <section
                  className={`relative space-y-2 transition-opacity${activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId === "files" ? " opacity-45" : ""}`}
                  {...getSidebarSectionDragProps("files")}
                  onPointerDown={(event) => {
                    beginWorkbenchPointerDrag(event, { sectionId: "files", type: "sidebar-section" });
                  }}
                  onPointerMove={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId !== "files") {
                      setSidebarDropTargetId("files");
                    }
                  }}
                  onPointerUp={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section" && activeWorkbenchDrag.payload.sectionId !== "files") {
                      moveSidebarSection(activeWorkbenchDrag.payload.sectionId, "files");
                      endWorkbenchPointerDrag();
                    }
                  }}
                >
                  {sidebarDropTargetId === "files" ? <div className="pointer-events-none absolute -top-1 left-2 right-6 z-10 h-1 rounded-full bg-accent" aria-hidden="true" /> : null}
                  <div className="group/entry-row flex items-center justify-between gap-3 pr-2 md:pr-4.5">
                    <button
                      type="button"
                      className="m-0 rounded-lg px-2 py-1.5 text-left text-base font-semibold leading-tight transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:-ml-2 md:py-0.5"
                      onClick={() => {
                        clearSelectionFromUi();
                      }}
                    >
                      Project
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                        aria-pressed={showUnopenableFiles}
                        disabled={!explorer.currentProjectId || isSidebarProjectLoading}
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
                        disabled={!explorer.currentProjectId || isSidebarProjectLoading}
                        onClick={() => {
                          openCreateDialog("");
                        }}
                      >
                        <NewEntryIcon />
                        <span className="sr-only">Create in project</span>
                      </button>
                    </div>
                  </div>
                  {!explorer.projects.length && !isSidebarProjectLoading ? (
                    <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted md:pr-4.5">
                      No projects were found.
                    </p>
                  ) : null}
                  {isSidebarProjectLoading ? (
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
                </section>
                <div
                  className="relative h-5 shrink-0"
                  style={{ order: sidebarSectionOrder.length }}
                  onPointerMove={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section") {
                      setSidebarDropTargetId("end");
                    }
                  }}
                  onPointerUp={() => {
                    if (activeWorkbenchDrag?.payload.type === "sidebar-section") {
                      moveSidebarSectionToEnd(activeWorkbenchDrag.payload.sectionId);
                      endWorkbenchPointerDrag();
                    }
                  }}
                >
                  {sidebarDropTargetId === "end" ? <div className="pointer-events-none absolute left-2 right-6 top-2 z-10 h-1 rounded-full bg-accent" aria-hidden="true" /> : null}
                </div>
                <footer
                  className="pr-2 pt-4 pb-1 md:pr-4.5"
                  style={{ order: sidebarSectionOrder.length + 1 }}
                >
                  <div className="flex items-center gap-1">
                    <a
                      aria-label="Open settings"
                      href={createSettingsHref(activeProjectId, "global")}
                      title="Open settings"
                      className={`${workbenchIconButtonClassName} text-muted`}
                      onClick={openSettingsFromLink}
                    >
                      <GearIcon />
                      <span className="sr-only">Open settings</span>
                    </a>
                    <button
                      type="button"
                      aria-label={isReloadingRuntime ? "Reloading local runtime" : "Reload local runtime"}
                      title={isReloadingRuntime ? "Reloading local runtime" : "Reload local runtime"}
                      className={`${workbenchIconButtonClassName}${isReloadingRuntime ? " text-accent" : " text-muted"}`}
                      disabled={isReloadingRuntime}
                      onClick={() => {
                        void reloadLocalRuntime();
                      }}
                    >
                      <ReloadIcon />
                      <span className="sr-only">
                        {isReloadingRuntime ? "Reloading local runtime" : "Reload local runtime"}
                      </span>
                    </button>
                  </div>
                  {reloadMessage ? (
                    <p className="mt-2 text-[0.84rem] leading-6 text-muted">{reloadMessage}</p>
                  ) : null}
                  {reloadError ? (
                    <p className="mt-2 text-[0.84rem] leading-6 text-danger">{reloadError}</p>
                  ) : null}
                </footer>
              </div>

              <div
                ref={projectsPaneRef}
                tabIndex={-1}
                className="explorer-scrollbar min-h-0 w-1/2 overflow-y-auto pb-8 pl-5 pr-2 focus:outline-none"
                onKeyDown={handleProjectsPaneKeyDown}
              >
                <section className="space-y-3 pr-2 md:pr-4.5">
                  <nav aria-label="Projects" className="space-y-3">
                    {groupedProjects.libraryProjects.length ? (
                      <div className="space-y-1">
                        {groupedProjects.libraryProjects.map((project) => renderProjectLink(project))}
                      </div>
                    ) : null}
                    {groupedProjects.timeGroups.map((timeGroup) => (
                      <section key={timeGroup.label} aria-label={`${timeGroup.label} projects`} className="space-y-2">
                        <p className="m-0 mt-8 px-2 text-[1.24rem] font-semibold leading-tight opacity-50 italic flex items-center">
                          <span className="block h-[1px] flex-1 bg-[currentcolor]/25" />
                          <span className="block mx-4">{timeGroup.label}</span>
                          <span className="block h-[1px] flex-1 bg-[currentcolor]/25" />
                        </p>
                        {timeGroup.folderGroups.map((group) => (
                          <section key={group.label} aria-label={`${timeGroup.label} ${group.label} projects`} className="space-y-1">
                            <p className="m-0 mt-8 truncate px-2 font-mono text-[1.12rem] font-semibold leading-tight text-muted">
                              {group.label}
                            </p>
                            <div className="space-y-1 pl-2">
                              {group.projects.map((project) => renderProjectLink(project))}
                            </div>
                          </section>
                        ))}
                      </section>
                    ))}
                    {!explorer.projects.length ? (
                      <p className="m-0 text-[0.84rem] leading-6 text-muted">
                        No projects were found.
                      </p>
                    ) : null}
                  </nav>
                </section>
              </div>

            </div>
          </div>
        </aside>

        <main
          ref={mainPaneRef}
          className={`explorer-scrollbar flex h-dvh w-screen min-w-0 shrink-0 flex-col overflow-x-hidden overflow-y-auto md:w-auto${showFullBleedMainView
            ? " px-5 pb-5 md:h-screen md:min-h-0 md:overflow-hidden md:px-0 md:pb-0"
            : " px-5 pb-5 md:h-auto md:min-h-screen md:overflow-visible md:px-6 md:pb-5"
          }`}
        >
          <header
            ref={shellHeaderRef}
            className={`
              sticky top-0 z-10 transform-gpu py-3 transition-[translate,opacity] duration-200 ease-out will-change-translate motion-reduce:transition-none -mx-5 px-5 md:-mx-6 md:px-6
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
              <div className="order-2 min-w-0 md:order-1" hidden={Boolean(currentThread?.isDraft)}>
                <p id="file-path" ref={filePathLabelRef} className="truncate text-base font-semibold leading-tight">
                  {isThreadShellTitleLoading ? (
                    <span className="block h-4 w-48 max-w-[60vw] rounded-full workbench-skeleton" aria-hidden="true" />
                  ) : showThreadView ? threadShellTitle : showSettingsView ? "Settings" : "Select a file"}
                </p>
                <p id="status-line" ref={statusLineRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted">
                  {showThreadView ? threadShellStatusLabel : showSettingsView ? "Theme and local Workbench preferences." : "Markdown files open as rich text. Save with Ctrl/Cmd+S."}
                </p>
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
            className={`relative md:min-h-0 md:flex-1${showFullBleedMainView ? " min-h-0 overflow-hidden" : ""}`}
            aria-busy={isSelectionPending}
          >
            {showThreadView && !shouldRenderMainLayout ? (
              isThreadViewReady && threadForThreadView ? (
                <ThreadView
                  key={`${activeProjectId}:${threadForThreadView.id}`}
                  thread={threadForThreadView}
                  composerSpellCheck={resolvedSettings.composerSpellCheck}
                  fontSizeRem={resolvedSettings.editorFontSize}
                  livePendingUserInputRequestsByThreadId={visibleUserInputRequestsByThreadId}
                  onDraftHarnessChange={handleHarnessChange}
                  onListModels={listThreadModels}
                  onReadThread={readThread}
                  onThreadSeen={markThreadSeen}
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
                  onThreadModelChange={setThreadModel}
                  onThreadCodeBlockWrapChange={updateThreadCodeBlockWrapSetting}
                  projectId={activeProjectId}
                  projectFileCandidates={explorer.projectFileCandidates}
                  projectFileIndexId={explorer.projectFileIndexId}
                  projectFilePaths={explorer.projectFilePaths}
                  projectFileLinkRoots={projectFileLinkRoots}
                  projectRootPath={explorer.rootPath}
                  projectRoots={explorer.roots}
                  rateLimits={rateLimits}
                  threadCodeBlockWrap={resolvedSettings.threadCodeBlockWrap}
                  threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                  threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
                  threadSavedComposerDrafts={threadSavedComposerDrafts}
                  onThreadSavedComposerDraftDelete={handleThreadSavedComposerDraftDelete}
                  onThreadSavedComposerDraftSave={handleThreadSavedComposerDraftSave}
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
                      ? SETTINGS_ORDER.map((key) => renderGlobalSettingRow(key))
                      : SETTINGS_ORDER.map((key) => renderProjectSettingRow(key))}
                  </div>
                </section>
              </div>
            ) : null}
            {showCollaborationView && !shouldRenderMainLayout ? (
              <div className="h-full min-h-0">
                <WorkbenchCollaborationView
                  collaboratorPrompt={resolvedSettings.collaborationCollaboratorPrompt}
                  collaborationThreadRegistry={collaborationThreadRegistry}
                  collaborationStartedSuggestionThreadSummaries={collaborationStartedSuggestionThreadSummaries}
                  collaborationThreadSummaries={collaborationThreadSummaries}
                  composerSpellCheck={resolvedSettings.composerSpellCheck}
                  controls={controls}
                  editorFontClassName={editorFontClassName}
                  fontSizeRem={resolvedSettings.editorFontSize}
                  harness={harness}
                  isMobile={isMobile}
                  isProjectLoading={explorer.isProjectLoading}
                  livePendingUserInputRequestsByThreadId={visibleUserInputRequestsByThreadId}
                  onCollaborationThreadRegistryChange={handleCollaborationThreadRegistryChange}
                  onClaimAutoWake={claimWorkbenchCollaborationAutoWake}
                  onDraftHarnessChange={handleHarnessChange}
                  onListModels={listThreadModels}
                  onReadThread={readThread}
                  onThreadSeen={markThreadSeen}
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
                  onOpenThreadFromSuggestion={(threadId) => {
                    navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, threadId));
                  }}
                  onStartThreadFromPrompt={handleStartCollaborationSuggestionThread}
                  onThreadModelChange={setThreadModel}
                  onThreadCodeBlockWrapChange={updateThreadCodeBlockWrapSetting}
                  projectFileCandidates={explorer.projectFileCandidates}
                  projectChanges={explorer.changes}
                  projectFileIndexId={explorer.projectFileIndexId}
                  projectFileLinkRoots={projectFileLinkRoots}
                  projectFilePaths={explorer.projectFilePaths}
                  projectId={activeProjectId}
                  projectRootPath={explorer.rootPath}
                  projectRoots={explorer.roots}
                  rateLimits={rateLimits}
                  scratchpadPath={collaborationScratchpadPath}
                  scratchpadWritableRoot={collaborationScratchpadWritableRoot}
                  threadCodeBlockWrap={resolvedSettings.threadCodeBlockWrap}
                  threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                  threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
                  threadSavedComposerDrafts={threadSavedComposerDrafts}
                  onThreadSavedComposerDraftDelete={handleThreadSavedComposerDraftDelete}
                  onThreadSavedComposerDraftSave={handleThreadSavedComposerDraftSave}
                />
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
                  <button
                    type="button"
                    className="inline-flex w-fit items-center gap-2 rounded-full bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] px-4 py-2 text-[0.84rem] font-medium text-[var(--bg)] transition hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]"
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
                  </button>
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
            {shouldRenderMainLayout && mainLayoutForRender && (!showFileView || isFileViewReady || activeWorkbenchDrag?.payload.type === "panel-target") ? (
              <WorkbenchMainLayoutView
                activeDrag={activeWorkbenchDrag}
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
                        fallbackThread={mosaicDraftThreadsById[target.threadId] ?? currentThread}
                        fallbackThreadSummary={threadSummariesById.get(target.threadId) ?? null}
                        fontSizeRem={resolvedSettings.editorFontSize}
                        hasSidebarRestoreInset={hasSidebarRestoreInset}
                        isFocused={isFocused}
                        isMinimized={isMinimized}
                        isMinimizedVertical={isMinimizedVertical}
                        livePendingUserInputRequestsByThreadId={visibleUserInputRequestsByThreadId}
                        onDraftHarnessChange={handleHarnessChange}
                        onListModels={listThreadModels}
                        onReadThread={readThread}
                        onThreadSeen={markThreadSeen}
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
                        onThreadModelChange={setThreadModel}
                        onThreadCodeBlockWrapChange={updateThreadCodeBlockWrapSetting}
                        projectId={activeProjectId}
                        projectFileCandidates={explorer.projectFileCandidates}
                        projectFileIndexId={explorer.projectFileIndexId}
                        projectFilePaths={explorer.projectFilePaths}
                        projectRootPath={explorer.rootPath}
                        projectRoots={explorer.roots}
                        rateLimits={rateLimits}
                        threadCodeBlockWrap={resolvedSettings.threadCodeBlockWrap}
                        threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                        threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
                        threadSavedComposerDrafts={threadSavedComposerDrafts}
                        onThreadSavedComposerDraftDelete={handleThreadSavedComposerDraftDelete}
                        onThreadSavedComposerDraftSave={handleThreadSavedComposerDraftSave}
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
                        threadId={target.threadId}
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
  );
}
