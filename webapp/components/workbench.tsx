"use client";

import { startTransition, useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  ChangeSummary,
  ExplorerSnapshot,
  ThreadSummary,
  TreeNode,
  WorkbenchControls,
} from "../lib/types";

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  root: "Project",
  tree: [],
  threads: [],
  changes: {},
  currentPath: "",
  currentThreadId: "",
  expandedDirectories: [""],
  locallyModifiedPaths: [],
  threadsError: "",
};

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";
type MobilePane = "editor" | "explorer";
const FILE_SEARCH_PARAM = "file";
const THREAD_SEARCH_PARAM = "thread";

function getCurrentSelectionSearchParams () {
  if (typeof window === "undefined") {
    return {
      filePath: "",
      threadId: "",
    };
  }

  try {
    const url = new URL(window.location.href);
    return {
      filePath: url.searchParams.get(FILE_SEARCH_PARAM) ?? "",
      threadId: url.searchParams.get(THREAD_SEARCH_PARAM) ?? "",
    };
  } catch {
    return {
      filePath: "",
      threadId: "",
    };
  }
}

function syncCurrentSelectionSearchParams ({
  filePath = "",
  threadId = "",
}: {
  filePath?: string;
  threadId?: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const url = new URL(window.location.href);
    if (filePath) {
      url.searchParams.set(FILE_SEARCH_PARAM, filePath);
    } else {
      url.searchParams.delete(FILE_SEARCH_PARAM);
    }

    if (threadId) {
      url.searchParams.set(THREAD_SEARCH_PARAM, threadId);
    } else {
      url.searchParams.delete(THREAD_SEARCH_PARAM);
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  } catch {
    // Ignore URL update failures and keep the workbench usable.
  }
}

function getPreferredMobilePane (isMobileViewport: boolean): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  const { filePath, threadId } = getCurrentSelectionSearchParams();
  return filePath || threadId ? "editor" : "explorer";
}

function SaveIcon () {
  return (
    <span className="relative block size-5">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="save-icon-main size-5">
        <path d="M15.5 17.5H4.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1H14l2.5 2.5V16.5a1 1 0 0 1-1 1z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7.5 2.5v5h5v-5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.5 12h9v5.5h-9z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* the slash only shows when saving is not currently possible */}
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        aria-hidden="true"
        className="save-icon-slash pointer-events-none absolute inset-0 size-5 opacity-0 transition-opacity"
      >
        <path d="M3.5 16.5L16.5 3.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function BinIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M3.5 6.5H16.5" strokeLinecap="round" />
      <path d="M8.5 3.5H11.5C11.78 3.5 12 3.72 12 4V6.5H8V4C8 3.72 8.22 3.5 8.5 3.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 6.5L6.5 16C6.56 16.56 7.04 17 7.6 17H12.4C12.96 17 13.44 16.56 13.5 16L14.5 6.5H5.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 9V14M11.5 9V14" strokeLinecap="round" />
    </svg>
  );
}

function ZoomOutIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M5.75 8.75H11.75" strokeLinecap="round" />
      <path d="M14 14L17.5 17.5" strokeLinecap="round" />
    </svg>
  );
}

function ZoomInIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M8.75 5.75V11.75M5.75 8.75H11.75" strokeLinecap="round" />
      <path d="M14 14L17.5 17.5" strokeLinecap="round" />
    </svg>
  );
}

function BackArrowIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M12.75 4.75L7.25 10L12.75 15.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.75 10H16.25" strokeLinecap="round" />
    </svg>
  );
}

function NewEntryIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M6 2.75H11.75L15.5 6.5V16.25C15.5 16.94 14.94 17.5 14.25 17.5H6C5.31 17.5 4.75 16.94 4.75 16.25V4C4.75 3.31 5.31 2.75 6 2.75Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.75 2.75V6.5H15.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.125 9V14M7.625 11.5H12.625" strokeLinecap="round" />
    </svg>
  );
}

