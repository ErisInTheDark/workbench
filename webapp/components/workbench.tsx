"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
  ExplorerSnapshot, FilePayload, ThreadPayload,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
  WorkbenchControls,
  WorkbenchHarness
} from "../lib/types";
import {
  CURRENT_SELECTION_URL_UPDATED_EVENT,
  persistHarness,
  readCurrentSelectionFromUrl,
  readStoredHarness,
  syncCurrentSelectionToUrl,
  type WorkbenchSelectionSearchParams,
} from "../lib/workbench/state/browser-state";
import {
  getPreferredMobilePane,
  MOBILE_MEDIA_QUERY,
  type MobilePane,
} from "../lib/workbench/state/mobile-pane-url-state";
import type { WorkbenchDomSurfaces } from "../lib/workbench/workbench-dom";
import ThreadView from "./workbench/thread-view/ThreadView";
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

const EMPTY_SELECTION: WorkbenchSelectionSearchParams = {
  filePath: "",
  threadId: "",
};

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

function createDemoUserInputRequest (thread: ThreadPayload): WorkbenchUserInputRequest {
  const threadLabel = thread.name?.trim() || thread.preview?.trim() || "this thread";

  return {
    id: `demo:${thread.id}`,
    submitLabel: "Submit local response",
    summary: `Imagine the agent working on "${threadLabel}" and pausing before it commits to a direction. This is a local composer preview only, so we can tune spacing, option density, and how the summary sits above the questions.`,
    title: "Choose the next direction for the reply",
    questions: [
      {
        id: "direction",
        header: "Direction",
        question: "Which path should the agent take next?",
        allowOther: false,
        isSecret: false,
        options: [
          {
            label: "Tighten the structure",
            description: "Keep the response lean, reduce wandering, and move briskly toward a recommendation.",
          },
          {
            label: "Lean into emotional clarity",
            description: "Explain the emotional stakes more explicitly before choosing the next step.",
          },
          {
            label: "Stay exploratory",
            description: "Keep multiple possibilities alive instead of collapsing to one answer too early.",
          },
        ],
      },
      {
        id: "delivery",
        header: "Delivery",
        question: "How should the follow-up answer feel?",
        allowOther: false,
        isSecret: false,
        options: [
          {
            label: "Short and decisive",
            description: "One clear recommendation with minimal caveats.",
          },
          {
            label: "Balanced with rationale",
            description: "Recommendation first, then a compact explanation of why it is the best fit.",
          },
          {
            label: "Detailed and comparative",
            description: "Walk through the tradeoffs between options before landing the answer.",
          },
        ],
      },
      {
        id: "constraint",
        header: "Constraint",
        question: "What should the agent preserve while continuing?",
        allowOther: true,
        isSecret: false,
        options: [
          {
            label: "Keep the current voice",
            description: "Do not flatten the tone or make it sound more generic.",
          },
          {
            label: "Keep it under 300 words",
            description: "Answer tersely and avoid a long essay.",
          },
          {
            label: "Do not rewrite quoted text",
            description: "Leave any quoted lines intact and work around them.",
          },
        ],
      },
    ],
  };
}

function formatDemoUserInputResponse (
  request: WorkbenchUserInputRequest,
  response: WorkbenchUserInputResponse,
) {
  const parts = request.questions.map((question) => {
    const answer = response.answers[question.id]?.answers[0];
    return answer ? `${question.header}: ${answer}` : null;
  }).filter((value): value is string => Boolean(value));

  if (!parts.length) {
    return "Captured a local preview response.";
  }

  return `Captured local preview response. ${parts.join(" | ")}`;
}

