"use client";

/*
 * Exports:
 * - default Workbench: client shell for project browsing, editing, and thread interaction. Keywords: workbench, project, editor, thread.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
  ExplorerSnapshot, FilePayload, OrchestratorReloadRequest, OrchestratorReloadResponse, ThreadPayload, TreeNode,
  WorkbenchControls,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchQuestionnaireDraft,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadComposerDraft,
  WorkbenchUserInputResponse
} from "../lib/types";
import {
  createFileRoute,
  createProjectHref,
  createProjectRoute,
  createThreadRoute,
} from "../lib/workbench/navigation/workbench-route";
import { useWorkbenchRoute } from "../lib/workbench/navigation/use-workbench-route";
import { isWorkbenchOpenableFile } from "../lib/workbench/project/tree-utils";
import {
  persistHarness,
  readStoredHarness,
} from "../lib/workbench/state/browser-state";
import {
  getPreferredMobilePane,
  MOBILE_MEDIA_QUERY,
  type MobilePane,
} from "../lib/workbench/state/mobile-pane-url-state";
import {
  deletePersistedThreadComposerDraft,
  deletePersistedThreadQuestionnaireDraft,
  getPersistedThreadComposerDraftRecords,
  getPersistedThreadQuestionnaireDraftRecords,
  putPersistedThreadComposerDraft,
  putPersistedThreadQuestionnaireDraft,
} from "../lib/workbench/thread/thread-composer-drafts";
import type { WorkbenchDomSurfaces } from "../lib/workbench/workbench-dom";
import ThreadView from "./workbench/thread-view/ThreadView";
import WorkbenchTabIcon, { type WorkbenchTabIconState } from "./workbench/WorkbenchTabIcon";
import {
  workbenchDiffGutterClassName,
  workbenchFloatingToolbarClassName,
  workbenchFloatingToolbarGroupClassName,
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchRevisionHoverToolbarClassName,
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench/workbench-class-names";
import {
  dialogButtonClassName,
  WorkbenchDialog,
} from "./workbench/workbench-dialogs";
import {
  ExplorerTree,
  FileVisibilityIcon,
  NewEntryIcon,
  ThreadsList,
} from "./workbench/workbench-explorer";
import {
  BackArrowIcon,
  BinIcon,
  SaveIcon,
  ZoomInIcon,
  ZoomOutIcon
} from "./workbench/workbench-icons";

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  currentProjectId: "",
  projects: [],
  root: "Project",
  rootPath: "",
  tree: [],
  threads: [],
  changes: {},
  currentPath: "",
  currentThreadId: "",
  expandedDirectories: [""],
  locallyModifiedPaths: [],
  threadsError: "",
  fontSize: 1.08,
};

const MOBILE_SHELL_HEADER_HIDE_THRESHOLD_PX = 24;
const MOBILE_SHELL_HEADER_SHOW_THRESHOLD_PX = 8;
const DEFAULT_RELOAD_REQUEST: OrchestratorReloadRequest = {
  scopes: ["orchestrator-logic", "codex-bridge", "next-dev"],
};

function isReloadResponse (value: unknown): value is OrchestratorReloadResponse {
  return !!value
    && typeof value === "object"
    && "ok" in value
    && "state" in value;
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

function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

function isThreadStatusWaitingOnUserInput(status: string) {
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

export default function Workbench () {
  const { navigateToRoute, route } = useWorkbenchRoute();
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [currentThread, setCurrentThread] = useState<ThreadPayload | null>(null);
  const [harnessUserInputRequestsByThreadId, setHarnessUserInputRequestsByThreadId] = useState<Record<string, WorkbenchPendingUserInputRequest>>({});
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
  const [showUnopenableFiles, setShowUnopenableFiles] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"main" | "projects">("main");
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");
  const [isReloadingRuntime, setIsReloadingRuntime] = useState(false);
  const [quickOpenUpdatedAtByPath, setQuickOpenUpdatedAtByPath] = useState<Record<string, string>>({});
  const [reloadError, setReloadError] = useState("");
  const [reloadMessage, setReloadMessage] = useState("");
  const [threadComposerDraftsByThreadId, setThreadComposerDraftsByThreadId] = useState<Record<string, WorkbenchThreadComposerDraft | undefined>>({});
  const [threadQuestionnaireDraftsByKey, setThreadQuestionnaireDraftsByKey] = useState<Record<string, WorkbenchQuestionnaireDraft | undefined>>({});
  const editorRef = useRef<HTMLDivElement>(null);
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
  const retainedThreadRef = useRef<ThreadPayload | null>(null);

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

    initTimeoutId = window.setTimeout(() => {
      void import("../lib/WorkbenchClient").then(async ({ WorkbenchClient: initWorkbench }) => {
        const dom = getWorkbenchDomSurfaces();
        const nextCleanup = await initWorkbench({
          dom,
          onExplorerStateChange: (snapshot) => {
            if (cancelled) {
              return;
            }

            startTransition(() => {
              setExplorer(snapshot);
            });
          },
          onCurrentThreadChange: (thread) => {
            if (cancelled) {
              return;
            }

            startTransition(() => {
              setCurrentThread(thread);
            });
          },
          onPendingUserInputRequestsChange: (requestsByThreadId) => {
            if (cancelled) {
              return;
            }

            startTransition(() => {
              setHarnessUserInputRequestsByThreadId(requestsByThreadId);
            });
          },
          onRateLimitsChange: (nextRateLimits) => {
            if (cancelled) {
              return;
            }

            startTransition(() => {
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
      return;
    }

    let cancelled = false;
    void Promise.all([
      getPersistedThreadComposerDraftRecords(explorer.currentProjectId),
      getPersistedThreadQuestionnaireDraftRecords(explorer.currentProjectId),
    ]).then(([composerRecords, questionnaireRecords]) => {
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
    if (!controls) {
      return;
    }

    if (route.view === "file" && !isWorkbenchOpenableFile(route.filePath)) {
      setSelectionError(`This file cannot be opened here: ${route.filePath}`);
      return;
    }

    setSelectionError("");
    let cancelled = false;
    void controls.applyRoute(route).then((result) => {
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
  }, [controls, route]);

  const expandedDirectories = new Set(explorer.expandedDirectories);
  const modifiedPaths = new Set(explorer.locallyModifiedPaths);
  const visibleTree = useMemo(
    () => (showUnopenableFiles ? explorer.tree : filterVisibleTreeNodes(explorer.tree)),
    [explorer.tree, showUnopenableFiles],
  );
  const currentProject = explorer.projects.find((project) => project.id === explorer.currentProjectId) ?? null;
  const pageTitle = formatWorkbenchPageTitle(currentProject?.name ?? explorer.root ?? explorer.currentProjectId);

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

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

  useEffect(() => {
    if (sidebarMode !== "projects") {
      return;
    }

    projectsPaneRef.current?.focus();
  }, [sidebarMode]);

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

  const openFileFromExplorer = useCallback(async (path: string) => {
    if (!isWorkbenchOpenableFile(path)) {
      return false;
    }

    if (route.view === "file" && path === route.filePath) {
      return true;
    }

    navigateToRoute(createFileRoute(explorer.currentProjectId || route.projectId, path));
    return true;
  }, [explorer.currentProjectId, navigateToRoute, route]);

  const openThreadFromExplorer = useCallback(async (threadId: string) => {
    if (route.view === "thread" && threadId === route.threadId) {
      return true;
    }

    navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, threadId));
    return true;
  }, [explorer.currentProjectId, navigateToRoute, route]);
  const openFileFromThreadView = useCallback(async (path: string) => {
    void await openFileFromExplorer(path);
  }, [openFileFromExplorer]);

  const readThread = useCallback(async (threadId: string, nextHarness?: WorkbenchHarness) => {
    if (!controls) {
      return null;
    }

    return await controls.readThread(threadId, nextHarness);
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

    const materializedOptions: WorkbenchSendThreadMessageOptions | undefined = thread.isDraft
      ? {
        ...options,
        onThreadMaterialized: (materializedThread) => {
          options?.onThreadMaterialized?.(materializedThread);
          if (materializedThread.id !== thread.id) {
            navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, materializedThread.id), { replace: true });
          }
        },
      }
      : options;
    const payload = await controls.sendThreadMessage(thread, input, materializedOptions);
    if (payload) {
      if (thread.isDraft && payload.id !== thread.id) {
        navigateToRoute(createThreadRoute(explorer.currentProjectId || route.projectId, payload.id), { replace: true });
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
  }, [controls, explorer.currentProjectId, navigateToRoute, route.projectId]);

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
    await controls?.submitPendingUserInputRequest(threadId, response, options);
  }, [controls]);

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
  const showThreadView = route.view === "thread";
  const showFileView = route.view === "file";
  const showEmptyState = !showThreadView && !showFileView;
  const showRouteError = Boolean(selectionError) && !showThreadView && !showFileView;
  if (currentThread) {
    retainedThreadRef.current = currentThread;
  }
  const retainedThread = retainedThreadRef.current;
  const threadForThreadView = showThreadView && currentThread?.id === route.threadId
    ? currentThread
    : showThreadView && retainedThread?.id === route.threadId
      ? retainedThread
      : null;
  const isThreadViewReady = showThreadView && Boolean(threadForThreadView);
  const isFileViewReady = showFileView && !currentThread && explorer.currentPath === route.filePath;
  const isSelectionPending = !selectionError && ((showThreadView && !isThreadViewReady) || (showFileView && !isFileViewReady));
  const activeThreadId = showThreadView ? route.threadId : "";
  const activeFilePath = showFileView ? route.filePath : "";
  const pendingQuestionnaireThreadIds = useMemo(
    () => new Set(Object.keys(harnessUserInputRequestsByThreadId)),
    [harnessUserInputRequestsByThreadId],
  );
  const hasPendingQuestionnaire = Boolean(currentThread
    && pendingQuestionnaireThreadIds.has(currentThread.id)
    && isThreadStatusWaitingOnUserInput(currentThread.status))
    || explorer.threads.some((thread) => (
      pendingQuestionnaireThreadIds.has(thread.id)
      && isThreadStatusWaitingOnUserInput(thread.status)
    ));
  const hasActiveThread = Boolean(currentThread && isThreadStatusActive(currentThread.status))
    || explorer.threads.some((thread) => Boolean(thread.unreadBadge?.hasActiveTurn));
  const tabIconState: WorkbenchTabIconState = hasPendingQuestionnaire
    ? "questionnaire"
    : hasActiveThread
      ? "active"
      : "default";
  const shouldShowShellHeader = !showEmptyState && (!isMobile || mobilePane === "editor");

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

    const resetHeaderVisibility = () => {
      cancelPendingFrame();
      mobileShellHeaderScrollYRef.current = Math.max(window.scrollY, 0);
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

      const nextScrollY = Math.max(window.scrollY, 0);
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
    window.addEventListener("scroll", handleScroll, { passive: true });
    viewport?.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
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

  return (
    <div className="min-h-screen md:grid md:grid-cols-[minmax(16rem,21rem)_1fr] md:items-start">
      <WorkbenchTabIcon state={tabIconState} />
      <div
        className="mobile-workbench-track flex min-h-screen w-[200vw] transition-transform duration-200 ease-out md:contents md:w-auto md:transform-none"
        style={mobileTrackStyle}
      >
        <aside className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col overflow-hidden px-5 pb-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:px-6 md:py-5">
          <div className="-ml-3 min-h-0 flex-1 overflow-hidden text-[0.95rem] leading-6">
            <div
              className="flex h-full w-[200%] flex-row-reverse transition-transform duration-200 ease-out"
              style={{ transform: sidebarMode === "projects" ? "translateX(0)" : "translateX(-50%)" }}
            >
              <div className="explorer-scrollbar min-h-0 w-1/2 overflow-y-auto pb-8 pl-2 pr-2">
                <section className="space-y-2 pb-6">
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:-ml-2"
                    title={currentProject?.rootPath ?? explorer.rootPath}
                    onClick={openProjectPicker}
                  >
                    <span className="min-w-0 relative -top-0.5">
                      <span className="block truncate text-xl font-semibold leading-tight text-text">{currentProject?.name ?? (explorer.currentProjectId || "No project")}</span>
                    </span>
                    <span className="shrink-0 relative -top-0.5 text-muted" aria-hidden="true">‹</span>
                  </button>
                </section>

                <section className="space-y-2 pb-6">
                  <div className="flex items-center justify-between gap-3 pr-2 md:pr-4.5">
                    <p className="m-0 text-base font-semibold leading-tight">Threads</p>
                  </div>
                  <nav aria-label="Threads">
                    <ThreadsList
                      createThreadLabel="Create new thread"
                      currentThreadId={activeThreadId}
                      isDraftSelected={Boolean(currentThread?.isDraft)}
                      nodes={explorer.threads}
                      pendingQuestionnaireThreadIds={pendingQuestionnaireThreadIds}
                      onCreateThread={() => {
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
                  {explorer.threadsError ? (
                    <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted">
                      {explorer.threadsError}
                    </p>
                  ) : null}
                </section>

                <section className="space-y-2">
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
                        title={showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open"}
                        className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}${showUnopenableFiles ? " bg-accent-soft text-accent" : ""}`}
                        onClick={() => {
                          setShowUnopenableFiles((current) => !current);
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
                        disabled={!explorer.currentProjectId}
                        onClick={() => {
                          openCreateDialog("");
                        }}
                      >
                        <NewEntryIcon />
                        <span className="sr-only">Create in project</span>
                      </button>
                    </div>
                  </div>
                  {!explorer.projects.length ? (
                    <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted md:pr-4.5">
                      No projects were found.
                    </p>
                  ) : null}
                  <nav id="file-tree" aria-label="Project files">
                    <ExplorerTree
                      changes={explorer.changes}
                      controls={workbenchControls}
                      currentPath={activeFilePath}
                      expandedDirectories={expandedDirectories}
                      isFileOpenable={isWorkbenchOpenableFile}
                      modifiedPaths={modifiedPaths}
                      nodes={visibleTree}
                      onCreateInDirectory={openCreateDialog}
                      onOpenFile={(path) => {
                        void openFileFromExplorer(path);
                      }}
                    />
                  </nav>
                  <div className="pr-2 pt-4 md:pr-4.5">
                    <button
                      type="button"
                      className={`${workbenchThreadListButtonClassName}${isReloadingRuntime ? " text-accent" : " text-muted"}`}
                      disabled={isReloadingRuntime}
                      onClick={() => {
                        void reloadLocalRuntime();
                      }}
                    >
                      <span className={`${workbenchThreadListLabelClassName}${isReloadingRuntime ? " font-semibold" : ""}`}>
                        {isReloadingRuntime ? "Reloading local runtime..." : "Reload local runtime"}
                      </span>
                    </button>
                    {reloadMessage ? (
                      <p className="mt-2 text-[0.84rem] leading-6 text-muted">{reloadMessage}</p>
                    ) : null}
                    {reloadError ? (
                      <p className="mt-2 text-[0.84rem] leading-6 text-danger">{reloadError}</p>
                    ) : null}
                  </div>
                </section>
              </div>

              <div
                ref={projectsPaneRef}
                tabIndex={-1}
                className="explorer-scrollbar min-h-0 w-1/2 overflow-y-auto pb-8 pl-5 pr-2 focus:outline-none"
                onKeyDown={handleProjectsPaneKeyDown}
              >
                <section className="space-y-3 pr-2 md:pr-4.5">
                  <p className="m-0 px-2 text-base font-semibold leading-tight">Projects</p>
                  <nav aria-label="Projects" className="space-y-1">
                    {explorer.projects.map((project) => {
                      const isCurrentProject = project.id === explorer.currentProjectId;
                      return (
                        <a
                          key={project.id}
                          href={createProjectHref(project.id)}
                          title={project.rootPath}
                          className={`relative block min-w-0 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1${isCurrentProject ? " text-accent after:absolute after:bottom-1 after:right-0 after:top-1 after:w-px after:bg-accent" : " text-muted"}`}
                          onClick={(event) => {
                            void selectProjectFromLink(event, project.id);
                          }}
                        >
                          <span className={`block truncate text-[0.94rem] leading-tight${isCurrentProject ? " font-semibold" : ""}`}>{project.name || project.id}</span>
                          <span className="mt-1 block truncate text-[0.74rem] leading-tight text-muted">{project.rootPath}</span>
                        </a>
                      );
                    })}
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

        <main className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col px-5 pb-5 md:w-auto md:px-6 md:pb-5">
          <header
            ref={shellHeaderRef}
            className={`
              sticky top-0 z-10 transform-gpu py-3 transition-[translate,opacity] duration-200 ease-out will-change-translate motion-reduce:transition-none -mx-6 px-6
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
              className="pointer-events-none absolute inset-0 -z-10 md:mx-auto md:max-w-[58rem] bg-[linear-gradient(to_bottom,var(--bg)_calc(100%-var(--spacing)*6),transparent)] md:backdrop-blur-none"
            />
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="order-2 min-w-0 md:order-1" hidden={Boolean(currentThread?.isDraft)}>
                <p id="file-path" ref={filePathLabelRef} className="truncate text-base font-semibold leading-tight">
                  Select a file
                </p>
                <p id="status-line" ref={statusLineRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted">
                  Markdown files open as rich text. Save with Ctrl/Cmd+S.
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
                <div className="flex items-center gap-1.5" hidden={Boolean(currentThread) || showThreadView}>
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

          <section className="relative md:min-h-0 md:flex-1" aria-busy={isSelectionPending}>
            {showThreadView ? (
              isThreadViewReady && threadForThreadView ? (
                <ThreadView
                  thread={threadForThreadView}
                  fontSizeRem={explorer.fontSize}
                  livePendingUserInputRequestsByThreadId={harnessUserInputRequestsByThreadId}
                  onDraftHarnessChange={handleHarnessChange}
                  onListModels={listThreadModels}
                  onOpenFile={openFileFromThreadView}
                  onReadThread={readThread}
                  onThreadSeen={markThreadSeen}
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
                  projectId={explorer.currentProjectId}
                  projectRootPath={explorer.rootPath}
                  projectTree={explorer.tree}
                  rateLimits={rateLimits}
                  threadComposerDraftsByThreadId={threadComposerDraftsByThreadId}
                  threadQuestionnaireDraftsByKey={threadQuestionnaireDraftsByKey}
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
                <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                  <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                    <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">Thread</p>
                    <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Loading thread...</p>
                    <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{route.threadId}</p>
                  </div>
                </div>
              )
            ) : null}
            {showRouteError ? (
              <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                <div className="shadow-float flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger/30 bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                  <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-danger uppercase">Route</p>
                  <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open route</p>
                  <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{selectionError}</p>
                </div>
              </div>
            ) : showEmptyState ? (
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
            <div
              className="editor-shell relative mx-auto grid w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem_minmax(0,1fr)] gap-[0.53rem] md:max-w-[calc(56rem+2.5rem)] md:grid-cols-[1.25rem_minmax(0,56rem)] md:gap-3 -ml-5 md:ml-auto"
              hidden={!showFileView || !isFileViewReady}
            >
              <div
                id="editor-diff-gutter"
                ref={diffGutterRef}
                className={workbenchDiffGutterClassName}
                aria-hidden="true"
              />
              <div
                id="editor"
                ref={editorRef}
                className="editor-content min-h-[calc(100vh-6rem)] pb-16 font-serif text-[1.08rem] leading-[1.72] whitespace-normal outline-none"
                contentEditable
                suppressContentEditableWarning
                spellCheck
                data-placeholder="Select a markdown file to start editing."
              />
              <div
                id="editor-custom-caret"
                ref={customCaretRef}
                className="editor-custom-caret"
                aria-hidden="true"
                hidden
              />
            </div>
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
                  <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{route.filePath}</p>
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
  );
}
