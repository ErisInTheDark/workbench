"use client";

import { startTransition, useCallback, useEffect, useMemo, useState } from "react";

import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
  ExplorerSnapshot,
  ThreadPayload,
  WorkbenchControls,
} from "../lib/types";
import {
  getPreferredMobilePane,
  MOBILE_MEDIA_QUERY,
  syncCurrentSelectionSearchParams,
  type MobilePane,
} from "../lib/workbench/mobile-pane-url-state";
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
  ZoomOutIcon,
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

export default function Workbench () {
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [currentThread, setCurrentThread] = useState<ThreadPayload | null>(null);
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
        onCurrentThreadChange: (thread) => {
          if (cancelled) {
            return;
          }

          startTransition(() => {
            setCurrentThread(thread);
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

  const openFileFromExplorer = useCallback(async (path: string) => {
    if (!controls) {
      return;
    }

    await controls.openFile(path);
    if (isMobile) {
      setMobilePane("editor");
    }
  }, [controls, isMobile]);

  const openThreadFromExplorer = useCallback(async (threadId: string) => {
    if (!controls) {
      return;
    }

    await controls.openThread(threadId);
    if (isMobile) {
      setMobilePane("editor");
    }
  }, [controls, isMobile]);

  const sendThreadMessage = useCallback(async (threadId: string, input: UserInput[]) => {
    if (!controls) {
      return;
    }

    await controls.sendThreadMessage(threadId, input);
  }, [controls]);

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
              {explorer.threads.length ? (
                <nav aria-label="Codex threads">
                  <ThreadsList
                    currentThreadId={explorer.currentThreadId}
                    nodes={explorer.threads}
                    onOpenThread={(threadId) => {
                      void openThreadFromExplorer(threadId);
                    }}
                  />
                </nav>
              ) : explorer.threadsError ? (
                <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted">
                  {explorer.threadsError}
                </p>
              ) : null}
            </section>

            <section className="space-y-2">
              <div className="group/entry-row flex items-center justify-between gap-3 pr-2 md:pr-4.5">
                <p className="m-0 text-base font-semibold leading-tight">Project</p>
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
            </section>
          </div>
        </aside>

        <main className="flex min-h-screen w-screen min-w-0 shrink-0 flex-col px-5 pb-5 md:w-auto md:px-6 md:pb-5">
          <header className="relative sticky top-0 z-10 py-3">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-10 mx-auto hidden w-full max-w-[58rem] bg-[linear-gradient(to_bottom,var(--bg)_50%,transparent)] md:block"
            />
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
                  className={`${workbenchIconButtonClassName} shrink-0 md:hidden`}
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
                    className={workbenchIconButtonClassName}
                  >
                    <ZoomOutIcon />
                    <span className="sr-only">Decrease editor text size</span>
                  </button>
                  <button
                    id="zoom-in"
                    type="button"
                    title="Increase editor text size"
                    aria-label="Increase editor text size"
                    className={workbenchIconButtonClassName}
                  >
                    <ZoomInIcon />
                    <span className="sr-only">Increase editor text size</span>
                  </button>
                </div>
                <div className="flex items-center gap-1.5" hidden={Boolean(currentThread)}>
                  <button
                    id="save-file"
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

          <section className="min-h-0 flex-1">
            {currentThread ? (
              <ThreadView
                thread={currentThread}
                fontSizeRem={explorer.fontSize}
                onOpenFile={openFileFromExplorer}
                onSendMessage={sendThreadMessage}
                projectRootPath={explorer.rootPath}
              />
            ) : null}
            <div
              className="editor-shell relative mx-auto grid w-[calc(100%+1.25rem)] md:w-full grid-cols-[0.72rem_minmax(0,1fr)] gap-[0.53rem] md:max-w-[calc(56rem+2.5rem)] md:grid-cols-[1.25rem_minmax(0,56rem)] md:gap-3 -ml-5 md:ml-auto"
              hidden={Boolean(currentThread)}
            >
              <div
                id="editor-diff-gutter"
                className={workbenchDiffGutterClassName}
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
        className={workbenchRevisionHoverToolbarClassName}
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