export default function Workbench () {
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [currentThread, setCurrentThread] = useState<ThreadPayload | null>(null);
  const [composerInfoMessagesByThreadId, setComposerInfoMessagesByThreadId] = useState<Record<string, string>>({});
  const [pendingUserInputRequestsByThreadId, setPendingUserInputRequestsByThreadId] = useState<Record<string, WorkbenchUserInputRequest>>({});
  const [requestedSelection, setRequestedSelection] = useState<WorkbenchSelectionSearchParams>(() => {
    if (typeof window === "undefined") {
      return EMPTY_SELECTION;
    }

    return readCurrentSelectionFromUrl();
  });
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshot | null>(null);
  const [controls, setControls] = useState<WorkbenchControls | null>(null);
  const [harness, setHarness] = useState<WorkbenchHarness>(() => {
    if (typeof window === "undefined") {
      return "codex";
    }

    return readStoredHarness();
  });
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("explorer");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");
  const [quickOpenUpdatedAtByPath, setQuickOpenUpdatedAtByPath] = useState<Record<string, string>>({});
  const hasObservedInitialSelectionRef = useRef(false);
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
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const applyMatch = () => {
      setIsMobile(mediaQuery.matches);
      setMobilePane(getPreferredMobilePane(mediaQuery.matches));
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
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncUrlDrivenState = () => {
      const isMobileViewport = window.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false;

      startTransition(() => {
        setRequestedSelection(readCurrentSelectionFromUrl());
        setMobilePane(getPreferredMobilePane(isMobileViewport));
      });
    };

    syncUrlDrivenState();
    window.addEventListener("popstate", syncUrlDrivenState);
    window.addEventListener(CURRENT_SELECTION_URL_UPDATED_EVENT, syncUrlDrivenState as EventListener);
    return () => {
      window.removeEventListener("popstate", syncUrlDrivenState);
      window.removeEventListener(CURRENT_SELECTION_URL_UPDATED_EVENT, syncUrlDrivenState as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!controls) {
      return;
    }

    if (!hasObservedInitialSelectionRef.current) {
      hasObservedInitialSelectionRef.current = true;
      return;
    }

    if (requestedSelection.threadId) {
      if (currentThread?.id === requestedSelection.threadId) {
        return;
      }

      void controls.openThread(requestedSelection.threadId);
      return;
    }

    if (requestedSelection.filePath) {
      if (!currentThread && explorer.currentPath === requestedSelection.filePath) {
        return;
      }

      void controls.openFile(requestedSelection.filePath);
      return;
    }

    if (currentThread || explorer.currentPath) {
      controls.clearSelection();
    }
  }, [controls, currentThread, explorer.currentPath, requestedSelection.filePath, requestedSelection.threadId]);

  const expandedDirectories = new Set(explorer.expandedDirectories);
  const modifiedPaths = new Set(explorer.locallyModifiedPaths);

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

  const openFileFromExplorer = useCallback(async (path: string) => {
    if (isMobile) {
      setMobilePane("editor");
    }

    if (!requestedSelection.threadId && path === requestedSelection.filePath) {
      return;
    }

    syncCurrentSelectionToUrl({ filePath: path });
  }, [isMobile, requestedSelection.filePath, requestedSelection.threadId]);

  const openThreadFromExplorer = useCallback(async (threadId: string) => {
    if (isMobile) {
      setMobilePane("editor");
    }

    if (!requestedSelection.filePath && threadId === requestedSelection.threadId) {
      return;
    }

    syncCurrentSelectionToUrl({ threadId });
  }, [isMobile, requestedSelection.filePath, requestedSelection.threadId]);

  const sendThreadMessage = useCallback(async (threadId: string, input: UserInput[]) => {
    if (!controls) {
      return;
    }

    await controls.sendThreadMessage(threadId, input);
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

  const setThreadAgent = useCallback((threadId: string, agentPath: string | null) => {
    controls?.setCurrentThreadAgent(threadId, agentPath);
  }, [controls]);

  const showExampleQuestion = useCallback((threadId: string) => {
    if (!currentThread || currentThread.id !== threadId) {
      return;
    }

    setComposerInfoMessagesByThreadId((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setPendingUserInputRequestsByThreadId((current) => ({
      ...current,
      [threadId]: createDemoUserInputRequest(currentThread),
    }));
  }, [currentThread]);

  const clearUserInputRequest = useCallback((threadId: string) => {
    setPendingUserInputRequestsByThreadId((current) => {
      if (!current[threadId]) {
        return current;
      }

      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setComposerInfoMessagesByThreadId((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);

  const submitUserInputRequest = useCallback(async (threadId: string, response: WorkbenchUserInputResponse) => {
    const request = pendingUserInputRequestsByThreadId[threadId];
    if (!request) {
      return;
    }

    setPendingUserInputRequestsByThreadId((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setComposerInfoMessagesByThreadId((current) => ({
      ...current,
      [threadId]: formatDemoUserInputResponse(request, response),
    }));
  }, [pendingUserInputRequestsByThreadId]);

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
  ])).slice(0, 8);
  const showThreadView = Boolean(requestedSelection.threadId);
  const showFileView = !showThreadView && Boolean(requestedSelection.filePath);
  const showEmptyState = !showThreadView && !showFileView;
  const isThreadViewReady = showThreadView && currentThread?.id === requestedSelection.threadId;
  const isFileViewReady = showFileView && !currentThread && explorer.currentPath === requestedSelection.filePath;
  const isSelectionPending = (showThreadView && !isThreadViewReady) || (showFileView && !isFileViewReady);
  const activeThreadId = showThreadView ? requestedSelection.threadId : "";
  const activeFilePath = showFileView ? requestedSelection.filePath : "";

  useEffect(() => {
    if (!showEmptyState || !quickOpenPaths.length) {
      return;
    }

    let cancelled = false;

    void Promise.all(quickOpenPaths.map(async (path) => {
      const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { cache: "no-store" });
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
  }, [quickOpenPaths, showEmptyState]);

  const handleHarnessChange = (nextHarness: WorkbenchHarness) => {
    if (nextHarness === harness && currentThread?.harness === nextHarness) {
      return;
    }

    persistHarness(nextHarness);
    setHarness(nextHarness);
    controls?.setDraftThreadHarness(nextHarness);
  };

  const clearSelectionFromUi = useCallback(() => {
    syncCurrentSelectionToUrl({});
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

    if (isMobile) {
      setMobilePane("editor");
    }
  }, [controls, isMobile]);

  const handleCreateEntry = async (type: "directory" | "file") => {
    if (!controls || isCreatingEntry) {
      return;
    }

    setIsCreatingEntry(true);
    setCreateDialogError("");
    try {
      await controls.createEntry(createDialogParentPath, createEntryName, type);
      setIsCreatingEntry(false);

      closeCreateDialog();
      if (isMobile && type === "file") {
        setMobilePane("editor");
      }
    } catch (error) {
      setIsCreatingEntry(false);
      setCreateDialogError(error instanceof Error ? error.message : `Couldn't create the ${type === "file" ? "file" : "folder"}.`);
    }
  };

  return (
    <div className="min-h-screen overflow-x-hidden md:grid md:grid-cols-[minmax(16rem,21rem)_1fr] md:items-start md:overflow-visible">
      <div
        className="mobile-workbench-track flex min-h-screen w-[200vw] transition-transform duration-200 ease-out md:contents md:w-auto md:transform-none"
        style={mobileTrackStyle}
      >
        <aside className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col overflow-hidden px-5 pb-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:px-6 md:py-5">
          <div className="explorer-scrollbar -ml-3 min-h-0 flex-1 overflow-y-auto pb-8 pl-2 pr-2 text-[0.95rem] leading-6">
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
                  onCreateThread={() => {
                    controls?.createThread(harness);
                    if (isMobile) {
                      setMobilePane("editor");
                    }
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
                  className="m-0 rounded-lg px-2 py-1.5 text-base font-semibold leading-tight text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:-ml-2 md:py-0.5"
                  onClick={() => {
                    clearSelectionFromUi();
                  }}
                >
                  Project
                </button>
                <button
                  type="button"
                  aria-label="Create in project"
                  title="Create in project"
                  className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}`}
                  onClick={() => {
                    openCreateDialog("");
                  }}
                >
                  <NewEntryIcon />
                  <span className="sr-only">Create in project</span>
                </button>
              </div>
              <nav id="file-tree" aria-label="Project files">
                <ExplorerTree
                  changes={explorer.changes}
                  controls={workbenchControls}
                  currentPath={activeFilePath}
                  expandedDirectories={expandedDirectories}
                  modifiedPaths={modifiedPaths}
                  nodes={explorer.tree}
                  onCreateInDirectory={openCreateDialog}
                  onOpenFile={(path) => {
                    void openFileFromExplorer(path);
                  }}
                />
              </nav>
            </section>
          </div>
        </aside>

        <main className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col px-5 pb-5 md:w-auto md:px-6 md:pb-5">
          <header className="relative sticky top-0 z-10 py-3" hidden={showEmptyState}>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-10 mx-auto hidden w-full max-w-[58rem] bg-[linear-gradient(to_bottom,var(--bg)_50%,transparent)] md:block"
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
                    syncCurrentSelectionToUrl({});
                    setMobilePane("explorer");
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

          <section className="relative min-h-0 flex-1" aria-busy={isSelectionPending}>
            {showThreadView ? (
              isThreadViewReady && currentThread ? (
                <ThreadView
                  composerInfoMessage={composerInfoMessagesByThreadId[currentThread.id] ?? ""}
                  thread={currentThread}
                  fontSizeRem={explorer.fontSize}
                  onClearUserInputRequest={clearUserInputRequest}
                  onDraftHarnessChange={handleHarnessChange}
                  onListModels={listThreadModels}
                  onOpenFile={openFileFromExplorer}
                  onSendMessage={sendThreadMessage}
                  onShowExampleQuestion={showExampleQuestion}
                  onSubmitUserInputRequest={submitUserInputRequest}
                  onThreadAgentChange={setThreadAgent}
                  onThreadReasoningEffortChange={setThreadReasoningEffort}
                  onThreadModelChange={setThreadModel}
                  pendingUserInputRequest={pendingUserInputRequestsByThreadId[currentThread.id] ?? null}
                  projectRootPath={explorer.rootPath}
                  rateLimits={rateLimits}
                />
              ) : (
                <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                  <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                    <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">Thread</p>
                    <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Loading thread...</p>
                    <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{requestedSelection.threadId}</p>
                  </div>
                </div>
              )
            ) : null}
            {showEmptyState ? (
              <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                <div className="flex w-full max-w-[42rem] flex-col gap-8">
                  <button
                    type="button"
                    className="inline-flex w-fit items-center gap-2 rounded-full bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] px-4 py-2 text-[0.84rem] font-medium text-[var(--bg)] transition hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]"
                    onClick={() => {
                      controls?.createThread(harness);
                      if (isMobile) {
                        setMobilePane("editor");
                      }
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
            {showFileView && !isFileViewReady ? (
              <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[56rem] items-center justify-center py-8">
                <div className="shadow-float flex min-w-[16rem] flex-col gap-2 rounded-[1.4rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] px-5 py-4 text-left">
                  <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">File</p>
                  <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Loading file...</p>
                  <p className="m-0 break-all text-[0.84rem] leading-6 text-muted">{requestedSelection.filePath}</p>
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
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            b
          </button>
          <button
            data-command="italic"
            type="button"
            title="Italic"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            i
          </button>
          <button
            data-command="inline-code"
            type="button"
            title="Inline code"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            code
          </button>
          <button
            data-command="comment"
            type="button"
            title="Inline comment"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            note
          </button>
          <button
            data-command="del"
            type="button"
            title="Deleted text"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            del
          </button>
          <button
            data-command="ins"
            type="button"
            title="Inserted text"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            ins
          </button>
        </div>
        <div className={workbenchFloatingToolbarGroupClassName} data-toolbar-group="block">
          <button
            data-command="h1"
            type="button"
            title="Heading 1"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            h1
          </button>
          <button
            data-command="h2"
            type="button"
            title="Heading 2"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            h2
          </button>
          <button
            data-command="unordered-list"
            type="button"
            title="Bullets"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            ul
          </button>
          <button
            data-command="ordered-list"
            type="button"
            title="Numbers"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            ol
          </button>
          <button
            data-command="quote"
            type="button"
            title="Quote"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
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
          className="min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
        >
          accept
        </button>
        <button
          id="revision-hover-reject"
          ref={revisionHoverRejectButtonRef}
          type="button"
          title="Reject revision"
          className="min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
        >
          reject
        </button>
      </div>
    </div>
  );
}