function ExplorerChevronIcon ({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      data-role="tree-chevron"
      className="shrink-0 transition-transform mt-0.5"
      style={{
        width: "1.1rem",
        height: "1.1rem",
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <path d="M7 5.75 12 10 7 14.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExplorerModifiedDot ({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      data-role="tree-modified"
      hidden={hidden}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#d0ad12] dark:bg-[#ffd84d]"
      aria-hidden="true"
    />
  );
}

function ExplorerFileSpacer () {
  return (
    <span
      data-role="tree-spacer"
      className="shrink-0"
      style={{ width: "1.1rem", height: "1.1rem" }}
      aria-hidden="true"
    />
  );
}

function ThreadsList ({
  currentThreadId,
  nodes,
  onOpenThread,
}: {
  currentThreadId: string;
  nodes: ThreadSummary[];
  onOpenThread: (threadId: string) => void;
}) {
  return (
    <ul className="m-0 p-0">
      {nodes.map((thread) => {
        const label = thread.name || thread.preview || thread.id;
        const isCurrent = thread.id === currentThreadId;

        return (
          <li key={thread.id} className="m-0 list-none">
            <button
              type="button"
              className={`inline-flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1${isCurrent ? " text-accent" : " text-muted"}`}
              onClick={() => {
                onOpenThread(thread.id);
              }}
            >
              <span className={`min-w-0 truncate ${isCurrent ? "font-semibold" : ""}`}>{label}</span>
              <span className="min-w-0 truncate text-[0.78rem] leading-5 opacity-80">
                {thread.status} · {thread.source}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const dialogButtonClassName = "rounded-xl px-3 py-1.5 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none";

interface WorkbenchDialogProps {
  actions: ReactNode;
  children: ReactNode;
  eyebrow: string;
  id: string;
  isOpen?: boolean;
  onBackdropClick?: () => void;
  summaryId?: string;
  title: string;
  titleId: string;
}

function WorkbenchDialog ({
  actions,
  children,
  eyebrow,
  id,
  isOpen,
  onBackdropClick,
  summaryId,
  title,
  titleId,
}: WorkbenchDialogProps) {
  return (
    <div
      id={id}
      hidden={typeof isOpen === "boolean" ? !isOpen : true}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      data-workbench-dialog="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_74%,transparent)] px-5 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onBackdropClick?.();
        }
      }}
    >
      <div className="w-full max-w-md rounded-[1.4rem] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-5 py-4 shadow-float">
        <p className="m-0 text-[0.84rem] tracking-[0.02em] text-muted">{eyebrow}</p>
        <h2 id={titleId} className="mt-0.5 text-base font-semibold leading-tight">
          {title}
        </h2>
        {children}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {actions}
        </div>
      </div>
    </div>
  );
}

function describeChange (filePath: string, changes: Record<string, ChangeSummary>) {
  const entry = changes[filePath];
  if (!entry) {
    return "";
  }

  const parts = [];
  if (entry.additions) {
    parts.push(`+${entry.additions}`);
  }
  if (entry.deletions) {
    parts.push(`-${entry.deletions}`);
  }
  return parts.join(" ");
}

function hasModifiedDescendant (node: TreeNode, modifiedPaths: Set<string>): boolean {
  if (node.type === "file") {
    return modifiedPaths.has(node.path);
  }

  return node.children.some((child) => hasModifiedDescendant(child, modifiedPaths));
}

interface ExplorerTreeProps {
  changes: Record<string, ChangeSummary>;
  controls: WorkbenchControls | null;
  currentPath: string;
  expandedDirectories: Set<string>;
  modifiedPaths: Set<string>;
  nested?: boolean;
  nodes: TreeNode[];
  onCreateInDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}

function ExplorerTree ({
  changes,
  controls,
  currentPath,
  expandedDirectories,
  modifiedPaths,
  nested = false,
  nodes,
  onCreateInDirectory,
  onOpenFile,
}: ExplorerTreeProps) {
  return (
    <ul
      className={`m-0 p-0${nested ? " ml-4" : ""}`}
      data-role={nested ? "tree-group-nested" : "tree-group-root"}
    >
      {nodes.map((node) => {
        if (node.type === "directory") {
          const isExpanded = expandedDirectories.has(node.path);
          const isModified = hasModifiedDescendant(node, modifiedPaths);

          return (
            <li
              key={`${node.type}:${node.path}`}
              className="m-0 list-none"
              data-path={node.path}
              data-tree-key={`${node.type}:${node.path}`}
              data-tree-type={node.type}
            >
              <div className="tree-folder-row flex min-w-0 items-center gap-2 justify-between">
                <button
                  data-role="tree-button"
                  type="button"
                  className="inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-0.5"
                  onClick={() => {
                    controls?.toggleDirectory(node.path);
                  }}
                >
                  <ExplorerChevronIcon expanded={isExpanded} />
                  <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                  <ExplorerModifiedDot hidden={!isModified} />
                </button>
                <button
                  type="button"
                  aria-label={`Create in ${node.name}`}
                  title={`Create in ${node.name}`}
                  className="new-entry-button ui-icon-button shrink-0"
                  onClick={() => {
                    onCreateInDirectory?.(node.path);
                  }}
                >
                  <NewEntryIcon />
                  <span className="sr-only">{`Create in ${node.name}`}</span>
                </button>
              </div>
              {isExpanded ? (
                <ExplorerTree
                  changes={changes}
                  controls={controls}
                  currentPath={currentPath}
                  expandedDirectories={expandedDirectories}
                  modifiedPaths={modifiedPaths}
                  nested
                  nodes={node.children}
                  onCreateInDirectory={onCreateInDirectory}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </li>
          );
        }

        const change = describeChange(node.path, changes);
        const isModified = modifiedPaths.has(node.path);
        const isCurrent = node.path === currentPath;

        return (
          <li
            key={`${node.type}:${node.path}`}
            className="m-0 list-none"
            data-path={node.path}
            data-tree-key={`${node.type}:${node.path}`}
            data-tree-type={node.type}
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                data-role="tree-button"
                type="button"
                className={`inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-0.5${isCurrent ? " font-semibold text-accent" : ""}`}
                onClick={() => {
                  if (onOpenFile) {
                    onOpenFile(node.path);
                    return;
                  }

                  void controls?.openFile(node.path);
                }}
              >
                <ExplorerFileSpacer />
                <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                <ExplorerModifiedDot hidden={!isModified} />
                <span
                  data-role="tree-change"
                  hidden={!change}
                  className="shrink-0 text-[0.8rem] text-muted"
                >
                  {change}
                </span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function Workbench () {
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [controls, setControls] = useState<WorkbenchControls | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("explorer");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createDialogParentPath, setCreateDialogParentPath] = useState("");
  const [createEntryName, setCreateEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [createDialogError, setCreateDialogError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => { };

    import("../lib/workbench-client").then(async ({ initWorkbench }) => {
      const nextCleanup = await initWorkbench({
        onExplorerStateChange: (snapshot) => {
          if (cancelled) {
            return;
          }

          startTransition(() => {
            setExplorer(snapshot);
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

    return () => {
      cancelled = true;
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

    const syncPaneFromUrl = () => {
      setMobilePane(getPreferredMobilePane(window.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false));
    };

    window.addEventListener("popstate", syncPaneFromUrl);
    return () => {
      window.removeEventListener("popstate", syncPaneFromUrl);
    };
  }, []);

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
  const openFileFromExplorer = async (path: string) => {
    if (!controls) {
      return;
    }

    await controls.openFile(path);
    if (isMobile) {
      setMobilePane("editor");
    }
  };
  const openThreadFromExplorer = async (threadId: string) => {
    if (!controls) {
      return;
    }

    await controls.openThread(threadId);
    if (isMobile) {
      setMobilePane("editor");
    }
  };

  const workbenchControls = useMemo<WorkbenchControls | null>(() => {
    if (!controls) {
      return null;
    }

    return {
      ...controls,
      openFile: openFileFromExplorer,
      openThread: openThreadFromExplorer,
    };
  }, [controls, isMobile]);

  const mobileTrackStyle = isMobile
    ? { transform: mobilePane === "explorer" ? "translateX(0)" : "translateX(-50%)" }
    : undefined;
  const createDialogParentLabel = createDialogParentPath || "project";
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
        <aside className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col px-5 pb-5 md:sticky md:top-0 md:h-screen md:w-auto md:self-start md:px-6 md:py-5">
          <div className="tree-folder-row flex items-center justify-between gap-3 pr-2 md:pr-4.5">
            <p className="m-0 text-base font-semibold leading-tight">Threads</p>
          </div>
          {explorer.threads.length ? (
            <nav
              className="explorer-scrollbar max-h-56 overflow-y-auto pb-6 pr-2 text-[0.95rem] leading-6 -ml-3"
              aria-label="Codex threads"
            >
              <ThreadsList
                currentThreadId={explorer.currentThreadId}
                nodes={explorer.threads}
                onOpenThread={(threadId) => {
                  void openThreadFromExplorer(threadId);
                }}
              />
            </nav>
          ) : explorer.threadsError ? (
            <p className="pb-6 pr-2 text-[0.84rem] leading-6 text-muted">
              {explorer.threadsError}
            </p>
          ) : null}

          <div className="tree-folder-row flex items-center justify-between gap-3 pr-2 md:pr-4.5">
            <p className="m-0 text-base font-semibold leading-tight">Project</p>
            <button
              type="button"
              aria-label="Create in project"
              title="Create in project"
              className="new-entry-button ui-icon-button p-0 shrink-0"
              onClick={() => {
                openCreateDialog("");
              }}
            >
              <NewEntryIcon />
              <span className="sr-only">Create in project</span>
            </button>
          </div>
          <nav
            id="file-tree"
            className="explorer-scrollbar min-h-0 flex-1 overflow-y-auto pb-8 pr-2 text-[0.95rem] leading-6 -ml-3"
            aria-label="Project files"
          >
            <ExplorerTree
              changes={explorer.changes}
              controls={workbenchControls}
              currentPath={explorer.currentPath}
              expandedDirectories={expandedDirectories}
              modifiedPaths={modifiedPaths}
              nodes={explorer.tree}
              onCreateInDirectory={openCreateDialog}
              onOpenFile={(path) => {
                void openFileFromExplorer(path);
              }}
            />
          </nav>
        </aside>

        <main
          className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col px-5 pb-5 md:w-auto md:px-6 md:pb-5"
        >
          <header className="ui-sticky-header sticky top-0 z-10 py-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="order-2 min-w-0 md:order-1">
                <p id="file-path" className="truncate text-base font-semibold leading-tight">
                  Select a file
                </p>
                <p id="status-line" className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted">
                  Markdown files open as rich text. Save with Ctrl/Cmd+S.
                </p>
              </div>
              <div className="order-1 flex items-center justify-between gap-3 md:order-2 md:flex-none md:justify-end">
                <button
                  type="button"
                  aria-label="Back to file explorer"
                  title="Back to file explorer"
                  hidden={!isMobile || mobilePane !== "editor"}
                  className="ui-icon-button shrink-0 md:hidden"
                  onClick={() => {
                    syncCurrentSelectionSearchParams({});
                    setMobilePane("explorer");
                  }}
                >
                  <BackArrowIcon />
                  <span className="sr-only">Back to file explorer</span>
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    id="zoom-out"
                    type="button"
                    title="Decrease editor text size"
                    aria-label="Decrease editor text size"
                    className="ui-icon-button"
                  >
                    <ZoomOutIcon />
                    <span className="sr-only">Decrease editor text size</span>
                  </button>
                  <button
                    id="zoom-in"
                    type="button"
                    title="Increase editor text size"
                    aria-label="Increase editor text size"
                    className="ui-icon-button"
                  >
                    <ZoomInIcon />
                    <span className="sr-only">Increase editor text size</span>
                  </button>
                  <button
                    id="save-file"
                    type="button"
                    title="Save current file"
                    aria-label="Save current file"
                    className="ui-icon-button group"
                    data-invalid="false"
                  >
                    <SaveIcon />
                    <span className="sr-only">Save current file</span>
                  </button>
                  <button
                    id="reset-draft"
                    type="button"
                    title="Discard the current draft"
                    aria-label="Discard the current draft"
                    className="ui-icon-button"
                  >
                    <BinIcon />
                    <span className="sr-only">Discard the current draft</span>
                  </button>
                </div>
              </div>
            </div>
          </header>

          <section className="min-h-0 flex-1">
            <div className="editor-shell relative mx-auto grid w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem_minmax(0,1fr)] gap-[0.53rem] md:max-w-[calc(56rem+2.5rem)] md:grid-cols-[1.25rem_minmax(0,56rem)] md:gap-3 -ml-5 md:ml-auto">
              <div
                id="editor-diff-gutter"
                className="editor-diff-gutter opacity-50"
                aria-hidden="true"
              />
              <div
                id="editor"
                className="editor-content min-h-[calc(100vh-6rem)] pb-16 font-serif text-[1.08rem] leading-[1.72] whitespace-normal outline-none"
                contentEditable
                suppressContentEditableWarning
                spellCheck
                data-placeholder="Select a markdown file to start editing."
              />
              <div
                id="editor-custom-caret"
                className="editor-custom-caret"
                aria-hidden="true"
                hidden
              />
            </div>
          </section>

          <WorkbenchDialog
            id="save-conflict-dialog"
            titleId="save-conflict-title"
            summaryId="save-conflict-summary"
            eyebrow="Write conflict"
            title="This file changed on disk"
            actions={
              <>
                <button
                  id="save-conflict-keep-editing"
                  type="button"
                  className={dialogButtonClassName}
                >
                  Keep editing
                </button>
                <button
                  id="save-conflict-reload"
                  type="button"
                  className={dialogButtonClassName}
                >
                  Reload from disk
                </button>
                <button
                  id="save-conflict-overwrite"
                  type="button"
                  className={dialogButtonClassName}
                >
                  Overwrite anyway
                </button>
              </>
            }
          >
            <>
              <p id="save-conflict-summary" className="mt-3 text-sm leading-6 text-muted">
                Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.
              </p>
              <p id="save-conflict-expected" className="mt-3 text-[0.84rem] tracking-[0.02em] text-muted" />
              <p id="save-conflict-actual" className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted" />
            </>
          </WorkbenchDialog>

          <WorkbenchDialog
            id="reset-draft-dialog"
            titleId="reset-draft-title"
            summaryId="reset-draft-summary"
            eyebrow="Discard draft"
            title="Reset this draft?"
            actions={
              <>
                <button
                  id="reset-draft-cancel"
                  type="button"
                  className={dialogButtonClassName}
                >
                  Cancel
                </button>
                <button
                  id="reset-draft-head"
                  type="button"
                  className={dialogButtonClassName}
                >
                  Reset to HEAD
                </button>
                <button
                  id="reset-draft-saved"
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
        className="fixed left-0 top-0 z-30 flex flex-wrap items-start justify-center gap-1 rounded-[1.4rem] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] p-1 shadow-float backdrop-blur-xl"
        hidden
      >
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-1" data-toolbar-group="inline">
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
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-1" data-toolbar-group="block">
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
        className="fixed left-0 top-0 z-30 flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] p-1 shadow-float backdrop-blur-xl"
        hidden
      >
        <button
          id="revision-hover-accept"
          type="button"
          title="Accept revision"
          className="min-w-8 rounded-full px-3 py-1 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
        >
          accept
        </button>
        <button
          id="revision-hover-reject"
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
