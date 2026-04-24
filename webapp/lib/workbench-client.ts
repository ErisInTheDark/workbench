/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, polling, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, polling.
 */
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, getCurrentTurn } from "./codex/thread-state";
import type {
    ChangeSummary,
    CreateEntryPayload,
    ExplorerSnapshot,
    FilePayload,
    ProjectSnapshot,
    SaveConflictPayload,
    SaveFilePayload,
    ThreadPayload,
    ThreadSummary,
    TreeNode,
    WorkbenchBindings,
    WorkbenchControls,
} from "./types";
import {
    MAX_EDITOR_FONT_SIZE,
    MIN_EDITOR_FONT_SIZE,
    getRequestedPathFromUrl,
    getRequestedThreadIdFromUrl,
    persistExpandedDirectories,
    persistFontSize,
    readStoredExpandedDirectories,
    readStoredFontSize,
    syncCurrentSelectionToUrl,
} from "./workbench/browser-state";
import {
    escapeMarkdownText,
    formatBlockCommentLine,
    formatInlineCommentMarkdown,
    isBlockCommentLine,
    parseBlockCommentBody,
} from "./workbench/comment-markdown";
import {
    cloneEditHistory,
    cloneHistorySelection,
    countHistoryStatesSinceSnapshot,
    createHistoryPatch,
    createInitialEditHistory,
    materializeHistoryContent,
    mergeHistoryPatches,
    normalizeEditHistory,
    trimEditHistory,
    type EditHistorySelection,
    type EditHistorySelectionPoint,
    type EditHistoryState,
} from "./workbench/edit-history";
import {
    parseBlocks as parseMarkdownBlocks,
    markdownToHtml as renderMarkdownToHtml,
} from "./workbench/markdown-render";
import {
    formatTimestamp,
    getFirstFile,
    isMarkdownFile,
    isTextLikeFile
} from "./workbench/tree-utils";

type EditorMode = "rich" | "plain";

interface ParsedListItem {
  text: string;
  children: ParsedBlock[];
}

type ParsedBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "blockquote"; text: string }
  | { type: "ul"; items: ParsedListItem[] }
  | { type: "ol"; items: ParsedListItem[] }
  | { type: "list-break"; count: number }
  | { type: "break"; count: number }
  | { type: "hr" }
  | { type: "code"; language: string; text: string }
  | { type: "comment"; text: string }
  | { type: "paragraph"; text: string };

interface SaveGuardIssue {
  markdown: string;
  currentMarkup: string;
  roundTripMarkup: string;
}

interface DraftBuffer {
  baselineContent: string;
  content: string;
  dirty: boolean;
  editorState: string;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history: EditHistoryState;
  mode: EditorMode;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
}

interface PersistedDraftRecord {
  path: string;
  baselineContent: string;
  content: string;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history?: EditHistoryState | null;
  mode: EditorMode;
}

interface SerializedBlock {
  kind: "block" | "list";
  isComment: boolean;
  text: string;
}

type SerializedMarkdownToken =
  | { type: "block"; block: SerializedBlock }
  | { type: "break"; count: number };

type DiffMarkerSymbol = "+" | "-" | "*";
type RevisionHoverKind = "comment" | "del" | "ins";
type RevisionToolbarKind = RevisionHoverKind | "mixed";

interface DiffRow {
  path: string;
  signature: string;
}

interface DiffRowAnchor {
  path: string;
  element: HTMLElement;
}

interface DeletedMarkerPlacement {
  afterPath: string | null;
  beforePath: string | null;
}

interface DiffAnchorMetrics {
  bottom: number;
  center: number;
  top: number;
}

interface RevisionToolbarContext {
  kind: RevisionToolbarKind;
  nodes: HTMLElement[];
  rect: DOMRect;
}

interface CaretRenderContext {
  bold: boolean;
  italic: boolean;
  kind: "comment" | "default" | "code" | "del" | "ins";
  rect: DOMRect;
}

type PendingInlineFormatKey = "bold" | "italic" | "code" | "comment" | "del" | "ins";

interface PendingInlineFormats {
  bold: boolean;
  code: boolean;
  comment: boolean;
  del: boolean;
  ins: boolean;
  italic: boolean;
}

interface InlineMark {
  href?: string;
  tag: "a" | "code" | "comment" | "del" | "em" | "ins" | "strong";
}

type InlineLeaf =
  | { type: "text"; marks: InlineMark[]; text: string }
  | { type: "break"; marks: InlineMark[] }
  | { type: "marker"; role: "caret" | "selection-start" | "selection-end"; marks?: InlineMark[] };

interface WorkbenchState {
  baselineContent: string;
  changes: Record<string, ChangeSummary>;
  currentContent: string;
  currentPath: string;
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  draftBuffers: Map<string, DraftBuffer>;
  dirty: boolean;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history: EditHistoryState | null;
  root: string;
  rootPath: string;
  threads: ThreadSummary[];
  threadsError: string;
  tree: TreeNode[];
  mode: EditorMode;
  fontSize: number;
  lastLoggedSaveIssue: SaveGuardIssue | null;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
  expandedDirectories: Set<string>;
}

const EDITOR_FONT_STEP = 0.08;
const AUTO_REFRESH_INTERVAL_MS = 1500;
const DRAFT_DATABASE_NAME = "workbench";
const DRAFT_DATABASE_VERSION = 1;
const DRAFT_STORE_NAME = "drafts";
const HISTORY_KEYFRAME_INTERVAL = 50;
const REVISION_HOVER_PROXIMITY_PX = 18;
const INLINE_FORMAT_ORDER: Array<{ key: PendingInlineFormatKey; tagName: keyof HTMLElementTagNameMap }> = [
  { key: "bold", tagName: "strong" },
  { key: "italic", tagName: "em" },
  { key: "code", tagName: "code" },
  { key: "comment", tagName: "span" },
  { key: "del", tagName: "del" },
  { key: "ins", tagName: "ins" },
];
const INLINE_MARK_RANK: Record<InlineMark["tag"], number> = {
  a: 0,
  comment: 1,
  del: 2,
  ins: 3,
  em: 4,
  strong: 5,
  code: 6,
};

export async function initWorkbench(bindings: WorkbenchBindings = {}): Promise<() => void> {
  const state: WorkbenchState = {
    baselineContent: "",
    changes: {},
    currentContent: "",
    currentPath: "",
    currentThread: null,
    currentThreadId: "",
    draftBuffers: new Map(),
    dirty: false,
    expectedMtimeMs: null,
    headContent: null,
    history: null,
    root: "Project",
    rootPath: "",
    threads: [],
    threadsError: "",
    tree: [],
    mode: "rich",
    fontSize: readStoredFontSize(),
    lastLoggedSaveIssue: null,
    pendingWriteConflict: null,
    saveIssue: null,
    expandedDirectories: new Set(readStoredExpandedDirectories()),
  };

  const blockTags = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "UL",
    "OL",
    "PRE",
    "BLOCKQUOTE",
    "HR",
  ]);

  const editor = document.querySelector<HTMLDivElement>("#editor");
  const customCaret = document.querySelector<HTMLDivElement>("#editor-custom-caret");
  const diffGutter = document.querySelector<HTMLDivElement>("#editor-diff-gutter");
  const floatingToolbar = document.querySelector<HTMLDivElement>("#floating-toolbar");
  const revisionHoverToolbar = document.querySelector<HTMLDivElement>("#revision-hover-toolbar");
  const revisionHoverAcceptButton = document.querySelector<HTMLButtonElement>("#revision-hover-accept");
  const revisionHoverRejectButton = document.querySelector<HTMLButtonElement>("#revision-hover-reject");
  const filePathLabel = document.querySelector<HTMLElement>("#file-path");
  const resetDraftButton = document.querySelector<HTMLButtonElement>("#reset-draft");
  const saveFileButton = document.querySelector<HTMLButtonElement>("#save-file");
  const saveConflictDialog = document.querySelector<HTMLDivElement>("#save-conflict-dialog");
  const saveConflictSummary = document.querySelector<HTMLElement>("#save-conflict-summary");
  const saveConflictExpected = document.querySelector<HTMLElement>("#save-conflict-expected");
  const saveConflictActual = document.querySelector<HTMLElement>("#save-conflict-actual");
  const saveConflictKeepEditingButton = document.querySelector<HTMLButtonElement>("#save-conflict-keep-editing");
  const saveConflictReloadButton = document.querySelector<HTMLButtonElement>("#save-conflict-reload");
  const saveConflictOverwriteButton = document.querySelector<HTMLButtonElement>("#save-conflict-overwrite");
  const resetDraftDialog = document.querySelector<HTMLDivElement>("#reset-draft-dialog");
  const resetDraftCancelButton = document.querySelector<HTMLButtonElement>("#reset-draft-cancel");
  const resetDraftHeadButton = document.querySelector<HTMLButtonElement>("#reset-draft-head");
  const resetDraftSavedButton = document.querySelector<HTMLButtonElement>("#reset-draft-saved");
  const zoomOutButton = document.querySelector<HTMLButtonElement>("#zoom-out");
  const zoomInButton = document.querySelector<HTMLButtonElement>("#zoom-in");
  const statusLine = document.querySelector<HTMLElement>("#status-line");

  if (
    !editor ||
    !customCaret ||
    !diffGutter ||
    !floatingToolbar ||
    !revisionHoverToolbar ||
    !revisionHoverAcceptButton ||
    !revisionHoverRejectButton ||
    !filePathLabel ||
    !resetDraftButton ||
    !saveFileButton ||
    !saveConflictDialog ||
    !saveConflictSummary ||
    !saveConflictExpected ||
    !saveConflictActual ||
    !saveConflictKeepEditingButton ||
    !saveConflictReloadButton ||
    !saveConflictOverwriteButton ||
    !resetDraftDialog ||
    !resetDraftCancelButton ||
    !resetDraftHeadButton ||
    !resetDraftSavedButton ||
    !zoomOutButton ||
    !zoomInButton ||
    !statusLine
  ) {
    return () => {};
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  let autoRefreshTimeoutId: number | null = null;
  let autoRefreshStopped = false;
  let diffRefreshFrameId: number | null = null;
  let selectionPersistenceTimeoutId: number | null = null;
  let hoveredRevisionNode: HTMLElement | null = null;
  let activeRevisionNodes = new Set<HTMLElement>();
  let editorHasFocus = false;
  let isComposing = false;
  let pendingInlineFormats: PendingInlineFormats | null = null;
  let preservePendingInlineFormatSelectionChanges = 0;
  const draftDatabasePromise = openDraftDatabase();
  let draftPersistenceQueue = Promise.resolve();
  const editorShell = diffGutter.parentElement;

  if (!editorShell) {
    return () => {};
  }

  document.execCommand?.("defaultParagraphSeparator", false, "p");

  const dialogs = [saveConflictDialog, resetDraftDialog] as const;

  function isDialogOpen(dialog: HTMLDivElement) {
    return !dialog.hidden;
  }

  function hideDialog(dialog: HTMLDivElement) {
    dialog.hidden = true;
  }

  function showDialog(dialog: HTMLDivElement, focusTarget?: HTMLElement) {
    dialogs.forEach((currentDialog) => {
      if (currentDialog !== dialog) {
        hideDialog(currentDialog);
      }
    });

    dialog.hidden = false;
    if (focusTarget) {
      window.requestAnimationFrame(() => {
        focusTarget.focus();
      });
    }
  }

  function closeActiveDialog() {
    if (isDialogOpen(resetDraftDialog)) {
      hideDialog(resetDraftDialog);
      editor.focus();
      return true;
    }

    if (isDialogOpen(saveConflictDialog)) {
      hideDialog(saveConflictDialog);
      editor.focus();
      return true;
    }

    return false;
  }

  saveFileButton.addEventListener("click", async () => {
    await saveCurrentFile();
  }, { signal });

  resetDraftButton.addEventListener("click", () => {
    if (!state.currentPath) {
      return;
    }

    showDialog(resetDraftDialog, resetDraftCancelButton);
  }, { signal });

  zoomOutButton.addEventListener("click", () => {
    changeEditorFontSize(-EDITOR_FONT_STEP);
  }, { signal });

  zoomInButton.addEventListener("click", () => {
    changeEditorFontSize(EDITOR_FONT_STEP);
  }, { signal });

  saveConflictKeepEditingButton.addEventListener("click", () => {
    hideSaveConflictDialog();
    editor.focus();
  }, { signal });

  saveConflictReloadButton.addEventListener("click", async () => {
    hideSaveConflictDialog();
    if (!state.currentPath) {
      return;
    }
    await openFile(state.currentPath, { ignoreDirty: true, source: "reload" });
  }, { signal });

  saveConflictOverwriteButton.addEventListener("click", async () => {
    hideSaveConflictDialog();
    await saveCurrentFile({ force: true });
  }, { signal });

  resetDraftCancelButton.addEventListener("click", () => {
    hideResetDraftDialog();
    editor.focus();
  }, { signal });

  resetDraftSavedButton.addEventListener("click", async () => {
    await resetCurrentDraftToSaved();
  }, { signal });

  resetDraftHeadButton.addEventListener("click", async () => {
    await resetCurrentFileToHead();
  }, { signal });

  document.addEventListener("keydown", async (event) => {
    if (event.key === "Escape" && closeActiveDialog()) {
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier || event.key.toLowerCase() !== "s") {
      return;
    }

    event.preventDefault();
    await saveCurrentFile();
  }, { signal });

  editor.addEventListener("input", (event) => {
    const previousContent = state.currentContent;
    const transformedListItem = maybeTransformParagraphIntoListItem(event);
    const commentCaretMarker = maybeExpandBlockCommentStarter(event) ?? maybeActivateInlineCommentShortcut(event);
    syncStructuredBlockStyles();
    if (transformedListItem) {
      restoreListItemSelection([transformedListItem], { collapsed: true });
    }
    if (commentCaretMarker) {
      restoreCaretToMarker(commentCaretMarker);
    }
    inspectCurrentDraft();
    recordEditHistory(previousContent, state.currentContent, captureEditorSelection());
    syncCurrentDraftBuffer();
    scheduleDiffGutterRefresh();
    updateStatusLine();
    window.requestAnimationFrame(() => {
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
    });
  }, { signal });

  editor.addEventListener("beforeinput", (event) => {
    if (!(event instanceof InputEvent)) {
      return;
    }

    if (handlePendingInlineBeforeInput(event)) {
      return;
    }

    if (event.inputType === "historyUndo") {
      event.preventDefault();
      undoEditHistory();
      return;
    }

    if (event.inputType === "historyRedo") {
      event.preventDefault();
      redoEditHistory();
    }
  }, { signal });

  editor.addEventListener("keydown", async (event) => {
    if (!state.currentPath || state.mode !== "rich") {
      return;
    }

    if (pendingInlineFormats && shouldClearPendingInlineFormatsForKey(event)) {
      clearPendingInlineFormats();
    }

    if (event.key === "Tab") {
      if (handleListTab(event)) {
        return;
      }
    }

    if (event.key === "Backspace") {
      if (handleCommentBlockBackspace(event)) {
        return;
      }

      if (handleListItemBackspace(event)) {
        return;
      }
    }

    if (event.key === "Enter") {
      if (handleCommentBlockEnter(event)) {
        return;
      }

      if (handleEmptyListItemEnter(event)) {
        return;
      }
    }

    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier) {
      return;
    }

    if (!event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redoEditHistory();
      } else {
        undoEditHistory();
      }
      return;
    }

    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redoEditHistory();
      return;
    }

    if (event.key.toLowerCase() === "b") {
      event.preventDefault();
      runEditorCommand("bold");
      return;
    }

    if (event.key.toLowerCase() === "i") {
      event.preventDefault();
      runEditorCommand("italic");
      return;
    }

    if (event.code === "Backquote" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      wrapSelection("code");
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      wrapSelection("del");
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      wrapSelection("ins");
    }
  }, { signal });

  const refreshInlineToolbars = () => {
    window.requestAnimationFrame(() => {
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
    });
  };

  document.addEventListener("selectionchange", () => {
    if (pendingInlineFormats) {
      if (preservePendingInlineFormatSelectionChanges > 0) {
        preservePendingInlineFormatSelectionChanges -= 1;
      } else if (shouldPreservePendingInlineFormatsForSelection()) {
        updateCustomCaret();
      } else {
        clearPendingInlineFormats();
      }
    }

    updateHistorySelection(captureEditorSelection());
    scheduleSelectionPersistence();
    refreshInlineToolbars();
  }, { signal });

  document.addEventListener("touchend", refreshInlineToolbars, { signal, passive: true });
  document.addEventListener("pointerup", refreshInlineToolbars, { signal });

  editor.addEventListener("focus", () => {
    editorHasFocus = true;
    updateCustomCaret();
  }, { signal });

  editor.addEventListener("blur", () => {
    editorHasFocus = false;
    clearPendingInlineFormats();
    updateCustomCaret();
  }, { signal });

  editor.addEventListener("compositionstart", () => {
    isComposing = true;
    clearPendingInlineFormats();
    updateCustomCaret();
  }, { signal });

  editor.addEventListener("compositionend", () => {
    isComposing = false;
    window.requestAnimationFrame(updateCustomCaret);
  }, { signal });

  for (const dialog of dialogs) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        hideDialog(dialog);
      }
    }, { signal });
  }

  const preserveToolbarSelection = (event: Event) => {
    event.preventDefault();
  };

  floatingToolbar.addEventListener("mousedown", preserveToolbarSelection, { signal });
  floatingToolbar.addEventListener("pointerdown", preserveToolbarSelection, { signal });
  floatingToolbar.addEventListener("touchstart", preserveToolbarSelection, { signal, passive: false });

  revisionHoverToolbar.addEventListener("mousedown", preserveToolbarSelection, { signal });
  revisionHoverToolbar.addEventListener("pointerdown", preserveToolbarSelection, { signal });
  revisionHoverToolbar.addEventListener("touchstart", preserveToolbarSelection, { signal, passive: false });

  floatingToolbar.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-command]")
      : null;
    if (!button) {
      return;
    }

    editor.focus();
    applyToolbarCommand(button.dataset.command);
  }, { signal });

  revisionHoverAcceptButton.addEventListener("click", () => {
    applyHoveredRevisionAction("accept");
  }, { signal });

  revisionHoverRejectButton.addEventListener("click", () => {
    applyHoveredRevisionAction("reject");
  }, { signal });

  editor.addEventListener("click", (event) => {
    const summaryText = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-summary-text="true"]')
      : null;
    if (!summaryText || !editor.contains(summaryText)) {
      return;
    }

    const summary = summaryText.closest<HTMLElement>("summary");
    if (!summary) {
      return;
    }

    event.preventDefault();
    placeCaretInElement(summaryText, event.clientX, event.clientY);
  }, { signal });

  editor.addEventListener("pointerdown", () => {
    clearPendingInlineFormats();
  }, { signal });

  document.addEventListener("pointermove", (event) => {
    const revisionNode = event.target instanceof Element
      ? event.target.closest<HTMLElement>('del, ins, [data-inline-comment="true"], [data-block-comment="true"]')
      : null;
    if (revisionNode && editor.contains(revisionNode)) {
      setHoveredRevisionNode(revisionNode);
      return;
    }

    if (!isPointerNearRevisionHoverUi(event.clientX, event.clientY)) {
      setHoveredRevisionNode(null);
    }
  }, { signal });

  editor.addEventListener("toggle", (event) => {
    if (!(event.target instanceof HTMLDetailsElement)) {
      return;
    }

    scheduleDiffGutterRefresh();
  }, { capture: true, signal });

  window.addEventListener("resize", () => {
    scheduleDiffGutterRefresh();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }, { signal });

  window.addEventListener("scroll", () => {
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }, { signal });

  window.visualViewport?.addEventListener("resize", refreshInlineToolbars, { signal });
  window.visualViewport?.addEventListener("scroll", refreshInlineToolbars, { signal });

  window.addEventListener("beforeunload", (event) => {
    const hasMarkupMismatch = Boolean(state.saveIssue) || Array.from(state.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue));
    if (!hasMarkupMismatch) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  }, { signal });

  function wrapIndexedDbRequest<T>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("IndexedDB request failed."));
      };
    });
  }

  function waitForTransaction(transaction: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      };
    });
  }

  function openDraftDatabase() {
    if (typeof window.indexedDB === "undefined") {
      return Promise.resolve<IDBDatabase | null>(null);
    }

    return new Promise<IDBDatabase | null>((resolve) => {
      const request = window.indexedDB.open(DRAFT_DATABASE_NAME, DRAFT_DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          database.createObjectStore(DRAFT_STORE_NAME, { keyPath: "path" });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        resolve(null);
      };

      request.onblocked = () => {
        resolve(null);
      };
    });
  }

  async function getPersistedDraftRecords() {
    const database = await draftDatabasePromise;
    if (!database) {
      return [] as PersistedDraftRecord[];
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readonly");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.getAll();
    const result = await wrapIndexedDbRequest(request as IDBRequest<PersistedDraftRecord[]>);
    await waitForTransaction(transaction);
    return result;
  }

  async function putPersistedDraftRecord(record: PersistedDraftRecord) {
    const database = await draftDatabasePromise;
    if (!database) {
      return;
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.put(record));
    await waitForTransaction(transaction);
  }

  async function deletePersistedDraftRecord(filePath: string) {
    const database = await draftDatabasePromise;
    if (!database) {
      return;
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.delete(filePath));
    await waitForTransaction(transaction);
  }

  function enqueueDraftPersistence(operation: () => Promise<void>) {
    draftPersistenceQueue = draftPersistenceQueue
      .catch(() => {
        // Keep later persistence operations flowing after a transient failure.
      })
      .then(operation);

    return draftPersistenceQueue;
  }

  function updateHistorySelection(selection: EditHistorySelection | null) {
    if (!state.history?.frames.length) {
      return;
    }

    state.history.frames[state.history.currentIndex].selection = cloneHistorySelection(selection);
  }

  function scheduleSelectionPersistence() {
    if (!state.currentPath || !state.dirty) {
      return;
    }

    if (selectionPersistenceTimeoutId !== null) {
      window.clearTimeout(selectionPersistenceTimeoutId);
    }

    selectionPersistenceTimeoutId = window.setTimeout(() => {
      selectionPersistenceTimeoutId = null;
      syncCurrentDraftBuffer();
    }, 260);
  }

  function recordEditHistory(previousContent: string, nextContent: string, selection: EditHistorySelection | null) {
    if (previousContent === nextContent) {
      updateHistorySelection(selection);
      return;
    }

    const nextHistory = normalizeEditHistory(state.history, previousContent);
    if (nextHistory.currentIndex < nextHistory.frames.length - 1) {
      nextHistory.frames = nextHistory.frames.slice(0, nextHistory.currentIndex + 1);
    }

    const patch = createHistoryPatch(previousContent, nextContent);
    if (!patch) {
      state.history = nextHistory;
      updateHistorySelection(selection);
      return;
    }

    const timestamp = Date.now();
    const previousFrame = nextHistory.frames.at(-1);
    if (previousFrame?.type === "patch") {
      const mergedFrame = mergeHistoryPatches(previousFrame, patch, selection, timestamp);
      if (mergedFrame) {
        nextHistory.frames[nextHistory.frames.length - 1] = mergedFrame;
        nextHistory.currentIndex = nextHistory.frames.length - 1;
        state.history = trimEditHistory(nextHistory);
        return;
      }
    }

    const shouldCreateSnapshot = countHistoryStatesSinceSnapshot(nextHistory) >= HISTORY_KEYFRAME_INTERVAL - 1;
    nextHistory.frames.push(shouldCreateSnapshot
      ? {
        type: "snapshot",
        content: nextContent,
        selection: cloneHistorySelection(selection),
        timestamp,
      }
      : {
        type: "patch",
        patch,
        selection: cloneHistorySelection(selection),
        timestamp,
      });
    nextHistory.currentIndex = nextHistory.frames.length - 1;
    state.history = trimEditHistory(nextHistory);
  }

  function buildPersistedDraftRecord(filePath: string, buffer: DraftBuffer): PersistedDraftRecord {
    return {
      path: filePath,
      baselineContent: buffer.baselineContent,
      content: buffer.content,
      expectedMtimeMs: buffer.expectedMtimeMs,
      headContent: buffer.headContent,
      history: cloneEditHistory(buffer.history),
      mode: buffer.mode,
    };
  }

  function createEditorStateFromContent(content: string, mode: EditorMode) {
    return mode === "rich"
      ? renderMarkdownToHtml(content)
      : content;
  }

  function hydrateDraftBuffers(records: PersistedDraftRecord[]) {
    state.draftBuffers = new Map(
      records.map((record) => {
        const buffer: DraftBuffer = {
          baselineContent: record.baselineContent,
          content: record.content,
          dirty: record.content !== record.baselineContent,
          editorState: createEditorStateFromContent(record.content, record.mode),
          expectedMtimeMs: record.expectedMtimeMs,
          headContent: record.headContent ?? null,
          history: normalizeEditHistory(record.history ?? null, record.content),
          mode: record.mode,
          pendingWriteConflict: null,
          saveIssue: null,
        };

        return [record.path, buffer];
      }),
    );
  }

  function persistDraftBuffer(filePath: string, buffer: DraftBuffer | null) {
    return enqueueDraftPersistence(async () => {
      if (!buffer || !buffer.dirty) {
        await deletePersistedDraftRecord(filePath);
        return;
      }

      await putPersistedDraftRecord(buildPersistedDraftRecord(filePath, buffer));
    });
  }

  function describeChange(filePath: string) {
    const entry = state.changes[filePath];
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

  function isSingleBreakParagraph(element: HTMLElement) {
    if (element.tagName !== "P") {
      return false;
    }

    let breakCount = 0;

    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? "").trim()) {
          return false;
        }
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }

      const childElement = node as Element;
      if (childElement.tagName !== "BR") {
        return false;
      }

      breakCount += 1;
    }

    return breakCount === 1;
  }

  function getLastNonBreakBlock(blocks: ParsedBlock[]) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index].type !== "break" && blocks[index].type !== "list-break") {
        return blocks[index];
      }
    }

    return null;
  }

  function maybePushCommentBreak(blocks: ParsedBlock[], blankLineCount: number, nextBlockType: ParsedBlock["type"]) {
    if (!blankLineCount) {
      return;
    }

    const previousBlock = getLastNonBreakBlock(blocks);
    if (nextBlockType === "comment" || previousBlock?.type === "comment") {
      blocks.push({ type: "break", count: blankLineCount });
    }
  }

  function maybePushStandardBreak(
    blocks: ParsedBlock[],
    blankLineCount: number,
    nextBlockType: ParsedBlock["type"],
  ) {
    if (blankLineCount <= 1) {
      return;
    }

    const previousBlock = getLastNonBreakBlock(blocks);
    if (!previousBlock || previousBlock.type === "comment" || nextBlockType === "comment") {
      return;
    }

    const previousIsList = previousBlock.type === "ul" || previousBlock.type === "ol";
    const nextIsList = nextBlockType === "ul" || nextBlockType === "ol";
    if (previousIsList && nextIsList) {
      return;
    }

    blocks.push({ type: "break", count: blankLineCount - 1 });
  }

  function isListElement(element: Element) {
    return element.tagName === "UL" || element.tagName === "OL";
  }

  function getDirectChildListElements(element: Element) {
    return Array.from(element.children).filter((child): child is HTMLUListElement | HTMLOListElement => isListElement(child));
  }

  function getDirectChildDetailsElement(element: Element) {
    return Array.from(element.children).find((child): child is HTMLDetailsElement => child.tagName === "DETAILS");
  }

  function getDirectChildSummaryElement(element: Element) {
    return Array.from(element.children).find((child): child is HTMLElement => child.tagName === "SUMMARY");
  }

  function getDirectChildSummaryTextElement(element: Element) {
    return Array.from(element.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.summaryText === "true");
  }

  function ensureSummaryTextWrapper(summary: HTMLElement) {
    const existingWrapper = getDirectChildSummaryTextElement(summary);
    if (existingWrapper) {
      return existingWrapper;
    }

    const wrapper = document.createElement("span");
    wrapper.dataset.summaryText = "true";

    while (summary.firstChild) {
      wrapper.append(summary.firstChild);
    }

    if (!wrapper.childNodes.length) {
      wrapper.append(document.createElement("br"));
    }

    summary.append(wrapper);
    return wrapper;
  }

  function trimBoundaryBreaks(container: HTMLElement) {
    const hasMeaningfulContent = Array.from(container.childNodes).some((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean((node.textContent ?? "").trim());
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }

      return (node as Element).tagName !== "BR";
    });

    if (!hasMeaningfulContent) {
      return;
    }

    let firstMeaningfulNode = container.firstChild;
    while (
      firstMeaningfulNode?.nodeType === Node.TEXT_NODE
      && !(firstMeaningfulNode.textContent ?? "").trim()
    ) {
      firstMeaningfulNode = firstMeaningfulNode.nextSibling;
    }
    while (firstMeaningfulNode instanceof HTMLBRElement) {
      const nextNode = firstMeaningfulNode.nextSibling;
      firstMeaningfulNode.remove();
      firstMeaningfulNode = nextNode;
      while (
        firstMeaningfulNode?.nodeType === Node.TEXT_NODE
        && !(firstMeaningfulNode.textContent ?? "").trim()
      ) {
        firstMeaningfulNode = firstMeaningfulNode.nextSibling;
      }
    }

    let lastMeaningfulNode = container.lastChild;
    while (
      lastMeaningfulNode?.nodeType === Node.TEXT_NODE
      && !(lastMeaningfulNode.textContent ?? "").trim()
    ) {
      lastMeaningfulNode = lastMeaningfulNode.previousSibling;
    }
    while (lastMeaningfulNode instanceof HTMLBRElement) {
      const previousNode = lastMeaningfulNode.previousSibling;
      lastMeaningfulNode.remove();
      lastMeaningfulNode = previousNode;
      while (
        lastMeaningfulNode?.nodeType === Node.TEXT_NODE
        && !(lastMeaningfulNode.textContent ?? "").trim()
      ) {
        lastMeaningfulNode = lastMeaningfulNode.previousSibling;
      }
    }
  }

  function hasMeaningfulListItemContent(item: HTMLLIElement) {
    return (item.textContent ?? "").replaceAll("\u00a0", "").length > 0
      || item.querySelector("br, details, ul, ol, pre, blockquote, hr") !== null;
  }

  function normalizeSummaryListArtifacts(details: HTMLDetailsElement, summaryText: HTMLElement) {
    const embeddedLists = Array.from(summaryText.querySelectorAll("ul, ol")).filter((list) => {
      const ancestorList = list.parentElement?.closest("ul, ol");
      return !ancestorList || !summaryText.contains(ancestorList);
    });

    for (const list of embeddedLists) {
      details.append(list);
    }

    const strayListItems = Array.from(summaryText.querySelectorAll("li")).filter((item) => !item.closest("ul, ol"));
    if (!strayListItems.length) {
      return;
    }

    const meaningfulItems = strayListItems.filter(hasMeaningfulListItemContent);
    for (const item of strayListItems) {
      if (!hasMeaningfulListItemContent(item)) {
        item.remove();
      }
    }

    if (!meaningfulItems.length) {
      return;
    }

    const targetList = getOrCreateDirectChildList(details, "UL");
    const insertionPoint = targetList.firstChild;
    for (const item of meaningfulItems) {
      targetList.insertBefore(item, insertionPoint);
    }
  }

  function getCaretRangeFromPoint(clientX: number, clientY: number) {
    if (typeof document.caretPositionFromPoint === "function") {
      const caretPosition = document.caretPositionFromPoint(clientX, clientY);
      if (!caretPosition) {
        return null;
      }

      const range = document.createRange();
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
      return range;
    }

    if (typeof document.caretRangeFromPoint === "function") {
      return document.caretRangeFromPoint(clientX, clientY);
    }

    return null;
  }

  function placeCaretInElement(container: HTMLElement, clientX: number, clientY: number) {
    editor.focus();
    const selection = window.getSelection();
    const range = getCaretRangeFromPoint(clientX, clientY);

    if (selection && range && container.contains(range.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    const fallbackRange = document.createRange();
    fallbackRange.selectNodeContents(container);
    fallbackRange.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(fallbackRange);
  }

  function getNodePathFromEditor(node: Node) {
    const path: number[] = [];
    let current: Node | null = node;

    while (current && current !== editor) {
      const parentNode = current.parentNode;
      if (!parentNode) {
        return null;
      }

      const index = Array.prototype.indexOf.call(parentNode.childNodes, current) as number;
      if (index < 0) {
        return null;
      }

      path.unshift(index);
      current = parentNode;
    }

    return current === editor ? path : null;
  }

  function serializeSelectionPoint(node: Node, offset: number): EditHistorySelectionPoint | null {
    if (node !== editor && !editor.contains(node)) {
      return null;
    }

    const path = node === editor ? [] : getNodePathFromEditor(node);
    if (!path) {
      return null;
    }

    return {
      path,
      offset,
    };
  }

  function captureEditorSelection() {
    const selection = window.getSelection();
    const isSelectionWithinEditor = (node: Node | null) => node === editor || (node !== null && editor.contains(node));
    if (
      !selection?.rangeCount
      || !isSelectionWithinEditor(selection.anchorNode)
      || !isSelectionWithinEditor(selection.focusNode)
    ) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const start = serializeSelectionPoint(range.startContainer, range.startOffset);
    const end = serializeSelectionPoint(range.endContainer, range.endOffset);
    if (!start || !end) {
      return null;
    }

    return { start, end } satisfies EditHistorySelection;
  }

  function resolveSelectionPoint(point: EditHistorySelectionPoint) {
    let current: Node = editor;

    for (const index of point.path) {
      if (index < 0 || index >= current.childNodes.length) {
        return null;
      }

      current = current.childNodes[index];
    }

    if (current.nodeType === Node.TEXT_NODE) {
      return {
        node: current,
        offset: Math.max(0, Math.min(point.offset, current.textContent?.length ?? 0)),
      };
    }

    return {
      node: current,
      offset: Math.max(0, Math.min(point.offset, current.childNodes.length)),
    };
  }

  function placeCaretAtEditorEnd() {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function restoreEditorSelection(selectionSnapshot: EditHistorySelection | null) {
    if (!selectionSnapshot) {
      placeCaretAtEditorEnd();
      return;
    }

    const start = resolveSelectionPoint(selectionSnapshot.start);
    const end = resolveSelectionPoint(selectionSnapshot.end);
    if (!start || !end) {
      placeCaretAtEditorEnd();
      return;
    }

    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretBeforeSibling(parent: Node, sibling: Node | null) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    const offset = sibling
      ? Array.prototype.indexOf.call(parent.childNodes, sibling) as number
      : parent.childNodes.length;
    range.setStart(parent, Math.max(0, offset));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
  }

  function placeCaretAfterNode(node: Node, fallbackParent: Node) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, node.textContent?.length ?? 0);
      range.collapse(true);
    } else if (node instanceof Element) {
      range.selectNodeContents(node);
      range.collapse(false);
    } else {
      const offset = Array.prototype.indexOf.call(fallbackParent.childNodes, node) as number;
      range.setStart(fallbackParent, Math.max(0, offset + 1));
      range.collapse(true);
    }

    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
  }

  function getDirectEditorParagraph(node: Node | null) {
    let current: Node | null = node;

    while (current && current !== editor) {
      if (current instanceof HTMLLIElement) {
        return null;
      }

      if (
        current instanceof HTMLElement
        && current.parentNode === editor
        && /^(p|div)$/i.test(current.tagName)
      ) {
        return current;
      }

      current = current.parentNode;
    }

    return null;
  }

  function getTextBeforeSelectionInElement(selection: Selection, element: HTMLElement) {
    if (!selection.rangeCount) {
      return "";
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      return "";
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(element);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return beforeRange.toString().replaceAll("\u00a0", " ");
  }

  function deleteTextImmediatelyBeforeSelection(selection: Selection, element: HTMLElement, characterCount: number) {
    if (!selection.rangeCount || characterCount <= 0) {
      return false;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, element);
    if (beforeText.length < characterCount) {
      return false;
    }

    const startPosition = getTextPositionAtOffset(element, beforeText.length - characterCount);
    const endPosition = getTextPositionAtOffset(element, beforeText.length);
    if (!startPosition || !endPosition) {
      return false;
    }

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    range.deleteContents();
    return true;
  }

  function getInlineExpansionContainer(node: Node | null) {
    const listItem = getClosestListItem(node);
    if (listItem) {
      return getListItemTextContainer(listItem);
    }

    let current: Node | null = node;
    while (current && current !== editor) {
      if (current instanceof HTMLElement && current.parentNode === editor) {
        return current;
      }

      current = current.parentNode;
    }

    return null;
  }

  function getTextPositionAtOffset(root: Node, offset: number) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let currentNode = walker.nextNode();

    if (!currentNode) {
      return offset === 0 ? { node: root, offset: 0 } : null;
    }

    while (currentNode) {
      const textNode = currentNode as Text;
      const textLength = textNode.textContent?.length ?? 0;
      if (remaining <= textLength) {
        return { node: textNode, offset: remaining };
      }

      remaining -= textLength;
      currentNode = walker.nextNode();
    }

    return null;
  }

  function deleteLeadingTextFromElement(element: HTMLElement, characterCount: number) {
    const endPosition = getTextPositionAtOffset(element, characterCount);
    if (!endPosition) {
      return false;
    }

    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(endPosition.node, endPosition.offset);
    range.deleteContents();
    return true;
  }

  function ensureListItemHasEditableContent(item: HTMLLIElement) {
    const hasMeaningfulContent = (item.textContent ?? "").replaceAll("\u00a0", "").length > 0
      || item.querySelector("br, details, ul, ol, pre, blockquote, hr") !== null;

    if (hasMeaningfulContent) {
      return;
    }

    item.replaceChildren(document.createElement("br"));
  }

  function ensureParagraphHasEditableContent(paragraph: HTMLElement) {
    if ((paragraph.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
      return;
    }

    if (paragraph.querySelector("br, ul, ol, pre, blockquote, hr") !== null) {
      return;
    }

    paragraph.replaceChildren(document.createElement("br"));
  }

  function setPlainBlockText(element: HTMLElement, text: string) {
    element.replaceChildren();
    if (text) {
      element.append(document.createTextNode(text));
      return;
    }

    element.append(document.createElement("br"));
  }

  function normalizeCommentBlockElement(element: HTMLElement) {
    const parsedCommentBody = parseBlockCommentBody(element.textContent ?? "");
    if (parsedCommentBody !== null) {
      element.dataset.blockComment = "true";
      setPlainBlockText(element, parsedCommentBody);
      return;
    }

    if (element.dataset.blockComment === "true") {
      const textContent = element.textContent ?? "";
      if (!textContent.replaceAll("\u00a0", "").length) {
        setPlainBlockText(element, "");
      }
      return;
    }

    element.removeAttribute("data-block-comment");
  }

  function isIntentionalListBreakParagraph(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement
      && element.dataset.listBreak === "true"
      && isSingleBreakParagraph(element);
  }

  function insertListItemAtParagraphPosition(paragraph: HTMLElement, item: HTMLLIElement) {
    const previousList = paragraph.previousElementSibling instanceof HTMLUListElement
      ? paragraph.previousElementSibling
      : null;
    const nextList = paragraph.nextElementSibling instanceof HTMLUListElement
      ? paragraph.nextElementSibling
      : null;

    if (previousList) {
      previousList.append(item);
      paragraph.remove();

      if (nextList) {
        while (nextList.firstChild) {
          previousList.append(nextList.firstChild);
        }
        nextList.remove();
      }
      return;
    }

    if (nextList) {
      nextList.prepend(item);
      paragraph.remove();
      return;
    }

    const list = document.createElement("ul");
    list.append(item);
    paragraph.replaceWith(list);
  }

  function maybeTransformParagraphIntoListItem(event: Event) {
    if (!(event instanceof InputEvent) || state.mode !== "rich") {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== " ") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const paragraph = getDirectEditorParagraph(selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, paragraph);
    if (beforeText !== "- ") {
      return null;
    }

    if (!deleteLeadingTextFromElement(paragraph, 2)) {
      return null;
    }

    const item = document.createElement("li");
    while (paragraph.firstChild) {
      item.append(paragraph.firstChild);
    }

    item.normalize();
    ensureListItemHasEditableContent(item);
    insertListItemAtParagraphPosition(paragraph, item);
    return item;
  }

  function restoreCaretToMarker(marker: HTMLElement) {
    const selection = window.getSelection();
    if (!selection || !marker.parentNode) {
      marker.remove();
      return;
    }

    const range = document.createRange();
    const parentElement = marker.parentElement;
    const parentMark = parentElement ? getInlineMarkForElement(parentElement) : null;
    if (parentElement && parentMark) {
      const markerIndex = Array.from(parentElement.childNodes).indexOf(marker);
      range.setStart(parentElement, Math.max(0, markerIndex));
    } else {
      range.setStartBefore(marker);
    }
    range.collapse(true);
    marker.remove();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function createInlineSelectionMarker(role: "caret" | "selection-start" | "selection-end") {
    const marker = document.createElement("span");
    marker.hidden = true;
    marker.dataset.pendingInlineCaret = role === "caret" ? "true" : "false";
    marker.dataset.inlineSelectionMarker = role;
    return marker;
  }

  function restoreSelectionToMarkers(
    startMarker: HTMLElement,
    endMarker: HTMLElement | null,
  ) {
    const selection = window.getSelection();
    if (!selection || !startMarker.parentNode) {
      startMarker.remove();
      endMarker?.remove();
      return;
    }

    const range = document.createRange();
    range.setStartBefore(startMarker);

    if (endMarker?.parentNode) {
      range.setEndBefore(endMarker);
    } else {
      range.collapse(true);
    }

    startMarker.remove();
    endMarker?.remove();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function maybeExpandBlockCommentStarter(event: Event) {
    if (!(event instanceof InputEvent) || state.mode !== "rich") {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== "!") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const paragraph = getDirectEditorParagraph(range.startContainer);
    if (!paragraph || paragraph.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, paragraph);
    if (beforeText !== "<!") {
      return null;
    }

    const marker = document.createElement("span");
    marker.dataset.commentCaret = "true";

    if (!deleteLeadingTextFromElement(paragraph, 2)) {
      return null;
    }

    paragraph.dataset.blockComment = "true";
    if (paragraph.firstChild) {
      paragraph.insertBefore(marker, paragraph.firstChild);
    } else {
      paragraph.append(marker, document.createElement("br"));
    }

    return marker;
  }

  function maybeActivateInlineCommentShortcut(event: Event) {
    if (!(event instanceof InputEvent) || state.mode !== "rich") {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== "!") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const container = getInlineExpansionContainer(selection.getRangeAt(0).startContainer);
    if (!container || !editor.contains(container) || container.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, container);
    if (!beforeText.endsWith("<!")) {
      return null;
    }

    if (!deleteTextImmediatelyBeforeSelection(selection, container, 2)) {
      return null;
    }

    const baseFormats = pendingInlineFormats ?? getInlineFormatStateFromNode(selection.getRangeAt(0).startContainer);
    pendingInlineFormats = {
      ...baseFormats,
      comment: true,
    };
    materializePendingInlineFormatsAtCaret(pendingInlineFormats);
    updateCustomCaret();
    return null;
  }

  function createParagraphFromTopLevelListItem(item: HTMLLIElement, { preserveEmptyListBreak }: { preserveEmptyListBreak: boolean }) {
    const paragraph = document.createElement("p");
    const details = getDirectChildDetailsElement(item);

    if (details) {
      const summary = getDirectChildSummaryElement(details);
      const summaryText = summary
        ? getDirectChildSummaryTextElement(summary) ?? summary
        : null;

      if (summaryText) {
        while (summaryText.firstChild) {
          paragraph.append(summaryText.firstChild);
        }
      }
    } else {
      const contentNodes = Array.from(item.childNodes).filter((node) => {
        return !(node instanceof Element && isListElement(node));
      });

      for (const node of contentNodes) {
        paragraph.append(node);
      }
    }

    paragraph.normalize();
    ensureParagraphHasEditableContent(paragraph);

    if (preserveEmptyListBreak && isSingleBreakParagraph(paragraph)) {
      paragraph.dataset.listBreak = "true";
    }

    return paragraph;
  }

  function getNestedListBreakoutNodes(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      return getDirectChildListElements(details);
    }

    return getDirectChildListElements(item);
  }

  function unwrapTopLevelListItemToParagraph(item: HTMLLIElement) {
    const parentList = getParentListElement(item);
    if (!parentList) {
      return null;
    }

    const previousSibling = item.previousElementSibling instanceof HTMLLIElement
      ? item.previousElementSibling
      : null;
    const nextSibling = item.nextElementSibling instanceof HTMLLIElement
      ? item.nextElementSibling
      : null;
    const preserveEmptyListBreak = Boolean(previousSibling && nextSibling);
    const paragraph = createParagraphFromTopLevelListItem(item, { preserveEmptyListBreak });
    const nestedBreakoutNodes = getNestedListBreakoutNodes(item);
    const trailingItems: HTMLLIElement[] = [];
    let trailingNode = item.nextElementSibling;

    while (trailingNode) {
      const nextTrailingNode = trailingNode.nextElementSibling;
      if (trailingNode instanceof HTMLLIElement) {
        trailingItems.push(trailingNode);
      }
      trailingNode = nextTrailingNode;
    }

    const trailingList = trailingItems.length
      ? document.createElement(parentList.tagName.toLowerCase()) as HTMLUListElement | HTMLOListElement
      : null;

    if (trailingList) {
      for (const trailingItem of trailingItems) {
        trailingList.append(trailingItem);
      }
    }

    const insertionParent = parentList.parentNode;
    if (!insertionParent) {
      return paragraph;
    }

    const parentListNextSibling = parentList.nextSibling;
    item.remove();
    const hasLeadingItems = parentList.children.length > 0;
    if (!hasLeadingItems) {
      parentList.remove();
    }

    const insertionAnchor = hasLeadingItems
      ? parentList.nextSibling
      : parentListNextSibling;
    insertionParent.insertBefore(paragraph, insertionAnchor);

    let nextInsertionPoint = paragraph.nextSibling;
    for (const breakoutNode of nestedBreakoutNodes) {
      insertionParent.insertBefore(breakoutNode, nextInsertionPoint);
      nextInsertionPoint = breakoutNode.nextSibling;
    }

    if (trailingList) {
      insertionParent.insertBefore(trailingList, nextInsertionPoint);
    }

    return paragraph;
  }

  function normalizeListItemHierarchy(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    const directLists = getDirectChildListElements(item);

    if (!details && !directLists.length) {
      return;
    }

    if (!details) {
      const nextDetails = document.createElement("details");
      nextDetails.open = true;
      const summary = document.createElement("summary");
      const summaryText = ensureSummaryTextWrapper(summary);
      const summaryNodes = Array.from(item.childNodes).filter((node) => {
        return !(node instanceof Element && directLists.some((list) => list === node));
      });

      for (const node of summaryNodes) {
        summaryText.append(node);
      }
      normalizeSummaryListArtifacts(nextDetails, summaryText);
      trimBoundaryBreaks(summaryText);

      if (!summaryText.childNodes.length) {
        summaryText.append(document.createElement("br"));
      }

      nextDetails.append(summary);
      for (const list of directLists) {
        nextDetails.append(list);
      }
      item.append(nextDetails);
      return;
    }

    const summary = getDirectChildSummaryElement(details) ?? document.createElement("summary");
    if (summary.parentElement !== details) {
      details.prepend(summary);
    }
    const summaryText = ensureSummaryTextWrapper(summary);

    const externalNodes = Array.from(item.childNodes).filter((node) => node !== details);
    for (const node of externalNodes) {
      summaryText.append(node);
    }

    const strayDetailNodes = Array.from(details.childNodes).filter((node) => {
      if (node === summary) {
        return false;
      }

      return !(node instanceof Element && isListElement(node));
    });
    for (const node of strayDetailNodes) {
      summaryText.append(node);
    }
    normalizeSummaryListArtifacts(details, summaryText);
    trimBoundaryBreaks(summaryText);

    const nestedLists = getDirectChildListElements(details);
    if (!nestedLists.length) {
      while (summaryText.firstChild) {
        item.insertBefore(summaryText.firstChild, details);
      }
      details.remove();
      if (!item.childNodes.length) {
        item.append(document.createElement("br"));
      }
      return;
    }

    if (!summaryText.childNodes.length) {
      summaryText.append(document.createElement("br"));
    }
  }

  function normalizeNestedListHierarchy(root: ParentNode = editor) {
    const listItems = root instanceof HTMLLIElement
      ? [root]
      : Array.from(root.querySelectorAll("li"));

    for (const item of listItems) {
      if (item instanceof HTMLLIElement) {
        normalizeListItemHierarchy(item);
      }
    }
  }

  function isMergeableListElement(node: Node | null): node is HTMLUListElement | HTMLOListElement {
    return node instanceof HTMLUListElement || node instanceof HTMLOListElement;
  }

  function isListMergeSeparatorNode(node: Node | null) {
    if (!node) {
      return false;
    }

    if (node instanceof HTMLBRElement) {
      return true;
    }

    return node instanceof HTMLElement
      && isSingleBreakParagraph(node)
      && !isIntentionalListBreakParagraph(node);
  }

  function getNextMeaningfulSibling(node: ChildNode | null) {
    let current = node;

    while (current?.nodeType === Node.TEXT_NODE && !(current.textContent ?? "").trim()) {
      const nextSibling = current.nextSibling;
      current.remove();
      current = nextSibling;
    }

    return current;
  }

  function mergeAdjacentSiblingLists(root: ParentNode = editor) {
    const childElements = root instanceof Element || root instanceof DocumentFragment
      ? Array.from(root.children)
      : [];

    for (const childElement of childElements) {
      mergeAdjacentSiblingLists(childElement);
    }

    let current = getNextMeaningfulSibling(root.firstChild);

    while (current) {
      if (!isMergeableListElement(current)) {
        current = getNextMeaningfulSibling(current.nextSibling);
        continue;
      }

      const separator = getNextMeaningfulSibling(current.nextSibling);
      const nextList = isListMergeSeparatorNode(separator)
        ? getNextMeaningfulSibling(separator.nextSibling)
        : separator;

      if (isMergeableListElement(nextList) && nextList.tagName === current.tagName) {
        while (nextList.firstChild) {
          current.append(nextList.firstChild);
        }

        nextList.remove();
        if (separator && isListMergeSeparatorNode(separator)) {
          separator.remove();
        }
        continue;
      }

      current = getNextMeaningfulSibling(current.nextSibling);
    }
  }

  function syncStructuredBlockStyles(root: ParentNode = editor) {
    normalizeNestedListHierarchy(root);
    mergeAdjacentSiblingLists(root);
    canonicalizeAllInlineRunContainers(root);
    removeEmptyInlineFormattingArtifacts(root);

    const candidates = root instanceof HTMLDivElement && root === editor
      ? Array.from(root.children)
      : Array.from(root.querySelectorAll("p, div"));

    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const isCommentCandidate = /^(p|div)$/i.test(element.tagName);
      if (!isCommentCandidate) {
        element.removeAttribute("data-block-comment");
        element.removeAttribute("data-single-break");
        continue;
      }

      if (isSingleBreakParagraph(element)) {
        element.dataset.singleBreak = "true";
      } else {
        element.removeAttribute("data-single-break");
      }

      normalizeCommentBlockElement(element);
    }
  }

  function updateSaveButtonState() {
    saveFileButton.dataset.invalid = state.saveIssue ? "true" : "false";
    saveFileButton.disabled = !state.currentPath;
    resetDraftButton.disabled = !state.currentPath;
  }

  function hideSaveConflictDialog() {
    hideDialog(saveConflictDialog);
  }

  function hideResetDraftDialog() {
    hideDialog(resetDraftDialog);
  }

  function clearWriteConflict() {
    state.pendingWriteConflict = null;
    hideSaveConflictDialog();
  }

  function showWriteConflict(conflict: SaveConflictPayload) {
    state.pendingWriteConflict = conflict;
    saveConflictSummary.textContent = `${conflict.path} changed on disk after you opened it. Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.`;
    saveConflictExpected.textContent = `Opened version: ${formatTimestamp(conflict.expectedUpdatedAt)}`;
    saveConflictActual.textContent = `Current disk version: ${formatTimestamp(conflict.actualUpdatedAt)}`;
    showDialog(saveConflictDialog, saveConflictKeepEditingButton);
  }

  function getCurrentEditorState() {
    return state.mode === "rich"
      ? editor.innerHTML
      : editor.textContent ?? "";
  }

  function hasBufferedDraftState(buffer: DraftBuffer) {
    return buffer.dirty || Boolean(buffer.saveIssue) || Boolean(buffer.pendingWriteConflict);
  }

  function getLocallyModifiedPaths() {
    const modifiedPaths = new Set<string>();

    if (state.currentPath && state.dirty) {
      modifiedPaths.add(state.currentPath);
    }

    for (const [filePath, buffer] of state.draftBuffers) {
      if (buffer.dirty) {
        modifiedPaths.add(filePath);
      }
    }

    return Array.from(modifiedPaths).sort((left, right) => left.localeCompare(right));
  }

  function getExplorerSnapshot(): ExplorerSnapshot {
    return {
      root: state.root,
      rootPath: state.rootPath,
      tree: state.tree,
      threads: state.threads,
      changes: state.changes,
      currentPath: state.currentPath,
      currentThreadId: state.currentThreadId,
      expandedDirectories: Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)),
      locallyModifiedPaths: getLocallyModifiedPaths(),
      threadsError: state.threadsError,
      fontSize: state.fontSize,
    };
  }

  function emitExplorerStateChange() {
    bindings.onExplorerStateChange?.(getExplorerSnapshot());
  }

  function emitCurrentThreadChange() {
    bindings.onCurrentThreadChange?.(state.currentThread);
  }

  function areCurrentTurnsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
    const leftTurn = getCurrentTurn(left);
    const rightTurn = getCurrentTurn(right);

    if (leftTurn === rightTurn) {
      return true;
    }

    if (!leftTurn || !rightTurn) {
      return false;
    }

    return JSON.stringify(leftTurn) === JSON.stringify(rightTurn);
  }

  function areThreadPayloadsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    return left.id === right.id
      && left.name === right.name
      && left.preview === right.preview
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.status === right.status
      && left.cwd === right.cwd
      && left.source === right.source
      && left.path === right.path
      && left.turns.length === right.turns.length
      && areCurrentTurnsEquivalent(left, right);
  }

  function setCurrentThread(thread: ThreadPayload | null) {
    if (areThreadPayloadsEquivalent(state.currentThread, thread)) {
      return;
    }

    state.currentThread = thread;
    emitCurrentThreadChange();
  }

  function toggleDirectory(path: string) {
    if (!path) {
      return;
    }

    if (state.expandedDirectories.has(path)) {
      state.expandedDirectories.delete(path);
    } else {
      state.expandedDirectories.add(path);
    }

    persistExpandedDirectories(state.expandedDirectories);
    emitExplorerStateChange();
  }

  function syncCurrentDraftBuffer() {
    if (!state.currentPath) {
      return;
    }

    const previousModified = state.draftBuffers.get(state.currentPath)?.dirty ?? false;
    const nextBuffer: DraftBuffer = {
      baselineContent: state.baselineContent,
      content: state.currentContent,
      dirty: state.dirty,
      editorState: getCurrentEditorState(),
      expectedMtimeMs: state.expectedMtimeMs,
      headContent: state.headContent,
      history: cloneEditHistory(state.history) ?? createInitialEditHistory(state.currentContent),
      mode: state.mode,
      pendingWriteConflict: state.pendingWriteConflict
        ? { ...state.pendingWriteConflict }
        : null,
      saveIssue: state.saveIssue
        ? { ...state.saveIssue }
        : null,
    };

    if (!hasBufferedDraftState(nextBuffer)) {
      state.draftBuffers.delete(state.currentPath);
      void persistDraftBuffer(state.currentPath, null);
      if (previousModified) {
        emitExplorerStateChange();
      }
      return;
    }

    state.draftBuffers.set(state.currentPath, nextBuffer);
    void persistDraftBuffer(state.currentPath, nextBuffer);
    if (previousModified !== nextBuffer.dirty) {
      emitExplorerStateChange();
    }
  }

  function restoreDraftBuffer(filePath: string, buffer: DraftBuffer) {
    clearWriteConflict();
    setCurrentThread(null);
    state.currentPath = filePath;
    state.currentThreadId = "";
    state.expectedMtimeMs = buffer.expectedMtimeMs;
    state.mode = buffer.mode;
    editor.dataset.placeholder = buffer.mode === "rich"
      ? "Select a markdown file to start editing."
      : "Plain text mode";
    filePathLabel.textContent = filePath;

    if (buffer.mode === "rich") {
      editor.innerHTML = buffer.editorState;
    } else {
      editor.textContent = buffer.editorState;
    }

    applyEditorFontSize();
    syncStructuredBlockStyles();
    editor.scrollTop = 0;
    state.baselineContent = buffer.baselineContent;
    state.currentContent = buffer.content;
    state.headContent = buffer.headContent;
    state.history = normalizeEditHistory(buffer.history, buffer.content);
    state.dirty = buffer.dirty;
    state.pendingWriteConflict = buffer.pendingWriteConflict
      ? { ...buffer.pendingWriteConflict }
      : null;
    state.saveIssue = buffer.saveIssue
      ? { ...buffer.saveIssue }
      : null;
    state.lastLoggedSaveIssue = buffer.saveIssue
      ? { ...buffer.saveIssue }
      : null;
    updateSaveButtonState();
    updateStatusLine();
    scheduleDiffGutterRefresh();
    restoreEditorSelection(state.history.frames[state.history.currentIndex]?.selection ?? null);
  }

  function isSameSaveGuardIssue(left: SaveGuardIssue | null, right: SaveGuardIssue | null) {
    if (!left || !right) {
      return left === right;
    }

    return left.markdown === right.markdown
      && left.currentMarkup === right.currentMarkup
      && left.roundTripMarkup === right.roundTripMarkup;
  }

  function applyEditorFontSize() {
    editor.style.fontSize = `${state.fontSize}rem`;
  }

  function changeEditorFontSize(delta: number) {
    const nextFontSize = Math.min(
      MAX_EDITOR_FONT_SIZE,
      Math.max(MIN_EDITOR_FONT_SIZE, Number((state.fontSize + delta).toFixed(2))),
    );

    if (nextFontSize === state.fontSize) {
      return;
    }

    state.fontSize = nextFontSize;
    applyEditorFontSize();
    persistFontSize(state.fontSize);
    scheduleDiffGutterRefresh();
    emitExplorerStateChange();
  }

  function escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function findClosingToken(source: string, token: string, fromIndex: number) {
    for (let index = fromIndex; index < source.length; index += 1) {
      if (source[index - 1] === "\\") {
        continue;
      }
      if (source.startsWith(token, index)) {
        return index;
      }
    }
    return -1;
  }

  function renderInline(markdown: string) {
    let html = "";
    let index = 0;

    while (index < markdown.length) {
      if (markdown[index] === "\\") {
        html += escapeHtml(markdown.slice(index + 1, index + 2));
        index += 2;
        continue;
      }

      if (markdown.startsWith("<del>", index)) {
        const closeIndex = markdown.indexOf("</del>", index + 5);
        if (closeIndex !== -1) {
          html += `<del>${renderInline(markdown.slice(index + 5, closeIndex))}</del>`;
          index = closeIndex + 6;
          continue;
        }
      }

      if (markdown.startsWith("<ins>", index)) {
        const closeIndex = markdown.indexOf("</ins>", index + 5);
        if (closeIndex !== -1) {
          html += `<ins>${renderInline(markdown.slice(index + 5, closeIndex))}</ins>`;
          index = closeIndex + 6;
          continue;
        }
      }

      if (markdown.startsWith("<!--", index)) {
        const closeIndex = markdown.indexOf("-->", index + 4);
        if (closeIndex !== -1) {
          const commentBody = markdown.slice(index + 4, closeIndex).trim();
          html += `<span data-inline-comment="true">${renderInline(commentBody)}</span>`;
          index = closeIndex + 3;
          continue;
        }
      }

      if (markdown.startsWith("**", index) || markdown.startsWith("__", index)) {
        const marker = markdown.slice(index, index + 2);
        const closeIndex = findClosingToken(markdown, marker, index + 2);
        if (closeIndex !== -1) {
          html += `<strong>${renderInline(markdown.slice(index + 2, closeIndex))}</strong>`;
          index = closeIndex + 2;
          continue;
        }
      }

      if (markdown.startsWith("~~", index)) {
        const closeIndex = findClosingToken(markdown, "~~", index + 2);
        if (closeIndex !== -1) {
          html += `<del>${renderInline(markdown.slice(index + 2, closeIndex))}</del>`;
          index = closeIndex + 2;
          continue;
        }
      }

      if (markdown[index] === "*" || markdown[index] === "_") {
        const marker = markdown[index];
        const closeIndex = findClosingToken(markdown, marker, index + 1);
        if (closeIndex !== -1) {
          html += `<em>${renderInline(markdown.slice(index + 1, closeIndex))}</em>`;
          index = closeIndex + 1;
          continue;
        }
      }

      if (markdown[index] === "`") {
        const closeIndex = findClosingToken(markdown, "`", index + 1);
        if (closeIndex !== -1) {
          html += `<code>${escapeHtml(markdown.slice(index + 1, closeIndex))}</code>`;
          index = closeIndex + 1;
          continue;
        }
      }

      if (markdown[index] === "[") {
        const labelEnd = findClosingToken(markdown, "]", index + 1);
        if (labelEnd !== -1 && markdown[labelEnd + 1] === "(") {
          const urlEnd = findClosingToken(markdown, ")", labelEnd + 2);
          if (urlEnd !== -1) {
            const label = markdown.slice(index + 1, labelEnd);
            const url = markdown.slice(labelEnd + 2, urlEnd);
            html += `<a href="${escapeHtml(url)}">${renderInline(label)}</a>`;
            index = urlEnd + 1;
            continue;
          }
        }
      }

      if (markdown[index] === "\n") {
        html += "<br>";
        index += 1;
        continue;
      }

      html += escapeHtml(markdown[index]);
      index += 1;
    }

    return html;
  }

  function parseListLine(line: string) {
    const expandedLine = line.replaceAll("\t", "  ");
    const match = expandedLine.match(/^(\s*)([-*+]|\d+[.)])(?:\s+(.*))?$/);
    if (!match) {
      return null;
    }

    return {
      indent: match[1].length,
      text: match[3] ?? "",
      type: /^\d+[.)]$/.test(match[2]) ? "ol" : "ul" as "ol" | "ul",
    };
  }

  function parseSpecificListBlock(lines: string[], startIndex: number, indent: number, type: "ul" | "ol") {
    const items: ParsedListItem[] = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = parseListLine(lines[index]);
      if (!line || line.indent !== indent || line.type !== type) {
        break;
      }

      const item: ParsedListItem = {
        text: line.text,
        children: [],
      };
      index += 1;

      while (index < lines.length) {
        const nestedLine = parseListLine(lines[index]);
        if (!nestedLine || nestedLine.indent <= indent) {
          break;
        }

        const nestedBlock = parseSpecificListBlock(lines, index, nestedLine.indent, nestedLine.type);
        item.children.push(nestedBlock.block);
        index = nestedBlock.nextIndex;
      }

      items.push(item);
    }

    return {
      block: { type, items } satisfies Extract<ParsedBlock, { type: "ul" | "ol" }>,
      nextIndex: index,
    };
  }

  function parseListBlock(lines: string[], startIndex: number) {
    const firstLine = parseListLine(lines[startIndex]);
    if (!firstLine) {
      return null;
    }

    return parseSpecificListBlock(lines, startIndex, firstLine.indent, firstLine.type);
  }

  function parseBlocks(markdown: string): ParsedBlock[] {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const blocks: ParsedBlock[] = [];
    let blankLineCount = 0;

    for (let index = 0; index < lines.length;) {
      const line = lines[index];

      if (!line.trim()) {
        blankLineCount += 1;
        index += 1;
        continue;
      }

      if (isBlockCommentLine(line)) {
        maybePushCommentBreak(blocks, blankLineCount, "comment");
        blankLineCount = 0;
        blocks.push({ type: "comment", text: line });
        index += 1;
        continue;
      }

      const fenceMatch = line.match(/^```(.*)$/);
      if (fenceMatch) {
        maybePushCommentBreak(blocks, blankLineCount, "code");
        maybePushStandardBreak(blocks, blankLineCount, "code");
        blankLineCount = 0;
        const language = fenceMatch[1].trim();
        const codeLines = [];
        index += 1;

        while (index < lines.length && !lines[index].startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }

        if (index < lines.length) {
          index += 1;
        }

        blocks.push({ type: "code", language, text: codeLines.join("\n") });
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        maybePushCommentBreak(blocks, blankLineCount, "heading");
        maybePushStandardBreak(blocks, blankLineCount, "heading");
        blankLineCount = 0;
        blocks.push({
          type: "heading",
          level: headingMatch[1].length,
          text: headingMatch[2],
        });
        index += 1;
        continue;
      }

      if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        maybePushCommentBreak(blocks, blankLineCount, "hr");
        maybePushStandardBreak(blocks, blankLineCount, "hr");
        blankLineCount = 0;
        blocks.push({ type: "hr" });
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        maybePushCommentBreak(blocks, blankLineCount, "blockquote");
        maybePushStandardBreak(blocks, blankLineCount, "blockquote");
        blankLineCount = 0;
        const quoteLines = [];

        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }

        blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
        continue;
      }

      const listBlock = parseListBlock(lines, index);
      if (listBlock) {
        const previousBlock = getLastNonBreakBlock(blocks);
        const previousIsList = previousBlock?.type === "ul" || previousBlock?.type === "ol";
        if (
          blankLineCount > 0
          && previousIsList
        ) {
          blocks.push({ type: "list-break", count: blankLineCount });
        } else {
          maybePushCommentBreak(blocks, blankLineCount, listBlock.block.type);
          maybePushStandardBreak(blocks, blankLineCount, listBlock.block.type);
        }
        blankLineCount = 0;
        blocks.push(listBlock.block);
        index = listBlock.nextIndex;
        continue;
      }

      const paragraphLines = [];
      maybePushCommentBreak(blocks, blankLineCount, "paragraph");
      maybePushStandardBreak(blocks, blankLineCount, "paragraph");
      blankLineCount = 0;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !isBlockCommentLine(lines[index]) &&
        !/^```/.test(lines[index]) &&
        !/^(#{1,6})\s+/.test(lines[index]) &&
        !/^>\s?/.test(lines[index]) &&
        !/^[-*+]\s+/.test(lines[index]) &&
        !/^\d+[.)]\s+/.test(lines[index]) &&
        !/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])
      ) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
    }

    if (blankLineCount > 0 && getLastNonBreakBlock(blocks)?.type === "comment") {
      blocks.push({ type: "break", count: blankLineCount });
    }

    return blocks;
  }

  function appendParsedListDiffRows(
    block: Extract<ParsedBlock, { type: "ul" | "ol" }>,
    blockPath: string,
    depth: number,
    rows: DiffRow[],
  ) {
    block.items.forEach((item, index) => {
      const itemPath = `${blockPath}/item:${index}`;
      rows.push({
        path: itemPath,
        signature: `li|${block.type}|${depth}|${item.text}`,
      });

      item.children.forEach((child, childIndex) => {
        if (child.type !== "ul" && child.type !== "ol") {
          return;
        }

        appendParsedListDiffRows(child, `${itemPath}/child:${childIndex}`, depth + 1, rows);
      });
    });
  }

  function flattenMarkdownDiffRows(markdown: string | null) {
    const rows: DiffRow[] = [];
    let blockIndex = 0;

    for (const block of parseMarkdownBlocks(markdown ?? "")) {
      switch (block.type) {
        case "break":
        case "list-break":
          continue;
        case "ul":
        case "ol":
          appendParsedListDiffRows(block, `b${blockIndex}`, 0, rows);
          blockIndex += 1;
          continue;
        case "heading":
          rows.push({
            path: `b${blockIndex}`,
            signature: `heading|${block.level}|${block.text}`,
          });
          blockIndex += 1;
          continue;
        case "blockquote":
          rows.push({
            path: `b${blockIndex}`,
            signature: `blockquote|${block.text}`,
          });
          blockIndex += 1;
          continue;
        case "comment":
          rows.push({
            path: `b${blockIndex}`,
            signature: `comment|${block.text}`,
          });
          blockIndex += 1;
          continue;
        case "hr":
          rows.push({
            path: `b${blockIndex}`,
            signature: "hr|",
          });
          blockIndex += 1;
          continue;
        case "code":
          rows.push({
            path: `b${blockIndex}`,
            signature: `code|${block.language}|${block.text}`,
          });
          blockIndex += 1;
          continue;
        case "paragraph":
          rows.push({
            path: `b${blockIndex}`,
            signature: `paragraph|${block.text}`,
          });
          blockIndex += 1;
          continue;
        default:
          continue;
      }
    }

    return rows;
  }

  function renderListBlock(block: Extract<ParsedBlock, { type: "ul" | "ol" }>) {
    return `<${block.type}>${block.items.map((item) => renderListItem(item)).join("")}</${block.type}>`;
  }

  function renderListItem(item: ParsedListItem) {
    const content = renderInline(item.text) || "<br>";
    if (!item.children.length) {
      return `<li>${content}</li>`;
    }

    const childContent = item.children
      .map((child) => child.type === "ul" || child.type === "ol" ? renderListBlock(child) : "")
      .join("");

    return `<li><details open><summary>${content}</summary>${childContent}</details></li>`;
  }

  function markdownToHtml(markdown: string) {
    const blocks = parseBlocks(markdown);
    const html = blocks
      .map((block) => {
        switch (block.type) {
          case "list-break":
            return Array.from(
              { length: Math.max(1, block.count) },
              () => '<p data-list-break="true"><br></p>',
            ).join("");
          case "break":
            return "<br>".repeat(block.count);
          case "heading":
            return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
          case "blockquote":
            return `<blockquote>${renderInline(block.text)}</blockquote>`;
          case "comment":
            return `<p data-block-comment="true">${escapeHtml(parseBlockCommentBody(block.text) ?? block.text)}</p>`;
          case "ul":
          case "ol":
            return renderListBlock(block);
          case "hr":
            return "<hr>";
          case "code":
            return `<pre data-language="${escapeHtml(block.language)}"><code>${escapeHtml(block.text)}</code></pre>`;
          case "paragraph":
          default:
            return `<p>${renderInline(block.text)}</p>`;
        }
      })
      .join("");

    return html || "<p><br></p>";
  }

  function replaceTag(root: ParentNode, sourceTag: string, targetTag: string) {
    for (const node of root.querySelectorAll(sourceTag)) {
      const replacement = document.createElement(targetTag);
      for (const attribute of node.getAttributeNames()) {
        replacement.setAttribute(attribute, node.getAttribute(attribute) ?? "");
      }
      replacement.innerHTML = node.innerHTML;
      node.replaceWith(replacement);
    }
  }

  function unwrapTransparentSpans(root: ParentNode) {
    for (const span of Array.from(root.querySelectorAll("span"))) {
      if (!(span instanceof HTMLElement)) {
        continue;
      }

      if (span.dataset.summaryText === "true") {
        continue;
      }

       if (span.dataset.inlineComment === "true") {
        continue;
      }

      span.removeAttribute("style");

      if (span.getAttributeNames().length > 0) {
        continue;
      }

      while (span.firstChild) {
        span.parentNode?.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  }

  function removeEmptyInlineFormattingArtifacts(root: ParentNode) {
    removeEmptyInlineFormatElements(["strong", "em", "code", "del", "ins"], root);

    if (!("querySelectorAll" in root)) {
      return;
    }

    const protectedElements = getProtectedEmptyInlineFormatElements(root);
    for (const commentElement of Array.from(root.querySelectorAll<HTMLElement>('[data-inline-comment="true"]'))) {
      if (protectedElements.has(commentElement)) {
        continue;
      }

      if ((commentElement.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
        continue;
      }

      commentElement.remove();
    }
  }

  function normalizeEditorMarkup(root: ParentNode = editor) {
    replaceTag(root, "b", "strong");
    replaceTag(root, "i", "em");
    replaceTag(root, "strike", "del");
    replaceTag(root, "s", "del");
    unwrapTransparentSpans(root);
    normalizeNestedListHierarchy(root);
    mergeAdjacentSiblingLists(root);
    canonicalizeAllInlineRunContainers(root);
    removeEmptyInlineFormattingArtifacts(root);
    (root as Node).normalize();
  }

  function isDiffTrackableBlockElement(element: Element) {
    return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|pre|hr)$/i.test(element.tagName);
  }

  function appendLiveListDiffAnchors(
    listElement: HTMLUListElement | HTMLOListElement,
    blockPath: string,
    anchors: DiffRowAnchor[],
  ) {
    Array.from(listElement.children)
      .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement)
      .forEach((item, index) => {
        const itemPath = `${blockPath}/item:${index}`;
        anchors.push({
          path: itemPath,
          element: item,
        });

        getNestedListElementsForItem(item).forEach((childList, childIndex) => {
          appendLiveListDiffAnchors(childList, `${itemPath}/child:${childIndex}`, anchors);
        });
      });
  }

  function flattenLiveDiffAnchors(root: ParentNode = editor) {
    const anchors: DiffRowAnchor[] = [];
    const childElements = root instanceof Element || root instanceof DocumentFragment
      ? Array.from(root.children)
      : [];
    let blockIndex = 0;

    for (const childElement of childElements) {
      if (
        childElement instanceof HTMLBRElement
        || isIntentionalListBreakParagraph(childElement)
        || (childElement instanceof HTMLElement && isSingleBreakParagraph(childElement))
      ) {
        continue;
      }

      if (childElement instanceof HTMLUListElement || childElement instanceof HTMLOListElement) {
        appendLiveListDiffAnchors(childElement, `b${blockIndex}`, anchors);
        blockIndex += 1;
        continue;
      }

      if (!isDiffTrackableBlockElement(childElement)) {
        continue;
      }

      anchors.push({
        path: `b${blockIndex}`,
        element: childElement as HTMLElement,
      });
      blockIndex += 1;
    }

    return anchors;
  }

  function createMarkupSignature(root: ParentNode) {
    return Array.from(root.childNodes)
      .map((node) => serializeMarkupNode(node))
      .filter(Boolean)
      .join("");
  }

  function normalizeInlineLeavesForMarkupSignature(
    leaves: InlineLeaf[],
    trimTrailingWhitespace: boolean,
  ) {
    const mergedLeaves = normalizeInlineLeavesForSerialization(leaves);
    let leadingBreakCount = 0;
    while (mergedLeaves[0]?.type === "break") {
      mergedLeaves.shift();
      leadingBreakCount += 1;
    }

    let trailingBreakCount = 0;
    while (mergedLeaves.at(-1)?.type === "break") {
      mergedLeaves.pop();
      trailingBreakCount += 1;
    }

    if (!trimTrailingWhitespace) {
      return {
        leaves: mergedLeaves,
        leadingBreakCount,
        trailingBreakCount,
      };
    }

    const lastLeaf = mergedLeaves.at(-1);
    if (!lastLeaf || lastLeaf.type !== "text") {
      return {
        leaves: mergedLeaves,
        leadingBreakCount,
        trailingBreakCount,
      };
    }

    const trimmedText = lastLeaf.text.replace(/[ \t\u00a0]+$/g, "");
    if (trimmedText === lastLeaf.text) {
      return {
        leaves: mergedLeaves,
        leadingBreakCount,
        trailingBreakCount,
      };
    }

    if (trimmedText) {
      lastLeaf.text = trimmedText;
      return {
        leaves: mergedLeaves,
        leadingBreakCount,
        trailingBreakCount,
      };
    }

    mergedLeaves.pop();
    return {
      leaves: mergedLeaves,
      leadingBreakCount,
      trailingBreakCount,
    };
  }

  function wrapMarkupSignatureContent(content: string, mark: InlineMark) {
    if (!content) {
      return "";
    }

    if (mark.tag === "comment") {
      return `<span data-inline-comment=true>${content}</span>`;
    }

    if (mark.tag === "a") {
      const href = mark.href ? ` href=${JSON.stringify(mark.href)}` : "";
      return `<a${href}>${content}</a>`;
    }

    return `<${mark.tag}>${content}</${mark.tag}>`;
  }

  function serializeInlineLeafForMarkupSignature(leaf: InlineLeaf) {
    if (leaf.type === "marker") {
      return "";
    }

    let content = leaf.type === "break"
      ? "<br>"
      : `text(${JSON.stringify(leaf.text.replaceAll("\u00a0", " "))})`;

    for (let index = leaf.marks.length - 1; index >= 0; index -= 1) {
      content = wrapMarkupSignatureContent(content, leaf.marks[index]);
    }

    return content;
  }

  function serializeInlineLeafToMarkdown(leaf: InlineLeaf) {
    if (leaf.type === "marker") {
      return "";
    }

    let content = leaf.type === "break"
      ? "\n"
      : escapeMarkdownText(leaf.text);

    for (let index = leaf.marks.length - 1; index >= 0; index -= 1) {
      content = wrapMarkdownWithInlineMark(content, leaf.marks[index]);
    }

    return content;
  }

  function serializeInlineRunContainerForMarkupSignature(element: HTMLElement, trimTrailingWhitespace: boolean) {
    const normalized = normalizeInlineLeavesForMarkupSignature(
      flattenInlineContent(element.childNodes),
      trimTrailingWhitespace,
    );

    return {
      leadingBreakCount: normalized.leadingBreakCount,
      content: normalized.leaves
        .map((leaf) => serializeInlineLeafForMarkupSignature(leaf))
        .filter(Boolean)
        .join(""),
      trailingBreakCount: normalized.trailingBreakCount,
    };
  }

  function isTrailingWhitespaceBoundaryTag(tag: string) {
    return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|li|summary)$/i.test(tag);
  }

  function serializeMarkupNode(node: Node, trimTrailingWhitespace = false): string {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "")
        .replaceAll("\u00a0", " ")
        .replace(/[ \t]+$/g, trimTrailingWhitespace ? "" : "$&");
      return text ? `text(${JSON.stringify(text)})` : "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const attributes = [];

    if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
      return "<br>";
    }

    if (tag === "a") {
      const href = element.getAttribute("href");
      if (href) {
        attributes.push(`href=${JSON.stringify(href)}`);
      }
    }

    if (element instanceof HTMLElement) {
      if (element.dataset.inlineComment === "true") {
        attributes.push("data-inline-comment=true");
      }

      if (element.dataset.blockComment === "true") {
        attributes.push("data-block-comment=true");
      }
    }

    if (tag === "pre") {
      const language = element instanceof HTMLElement
        ? element.dataset.language ?? ""
        : element.getAttribute("data-language") ?? "";
      if (language) {
        attributes.push(`data-language=${JSON.stringify(language)}`);
      }
    }

    const childNodes = Array.from(element.childNodes);
    const trimLastChild = trimTrailingWhitespace || isTrailingWhitespaceBoundaryTag(tag);
    const openingTag = attributes.length > 0
      ? `<${tag} ${attributes.join(" ")}>`
      : `<${tag}>`;

    if (tag === "br" || tag === "hr") {
      return openingTag;
    }

    if (element instanceof HTMLElement && isInlineRunContainer(element)) {
      const children = serializeInlineRunContainerForMarkupSignature(
        element,
        trimLastChild && tag !== "pre" && tag !== "code",
      );
      return `${"<br>".repeat(children.leadingBreakCount)}${openingTag}${children.content}</${tag}>${"<br>".repeat(children.trailingBreakCount)}`;
    }

    const lastChildIndex = childNodes.length - 1;
    const children = childNodes
      .map((childNode, index) => serializeMarkupNode(
        childNode,
        trimLastChild && index === lastChildIndex && tag !== "pre" && tag !== "code",
      ))
      .join("");

    return `${openingTag}${children}</${tag}>`;
  }

  function inspectSaveGuard() {
    const editorSnapshot = editor.cloneNode(true) as HTMLDivElement;
    const markdown = editorToMarkdown(editorSnapshot);
    const currentMarkup = createMarkupSignature(editorSnapshot);
    const roundTripRoot = document.createElement("div");
    roundTripRoot.innerHTML = renderMarkdownToHtml(markdown);
    normalizeEditorMarkup(roundTripRoot);

    const roundTripMarkup = createMarkupSignature(roundTripRoot);
    const issue = currentMarkup === roundTripMarkup
      ? null
      : { markdown, currentMarkup, roundTripMarkup } satisfies SaveGuardIssue;

    return { markdown, issue };
  }

  function refreshSaveGuardState() {
    if (!state.currentPath || state.mode !== "rich") {
      state.currentContent = "";
      state.saveIssue = null;
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      return { markdown: "", issue: null };
    }

    const inspection = inspectSaveGuard();
    state.saveIssue = inspection.issue;
    syncSaveIssueLogging(inspection.issue, "markup mismatch detected while editing");
    updateSaveButtonState();
    return inspection;
  }

  function diffRowsAgainstHead(headRows: DiffRow[], currentRows: DiffRow[]) {
    const rowCount = headRows.length;
    const columnCount = currentRows.length;
    const dp = Array.from(
      { length: rowCount + 1 },
      () => new Uint32Array(columnCount + 1),
    );

    for (let rowIndex = rowCount - 1; rowIndex >= 0; rowIndex -= 1) {
      for (let columnIndex = columnCount - 1; columnIndex >= 0; columnIndex -= 1) {
        if (headRows[rowIndex].signature === currentRows[columnIndex].signature) {
          dp[rowIndex][columnIndex] = dp[rowIndex + 1][columnIndex + 1] + 1;
        } else {
          dp[rowIndex][columnIndex] = Math.max(
            dp[rowIndex + 1][columnIndex],
            dp[rowIndex][columnIndex + 1],
          );
        }
      }
    }

    const operations: Array<
      | { type: "equal"; row: DiffRow }
      | { type: "insert"; row: DiffRow }
      | { type: "delete"; row: DiffRow }
    > = [];
    let rowIndex = 0;
    let columnIndex = 0;

    while (rowIndex < rowCount || columnIndex < columnCount) {
      if (
        rowIndex < rowCount
        && columnIndex < columnCount
        && headRows[rowIndex].signature === currentRows[columnIndex].signature
      ) {
        operations.push({ type: "equal", row: currentRows[columnIndex] });
        rowIndex += 1;
        columnIndex += 1;
        continue;
      }

      const canInsert = columnIndex < columnCount;
      const canDelete = rowIndex < rowCount;

      if (
        canInsert
        && (!canDelete || dp[rowIndex][columnIndex + 1] >= dp[rowIndex + 1][columnIndex])
      ) {
        operations.push({ type: "insert", row: currentRows[columnIndex] });
        columnIndex += 1;
        continue;
      }

      if (canDelete) {
        operations.push({ type: "delete", row: headRows[rowIndex] });
        rowIndex += 1;
      }
    }

    const currentMarkers = new Map<string, DiffMarkerSymbol>();
    const deletedPlacements: DeletedMarkerPlacement[] = [];
    let previousEqualPath: string | null = null;

    for (let operationIndex = 0; operationIndex < operations.length;) {
      const operation = operations[operationIndex];
      if (operation.type === "equal") {
        previousEqualPath = operation.row.path;
        operationIndex += 1;
        continue;
      }

      const insertedPaths: string[] = [];
      let deletedCount = 0;

      while (operationIndex < operations.length && operations[operationIndex].type !== "equal") {
        const currentOperation = operations[operationIndex];
        if (currentOperation.type === "insert") {
          insertedPaths.push(currentOperation.row.path);
        } else {
          deletedCount += 1;
        }
        operationIndex += 1;
      }

      const nextEqualPath = operationIndex < operations.length
        ? operations[operationIndex].row.path
        : null;

      if (insertedPaths.length && deletedCount) {
        insertedPaths.forEach((path) => {
          currentMarkers.set(path, "*");
        });
        continue;
      }

      if (insertedPaths.length) {
        insertedPaths.forEach((path) => {
          currentMarkers.set(path, "+");
        });
        continue;
      }

      if (deletedCount) {
        deletedPlacements.push({
          afterPath: previousEqualPath,
          beforePath: nextEqualPath,
        });
      }
    }

    return { currentMarkers, deletedPlacements };
  }

  function getEditorLineHeight() {
    const computedStyle = window.getComputedStyle(editor);
    const parsedLineHeight = Number.parseFloat(computedStyle.lineHeight);
    if (Number.isFinite(parsedLineHeight)) {
      return parsedLineHeight;
    }

    const parsedFontSize = Number.parseFloat(computedStyle.fontSize);
    if (Number.isFinite(parsedFontSize)) {
      return parsedFontSize * 1.72;
    }

    return 24;
  }

  function getAnchorMetrics(element: HTMLElement) {
    const rect = element.getClientRects()[0];
    if (!rect || rect.height === 0) {
      return null;
    }

    const shellRect = editorShell.getBoundingClientRect();
    const top = rect.top - shellRect.top;
    const bottom = rect.bottom - shellRect.top;

    return {
      top,
      center: top + (bottom - top) / 2,
      bottom,
    } satisfies DiffAnchorMetrics;
  }

  function resolveDeletedMarkerTop(
    placement: DeletedMarkerPlacement,
    anchorMetrics: Map<string, DiffAnchorMetrics>,
    lineHeight: number,
  ) {
    const previousMetrics = placement.afterPath
      ? anchorMetrics.get(placement.afterPath) ?? null
      : null;
    const nextMetrics = placement.beforePath
      ? anchorMetrics.get(placement.beforePath) ?? null
      : null;

    if (previousMetrics !== null && nextMetrics !== null) {
      const gapStart = previousMetrics.bottom;
      const gapEnd = nextMetrics.top;

      if (gapEnd > gapStart) {
        return gapStart + (gapEnd - gapStart) / 2;
      }

      return previousMetrics.bottom + (nextMetrics.top - previousMetrics.bottom) / 2;
    }

    if (nextMetrics !== null) {
      return Math.max(0, nextMetrics.top - lineHeight * 0.5);
    }

    if (previousMetrics !== null) {
      return previousMetrics.bottom + lineHeight * 0.5;
    }

    return Math.max(0, lineHeight * 0.5);
  }

  function createDiffMarker(symbol: DiffMarkerSymbol, top: number) {
    const marker = document.createElement("span");
    marker.className = "editor-diff-marker";
    marker.dataset.markerType = symbol === "+" ? "insert" : symbol === "-" ? "delete" : "modify";
    marker.style.top = `${Math.max(0, top)}px`;
    marker.append(createDiffMarkerIcon(symbol));
    return marker;
  }

  function createDiffMarkerIcon(symbol: DiffMarkerSymbol) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("editor-diff-marker-icon");

    if (symbol === "*") {
      const asterisk = document.createElementNS("http://www.w3.org/2000/svg", "path");
      asterisk.setAttribute("d", "M10 4.35v11.3M5.15 7.15l9.7 5.7M14.85 7.15l-9.7 5.7");
      asterisk.setAttribute("stroke", "currentColor");
      asterisk.setAttribute("stroke-width", "2.25");
      asterisk.setAttribute("stroke-linecap", "round");
      asterisk.setAttribute("stroke-linejoin", "round");
      svg.append(asterisk);
      return svg;
    }

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2.45");
    line.setAttribute("stroke-linecap", "round");

    if (symbol === "+") {
      line.setAttribute("d", "M10 5.2v9.6M5.2 10h9.6");
    } else {
      line.setAttribute("d", "M5.2 10h9.6");
    }

    svg.append(line);
    return svg;
  }

  function renderDiffGutter() {
    diffGutter.replaceChildren();

    if (!state.currentPath || state.mode !== "rich") {
      return;
    }

    const currentRows = flattenMarkdownDiffRows(state.currentContent);
    const headRows = flattenMarkdownDiffRows(state.headContent);
    const { currentMarkers, deletedPlacements } = diffRowsAgainstHead(headRows, currentRows);

    if (!currentMarkers.size && !deletedPlacements.length) {
      return;
    }

    const anchorMetrics = new Map<string, DiffAnchorMetrics>();
    for (const anchor of flattenLiveDiffAnchors(editor)) {
      const metrics = getAnchorMetrics(anchor.element);
      if (metrics === null) {
        continue;
      }

      anchorMetrics.set(anchor.path, metrics);
    }

    const markers: Array<{ symbol: DiffMarkerSymbol; top: number }> = [];

    for (const [path, symbol] of currentMarkers) {
      const metrics = anchorMetrics.get(path);
      if (!metrics) {
        continue;
      }

      markers.push({ symbol, top: metrics.center });
    }

    const lineHeight = getEditorLineHeight();
    for (const placement of deletedPlacements) {
      markers.push({
        symbol: "-",
        top: resolveDeletedMarkerTop(placement, anchorMetrics, lineHeight),
      });
    }

    markers
      .sort((left, right) => left.top - right.top)
      .forEach(({ symbol, top }) => {
        diffGutter.append(createDiffMarker(symbol, top));
      });
  }

  function scheduleDiffGutterRefresh() {
    if (diffRefreshFrameId !== null) {
      window.cancelAnimationFrame(diffRefreshFrameId);
    }

    diffRefreshFrameId = window.requestAnimationFrame(() => {
      diffRefreshFrameId = null;
      renderDiffGutter();
    });
  }

  function inspectCurrentDraft() {
    if (!state.currentPath) {
      state.currentContent = "";
      state.dirty = false;
      state.expectedMtimeMs = null;
      state.saveIssue = null;
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      return { content: "", issue: null };
    }

    if (state.mode !== "rich") {
      state.saveIssue = null;
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      const content = editor.textContent ?? "";
      state.currentContent = content;
      state.dirty = content !== state.baselineContent;
      return { content, issue: null };
    }

    const inspection = refreshSaveGuardState();
    state.currentContent = inspection.markdown;
    state.dirty = inspection.markdown !== state.baselineContent;
    return {
      content: inspection.markdown,
      issue: inspection.issue,
    };
  }

  function createConsolePreview(value: string, maxLength = 320) {
    if (value.length <= maxLength) {
      return value || "(empty)";
    }

    const edgeLength = Math.max(40, Math.floor((maxLength - 5) / 2));
    return `${value.slice(0, edgeLength)}\n...\n${value.slice(-edgeLength)}`;
  }

  function logSaveGuardIssue(issue: SaveGuardIssue, trigger: string) {
    const difference = describeFirstDifference(issue.currentMarkup, issue.roundTripMarkup);
    const report = [
      "[workbench] UNSAFE MARKDOWN SAVE BLOCKED",
      `file: ${state.currentPath}`,
      `trigger: ${trigger}`,
      "reason: serializing the current WYSIWYG editor content to markdown and rendering it again would change the editor markup.",
      `first differing character: ${difference.index}`,
      "",
      "current editor markup around the mismatch:",
      difference.currentExcerpt || "(empty)",
      "",
      "round-tripped markup around the mismatch:",
      difference.roundTripExcerpt || "(empty)",
    ].join("\n");

    console.warn(report);
    console.warn("[workbench] Save blocked metadata", {
      filePath: state.currentPath,
      trigger,
      firstDifferenceIndex: difference.index,
      currentMarkupLength: issue.currentMarkup.length,
      currentMarkupExcerpt: difference.currentExcerpt || "(empty)",
      roundTripMarkupLength: issue.roundTripMarkup.length,
      roundTripMarkupExcerpt: difference.roundTripExcerpt || "(empty)",
      markdownLength: issue.markdown.length,
      markdown: issue.markdown,
    });
  }

  function syncSaveIssueLogging(issue: SaveGuardIssue | null, trigger: string, force = false) {
    if (!issue) {
      state.lastLoggedSaveIssue = null;
      return;
    }

    if (!force && isSameSaveGuardIssue(state.lastLoggedSaveIssue, issue)) {
      return;
    }

    logSaveGuardIssue(issue, trigger);
    state.lastLoggedSaveIssue = { ...issue };
  }

  function describeFirstDifference(currentMarkup: string, roundTripMarkup: string) {
    const limit = Math.min(currentMarkup.length, roundTripMarkup.length);
    let index = 0;

    while (index < limit && currentMarkup[index] === roundTripMarkup[index]) {
      index += 1;
    }

    if (index === limit && currentMarkup.length === roundTripMarkup.length) {
      index = -1;
    }

    const excerptStart = Math.max(0, (index === -1 ? limit : index) - 80);
    const excerptEnd = Math.min(
      Math.max(currentMarkup.length, roundTripMarkup.length),
      (index === -1 ? limit : index) + 120,
    );

    return {
      index,
      currentExcerpt: currentMarkup.slice(excerptStart, excerptEnd),
      roundTripExcerpt: roundTripMarkup.slice(excerptStart, excerptEnd),
    };
  }

  function wrapMarkdownWithInlineMark(content: string, mark: InlineMark) {
    switch (mark.tag) {
      case "strong":
        return `__${content}__`;
      case "em":
        return content.includes("*") ? `_${content}_` : `*${content}*`;
      case "code":
        return `\`${content.replaceAll("`", "\\`")}\``;
      case "comment": {
        return formatInlineCommentMarkdown(content);
      }
      case "a":
        return `[${content || mark.href || ""}](${mark.href ?? ""})`;
      case "del":
        return `<del>${content}</del>`;
      case "ins":
        return `<ins>${content}</ins>`;
      default:
        return content;
    }
  }

  function serializeInlineNodes(nodes: ArrayLike<Node>) {
    return normalizeInlineLeavesForSerialization(
      flattenInlineContent(Array.from(nodes)),
    )
      .map((leaf) => serializeInlineLeafToMarkdown(leaf))
      .join("");
  }

  function serializeInlineNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeMarkdownText(node.textContent ?? "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const inner = serializeInlineNodes(element.childNodes);

    switch (tag) {
      case "strong":
      case "b":
        return `__${inner}__`;
      case "em":
      case "i":
        return inner.includes("*") ? `_${inner}_` : `*${inner}*`;
      case "code":
        return `\`${(element.textContent ?? "").replaceAll("`", "\\`")}\``;
      case "a": {
        const href = element.getAttribute("href") ?? "";
        return `[${inner || href}](${href})`;
      }
      case "del":
      case "s":
      case "strike":
        return `<del>${inner}</del>`;
      case "ins":
        return `<ins>${inner}</ins>`;
      case "span":
        if (element instanceof HTMLElement && element.dataset.inlineComment === "true") {
          return formatInlineCommentMarkdown(inner);
        }
        return inner;
      case "br":
        return "\n";
      default:
        return inner;
    }
  }

  function serializeParagraph(node: Element) {
    return serializeInlineNodes(node.childNodes).replace(/\n{3,}/g, "\n\n");
  }

  function serializeListItemMainText(item: Element) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      const summary = getDirectChildSummaryElement(details);
      return summary ? serializeParagraph(summary).trim() : "";
    }

    const contentNodes = Array.from(item.childNodes).filter((node) => {
      return !(node instanceof Element && isListElement(node));
    });
    return serializeInlineNodes(contentNodes).replace(/\n{3,}/g, "\n\n").trimEnd().trim();
  }

  function getNestedListElementsForItem(item: Element) {
    const details = getDirectChildDetailsElement(item);
    return details
      ? getDirectChildListElements(details)
      : getDirectChildListElements(item);
  }

  function serializeListElement(node: Element, indent = 0) {
    const listType = node.tagName.toLowerCase();
    if (listType !== "ul" && listType !== "ol") {
      return "";
    }

    return Array.from(node.children)
      .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement)
      .map((item, index) => {
        const prefix = listType === "ol" ? `${index + 1}. ` : "- ";
        const text = serializeListItemMainText(item);
        const line = text
          ? `${" ".repeat(indent)}${prefix}${text}`.trimEnd()
          : `${" ".repeat(indent)}${prefix}`;
        const nested = getNestedListElementsForItem(item)
          .map((childList) => serializeListElement(childList, indent + 2))
          .filter(Boolean)
          .join("\n");

        return nested ? `${line}\n${nested}` : line;
      })
      .join("\n");
  }

  function serializeBlockElement(node: Element): SerializedBlock {
    const tag = node.tagName.toLowerCase();
    const rawText = node.textContent ?? "";
    const parsedCommentBody = parseBlockCommentBody(rawText);

    if (node instanceof HTMLElement && (node.dataset.blockComment === "true" || parsedCommentBody !== null)) {
      const commentBody = parsedCommentBody ?? serializeParagraph(node).replace(/\n+/g, " ").trim();
      return {
        kind: "block",
        isComment: true,
        text: formatBlockCommentLine(commentBody),
      };
    }

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return {
          kind: "block",
          isComment: false,
          text: `${"#".repeat(Number.parseInt(tag.slice(1), 10))} ${serializeParagraph(node).trim()}`.trimEnd(),
        };
      case "ul":
        return {
          kind: "list",
          isComment: false,
          text: serializeListElement(node),
        };
      case "ol":
        return {
          kind: "list",
          isComment: false,
          text: serializeListElement(node),
        };
      case "blockquote":
        return {
          kind: "block",
          isComment: false,
          text: serializeParagraph(node)
            .split("\n")
            .map((line) => `> ${line}`.trimEnd())
            .join("\n"),
        };
      case "pre": {
        const language = node instanceof HTMLElement ? node.dataset.language ?? "" : "";
        const code = node.textContent?.replace(/\n$/, "") ?? "";
        return {
          kind: "block",
          isComment: false,
          text: `\`\`\`${language}\n${code}\n\`\`\``,
        };
      }
      case "hr":
        return {
          kind: "block",
          isComment: false,
          text: "---",
        };
      case "div":
      case "p":
      default:
        return {
          kind: "block",
          isComment: false,
          text: serializeParagraph(node),
        };
    }
  }

  function serializeMarkdownTokens(tokens: SerializedMarkdownToken[]) {
    let markdown = "";
    let pendingBreakCount = 0;
    let previousBlock: SerializedBlock | null = null;

    for (const token of tokens) {
      if (token.type === "break") {
        pendingBreakCount += token.count;
        continue;
      }

      if (!token.block.text) {
        pendingBreakCount = 0;
        continue;
      }

      if (!previousBlock) {
        if (pendingBreakCount > 0 && token.block.isComment) {
          markdown += "\n".repeat(pendingBreakCount);
        }
        markdown += token.block.text;
      } else {
        const baseSeparator = previousBlock.isComment || token.block.isComment ? "\n" : "\n\n";
        const extraBreakCount = previousBlock.isComment || token.block.isComment
          ? pendingBreakCount
          : previousBlock.kind === "list" && token.block.kind === "list"
            ? Math.max(0, pendingBreakCount - 1)
            : pendingBreakCount;
        markdown += `${baseSeparator}${"\n".repeat(extraBreakCount)}${token.block.text}`;
      }

      previousBlock = token.block;
      pendingBreakCount = 0;
    }

    if (pendingBreakCount > 0 && previousBlock?.isComment) {
      markdown += "\n".repeat(pendingBreakCount);
    }

    return markdown.endsWith("\n")
      ? markdown
      : `${markdown}\n`;
  }

  function editorToMarkdown(sourceRoot: ParentNode = editor) {
    normalizeEditorMarkup(sourceRoot);
    const tokens: SerializedMarkdownToken[] = [];
    let inlineNodes: Node[] = [];
    let pendingBreakCount = 0;

    const flushPendingBreaks = () => {
      if (!pendingBreakCount) {
        return;
      }

      tokens.push({ type: "break", count: pendingBreakCount });
      pendingBreakCount = 0;
    };

    const flushInlineNodes = () => {
      if (!inlineNodes.length) {
        return;
      }

      const text = serializeInlineNodes(inlineNodes).replace(/\n{3,}/g, "\n\n").trimEnd();
      if (text) {
        flushPendingBreaks();
        tokens.push({
          type: "block",
          block: {
            kind: "block",
            isComment: isBlockCommentLine(text),
            text,
          },
        });
      }
      inlineNodes = [];
    };

    for (const node of sourceRoot.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? "").trim()) {
          inlineNodes.push(node);
        }
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const element = node as Element;

      if (isIntentionalListBreakParagraph(element)) {
        flushInlineNodes();
        pendingBreakCount += 1;
        continue;
      }

      if (element.tagName === "BR") {
        flushInlineNodes();
        pendingBreakCount += 1;
        continue;
      }

      if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
        flushInlineNodes();
        pendingBreakCount += 1;
        continue;
      }

      if (blockTags.has(element.tagName)) {
        flushInlineNodes();
        flushPendingBreaks();
        const block = serializeBlockElement(element);
        if (block.text) {
          tokens.push({ type: "block", block });
        }
        continue;
      }

      inlineNodes.push(node);
    }

    flushInlineNodes();
    flushPendingBreaks();
    return serializeMarkdownTokens(tokens);
  }

  function canonicalizeRichMarkdown(content: string) {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownToHtml(content);
    return editorToMarkdown(root);
  }

  function renderEditorDocument(content: string, mode: EditorMode) {
    state.mode = mode;
    editor.dataset.placeholder = mode === "rich"
      ? "Select a markdown file to start editing."
      : "Plain text mode";

    if (mode === "rich") {
      editor.innerHTML = renderMarkdownToHtml(content);
    } else {
      editor.textContent = content;
    }

    applyEditorFontSize();
    syncStructuredBlockStyles();
    editor.scrollTop = 0;
  }

  function setEditorContent(content: string, mode: EditorMode) {
    renderEditorDocument(content, mode);
    setHoveredRevisionNode(null);
    clearPendingInlineFormats();
    if (mode === "rich") {
      state.baselineContent = refreshSaveGuardState().markdown;
      state.currentContent = state.baselineContent;
    } else {
      state.baselineContent = content;
      state.currentContent = content;
      state.saveIssue = null;
      updateSaveButtonState();
    }
    state.dirty = false;
    state.history = createInitialEditHistory(state.currentContent);
    updateStatusLine();
    scheduleDiffGutterRefresh();
    updateCustomCaret();
  }

  function applyFilePayloadToCurrentFile(
    payload: FilePayload,
    {
      preserveSelection = false,
      statusMessage,
    }: {
      preserveSelection?: boolean;
      statusMessage?: string;
    } = {},
  ) {
    const mode = isMarkdownFile(payload.path) ? "rich" : "plain";
    const selectionSnapshot = preserveSelection ? captureEditorSelection() : null;

    clearWriteConflict();
    setCurrentThread(null);
    state.currentPath = payload.path;
    state.currentThreadId = "";
    state.expectedMtimeMs = payload.mtimeMs;
    state.headContent = payload.headContent;
    filePathLabel.textContent = payload.path;
    editor.setAttribute("contenteditable", isTextLikeFile(payload.path) ? "true" : "false");
    renderEditorDocument(payload.content, mode);
    if (mode === "rich") {
      state.baselineContent = refreshSaveGuardState().markdown;
      state.currentContent = state.baselineContent;
    } else {
      state.baselineContent = payload.content;
      state.currentContent = payload.content;
      state.saveIssue = null;
      updateSaveButtonState();
    }
    state.mode = mode;
    state.dirty = false;
    state.history = createInitialEditHistory(state.currentContent);
    state.pendingWriteConflict = null;
    state.saveIssue = null;
    state.lastLoggedSaveIssue = null;

    if (selectionSnapshot) {
      restoreEditorSelection(selectionSnapshot);
      updateHistorySelection(captureEditorSelection());
    }

    updateStatusLine(statusMessage);
    scheduleDiffGutterRefresh();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }

  function applyHistoryState(history: EditHistoryState, nextIndex: number) {
    const clampedIndex = Math.max(0, Math.min(nextIndex, history.frames.length - 1));
    const nextContent = materializeHistoryContent(history, clampedIndex);
    history.currentIndex = clampedIndex;
    state.history = history;

    clearPendingInlineFormats();
    renderEditorDocument(nextContent, state.mode);
    inspectCurrentDraft();
    restoreEditorSelection(history.frames[clampedIndex]?.selection ?? null);
    updateHistorySelection(captureEditorSelection());
    syncCurrentDraftBuffer();
    scheduleDiffGutterRefresh();
    updateStatusLine();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }

  function undoEditHistory() {
    if (!state.history || state.history.currentIndex <= 0) {
      return;
    }

    applyHistoryState(normalizeEditHistory(state.history, state.currentContent), state.history.currentIndex - 1);
  }

  function redoEditHistory() {
    if (!state.history || state.history.currentIndex >= state.history.frames.length - 1) {
      return;
    }

    applyHistoryState(normalizeEditHistory(state.history, state.currentContent), state.history.currentIndex + 1);
  }

  async function fetchFilePayload(filePath: string) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to open file." }));
      statusLine.textContent = error.error;
      return null;
    }

    return await response.json() as FilePayload;
  }

  async function fetchThreadPayload(threadId: string) {
    const response = await fetch(`/api/codex/thread?threadId=${encodeURIComponent(threadId)}`, { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to open Codex thread.", detail: "" }));
      statusLine.textContent = error.detail ? `${error.error} ${error.detail}` : error.error;
      return null;
    }

    return await response.json() as ThreadPayload;
  }

  async function refreshThreads() {
    try {
      const response = await fetch("/api/codex/threads", { cache: "no-store" });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unable to load Codex threads.", detail: "" }));
        state.threads = [];
        state.threadsError = error.detail ? `${error.error} ${error.detail}` : error.error;
        return;
      }

      const payload = await response.json() as { threads: ThreadSummary[] };
      state.threads = [...payload.threads].sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }

        return left.id.localeCompare(right.id);
      });
      state.threadsError = "";
    } catch (error) {
      state.threads = [];
      state.threadsError = error instanceof Error ? error.message : "Unable to load Codex threads.";
    }
  }

  function isCurrentThreadUpToDate(threadId: string) {
    const currentThread = state.currentThread;
    if (!currentThread || currentThread.id !== threadId) {
      return false;
    }

    if (getCurrentInProgressTurn(currentThread)) {
      return false;
    }

    const threadSummary = state.threads.find((thread) => thread.id === threadId);
    if (!threadSummary) {
      return false;
    }

    return currentThread.updatedAt === threadSummary.updatedAt
      && currentThread.status === threadSummary.status;
  }

  function cloneUserInput(input: UserInput): UserInput {
    switch (input.type) {
      case "text":
        return {
          ...input,
          text_elements: [...input.text_elements],
        };
      default:
        return { ...input };
    }
  }

  function doesUserMessageMatchInput(
    item: ThreadPayload["turns"][number]["items"][number],
    input: UserInput[],
  ) {
    if (item.type !== "userMessage" || item.content.length !== input.length) {
      return false;
    }

    return item.content.every((content, index) => {
      const nextInput = input[index];
      if (!nextInput || content.type !== nextInput.type) {
        return false;
      }

      switch (nextInput.type) {
        case "text":
          return content.type === "text"
            && content.text.trim() === nextInput.text.trim();
        case "image":
          return content.type === "image"
            && content.url === nextInput.url;
        case "localImage":
          return content.type === "localImage"
            && content.path === nextInput.path;
        case "skill":
          return content.type === "skill"
            && content.name === nextInput.name
            && content.path === nextInput.path;
        case "mention":
          return content.type === "mention"
            && content.name === nextInput.name
            && content.path === nextInput.path;
        default:
          return false;
      }
    });
  }

  function createOptimisticUserMessage(input: UserInput[]): Extract<ThreadPayload["turns"][number]["items"][number], { type: "userMessage" }> {
    return {
      type: "userMessage",
      id: `optimistic-user-message:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      content: input.map((entry) => cloneUserInput(entry)),
    };
  }

  function applyOptimisticSteerMessage(
    payload: ThreadPayload,
    previousThread: ThreadPayload | null,
    input: UserInput[],
  ) {
    const previousTargetTurn = getCurrentInProgressTurn(previousThread);
    if (!previousTargetTurn) {
      return payload;
    }

    const nextTurnIndex = payload.turns.findIndex((turn) => turn.id === previousTargetTurn.id);
    if (nextTurnIndex === -1) {
      return payload;
    }

    const nextTurn = payload.turns[nextTurnIndex];
    if (nextTurn.status !== "inProgress") {
      return payload;
    }

    const newItems = nextTurn.items.slice(previousTargetTurn.items.length);
    if (newItems.some((item) => doesUserMessageMatchInput(item, input))) {
      return payload;
    }

    return {
      ...payload,
      turns: payload.turns.map((turn, index) => (
        index === nextTurnIndex
          ? {
            ...turn,
            items: [...turn.items, createOptimisticUserMessage(input)],
          }
          : turn
      )),
    };
  }

  function applyThreadPayloadToCurrentView(payload: ThreadPayload, statusMessage?: string) {
    clearWriteConflict();
    setCurrentThread(payload);
    state.currentPath = "";
    state.currentThreadId = payload.id;
    state.expectedMtimeMs = null;
    state.headContent = null;
    state.pendingWriteConflict = null;
    state.saveIssue = null;
    state.lastLoggedSaveIssue = null;
    editor.dataset.placeholder = "Select a markdown file to start editing.";
    filePathLabel.textContent = payload.name || payload.preview || payload.id;
    editor.setAttribute("contenteditable", "false");
    editor.textContent = "";
    editor.scrollTop = 0;
    state.baselineContent = "";
    state.currentContent = "";
    state.mode = "rich";
    state.dirty = false;
    state.history = null;
    clearPendingInlineFormats();
    setHoveredRevisionNode(null);
    updateSaveButtonState();
    updateStatusLine(statusMessage);
    scheduleDiffGutterRefresh();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }

  async function openThread(
    threadId: string,
    { source = "open" }: { source?: "open" | "reload" } = {},
  ) {
    if (source === "open" && threadId === state.currentThreadId) {
      return;
    }

    if (state.currentPath) {
      syncCurrentDraftBuffer();
    }

    const payload = await fetchThreadPayload(threadId);
    if (!payload) {
      return;
    }

    applyThreadPayloadToCurrentView(payload, `Read thread ${new Date(payload.updatedAt * 1000).toLocaleString()}`);
    syncCurrentSelectionToUrl({ threadId: payload.id });
    emitExplorerStateChange();
  }

  async function sendThreadMessage(threadId: string, input: UserInput[]) {
    const previousThread = state.currentThread && state.currentThread.id === threadId
      ? state.currentThread
      : null;
    const runtimeInput = input as UserInput[] | string;
    const textFallback = Array.isArray(runtimeInput)
      ? runtimeInput.find((entry) => entry.type === "text")?.text ?? ""
      : typeof runtimeInput === "string"
        ? runtimeInput
        : "";

    const response = await fetch("/api/codex/thread", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: runtimeInput,
        text: textFallback,
        threadId,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to send the Codex thread message.", detail: "" }));
      throw new Error(error.detail ? `${error.error} ${error.detail}` : error.error);
    }

    const payload = applyOptimisticSteerMessage(
      await response.json() as ThreadPayload,
      previousThread,
      Array.isArray(runtimeInput) ? runtimeInput : [{ type: "text", text: textFallback, text_elements: [] }],
    );
    applyThreadPayloadToCurrentView(payload, "Sent message.");
    syncCurrentSelectionToUrl({ threadId: payload.id });
    await refreshThreads();
    emitExplorerStateChange();
  }

  async function openFile(filePath: string, { ignoreDirty = false, source = "open" }: { ignoreDirty?: boolean; source?: "open" | "reload" } = {}) {
    if (source === "open" && filePath === state.currentPath) {
      return;
    }

    if (state.currentPath) {
      syncCurrentDraftBuffer();
    }

    if (source !== "reload") {
      const bufferedDraft = state.draftBuffers.get(filePath);
      if (bufferedDraft) {
        editor.setAttribute("contenteditable", isTextLikeFile(filePath) ? "true" : "false");
        restoreDraftBuffer(filePath, bufferedDraft);
    syncCurrentSelectionToUrl({ filePath });
        updateStatusLine(`Opened draft`);
        expandPath(filePath);
        emitExplorerStateChange();
        return;
      }
    }

    const payload = await fetchFilePayload(filePath);
    if (!payload) {
      return;
    }

    if (source === "reload") {
      state.draftBuffers.delete(filePath);
      void persistDraftBuffer(filePath, null);
    }

    applyFilePayloadToCurrentFile(payload, {
      statusMessage: `${source === "reload" ? "Reloaded" : "Read"} ${formatTimestamp(payload.updatedAt)}`,
    });
    syncCurrentSelectionToUrl({ filePath: payload.path });
    expandPath(payload.path);
    emitExplorerStateChange();
  }

  async function resetCurrentDraftToSaved() {
    hideResetDraftDialog();
    if (!state.currentPath) {
      return;
    }

    await openFile(state.currentPath, { ignoreDirty: true, source: "reload" });
    editor.focus();
  }

  async function resetCurrentFileToHead() {
    hideResetDraftDialog();
    if (!state.currentPath) {
      return;
    }

    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: state.currentPath,
        resetToHead: true,
        expectedMtimeMs: state.expectedMtimeMs,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to reset file to HEAD." }));
      if (response.status === 409) {
        showWriteConflict(error as SaveConflictPayload);
        syncCurrentDraftBuffer();
        updateStatusLine();
        return;
      }

      statusLine.textContent = error.error;
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    state.changes = payload.changes;
    emitExplorerStateChange();
    await openFile(state.currentPath, { ignoreDirty: true, source: "reload" });
    updateStatusLine(`Reset to HEAD - ${formatTimestamp(payload.updatedAt)}`);
    editor.focus();
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    const response = await fetch("/api/tree", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parentPath,
        name,
        type,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to create entry." }));
      throw new Error(error.error);
    }

    const payload = await response.json() as CreateEntryPayload;
    state.root = payload.root;
    state.rootPath = payload.rootPath;
    state.tree = payload.tree;
    state.changes = payload.changes;

    if (parentPath) {
      state.expandedDirectories.add(parentPath);
    }
    if (type === "directory") {
      state.expandedDirectories.add(payload.path);
    }

    persistExpandedDirectories(state.expandedDirectories);
    emitExplorerStateChange();

    if (type === "file") {
      await openFile(payload.path);
      updateStatusLine(`Created ${payload.path}`);
    } else {
      updateStatusLine(`Created ${payload.path}`);
    }

    return payload.path;
  }

  function expandPath(filePath: string) {
    let didExpand = false;
    const segments = filePath.split("/");
    let current = "";

    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      if (!state.expandedDirectories.has(current)) {
        state.expandedDirectories.add(current);
        didExpand = true;
      }
    }

    if (didExpand) {
      persistExpandedDirectories(state.expandedDirectories);
    }
  }

  function updateStatusLine(message = "") {
    const change = describeChange(state.currentPath);

    if (message) {
      statusLine.textContent = message;
      return;
    }

      if (!state.currentPath) {
        if (state.currentThreadId) {
          statusLine.textContent = "Codex thread. Continue below.";
          return;
        }

      statusLine.textContent = "Markdown files open as rich text. Save with Ctrl/Cmd+S.";
      return;
    }

    if (state.saveIssue) {
      statusLine.textContent = "Save blocked: markup mismatch. Check the console log.";
      return;
    }

    if (state.pendingWriteConflict) {
      statusLine.textContent = "File changed on disk. Reload or overwrite to save.";
      return;
    }

    if (state.dirty) {
      statusLine.textContent = "Unsaved changes.";
      return;
    }

    if (change) {
      statusLine.textContent = `Pending changes ${change}`;
      return;
    }

    statusLine.textContent = state.mode === "rich"
      ? "Saved."
      : "Plain text file.";
  }

  async function saveCurrentFile({ force = false }: { force?: boolean } = {}) {
    if (!state.currentPath) {
      return;
    }

    const inspection = inspectCurrentDraft();

    if (inspection.issue) {
      syncSaveIssueLogging(inspection.issue, "save attempt blocked by markup mismatch", true);
      updateStatusLine();
      return;
    }

    const content = inspection.content;
    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: state.currentPath,
        content,
        expectedMtimeMs: state.expectedMtimeMs,
        force,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to save file." }));
      if (response.status === 409) {
        showWriteConflict(error as SaveConflictPayload);
        syncCurrentDraftBuffer();
        updateStatusLine();
        return;
      }
      statusLine.textContent = error.error;
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    state.baselineContent = content;
    state.currentContent = content;
    state.dirty = false;
    state.expectedMtimeMs = payload.mtimeMs;
    state.changes = payload.changes;
    state.lastLoggedSaveIssue = null;
    clearWriteConflict();
    state.draftBuffers.delete(state.currentPath);
    void persistDraftBuffer(state.currentPath, null);
    state.saveIssue = null;
    updateSaveButtonState();
    updateStatusLine(`Saved - ${formatTimestamp(payload.updatedAt)}`);
    emitExplorerStateChange();
    scheduleDiffGutterRefresh();
  }

  function getClosestListItem(node: Node | null) {
    let current: Node | null = node;

    while (current) {
      if (current instanceof HTMLLIElement && editor.contains(current)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function getSelectedListItems(selection: Selection) {
    if (!selection.rangeCount) {
      return [];
    }

    const range = selection.getRangeAt(0);
    if (selection.isCollapsed) {
      const listItem = getClosestListItem(range.startContainer);
      return listItem ? [listItem] : [];
    }

    const selectedItems = Array.from(editor.querySelectorAll("li")).filter((item) => range.intersectsNode(item));
    return selectedItems.filter((item) => {
      return !selectedItems.some((other) => other !== item && item.contains(other));
    });
  }

  function getListItemTextContainer(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    if (!details) {
      return item;
    }

    const summary = getDirectChildSummaryElement(details);
    if (!summary) {
      return details;
    }

    return getDirectChildSummaryTextElement(summary) ?? summary;
  }

  function getParentListElement(item: HTMLLIElement) {
    return item.parentElement instanceof HTMLUListElement || item.parentElement instanceof HTMLOListElement
      ? item.parentElement
      : null;
  }

  function getOrCreateDirectChildList(element: Element, listTagName: string) {
    const existingList = getDirectChildListElements(element).find((list) => list.tagName === listTagName);
    if (existingList) {
      return existingList;
    }

    const nextList = document.createElement(listTagName.toLowerCase());
    element.append(nextList);
    return nextList as HTMLUListElement | HTMLOListElement;
  }

  function getOrCreateNestedListForItem(item: HTMLLIElement, listTagName: string) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      return getOrCreateDirectChildList(details, listTagName);
    }

    return getOrCreateDirectChildList(item, listTagName);
  }

  function splitListItemRunsByParent(selectedItems: HTMLLIElement[]) {
    const runs: HTMLLIElement[][] = [];
    let currentRun: HTMLLIElement[] = [];

    for (const item of selectedItems) {
      const parentList = getParentListElement(item);
      if (!parentList) {
        if (currentRun.length) {
          runs.push(currentRun);
          currentRun = [];
        }
        continue;
      }

      const previousItem = currentRun[currentRun.length - 1];
      const previousParentList = previousItem ? getParentListElement(previousItem) : null;
      const isConsecutiveSibling = previousItem?.nextElementSibling === item;

      if (!currentRun.length || (previousParentList === parentList && isConsecutiveSibling)) {
        currentRun.push(item);
        continue;
      }

      runs.push(currentRun);
      currentRun = [item];
    }

    if (currentRun.length) {
      runs.push(currentRun);
    }

    return runs;
  }

  function restoreListItemSelection(items: HTMLLIElement[], { collapsed }: { collapsed: boolean }) {
    if (!items.length) {
      return;
    }

    const firstContainer = getListItemTextContainer(items[0]);
    const lastContainer = getListItemTextContainer(items[items.length - 1]);
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.setStart(firstContainer, 0);

    if (collapsed) {
      range.collapse(true);
    } else {
      range.setEnd(lastContainer, lastContainer.childNodes.length);
    }

    selection.removeAllRanges();
    selection.addRange(range);
  }

  function restoreParagraphSelection(paragraph: HTMLElement) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isSelectionAtElementStart(selection: Selection, element: HTMLElement) {
    if (!selection.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      return false;
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(element);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return beforeRange.toString().replaceAll("\u00a0", " ").trim() === "";
  }

  async function refreshCurrentFileFromDiskIfSafe() {
    if (
      !state.currentPath ||
      state.dirty ||
      state.saveIssue ||
      state.pendingWriteConflict
    ) {
      return;
    }

    const payload = await fetchFilePayload(state.currentPath);
    if (!payload || payload.mtimeMs === state.expectedMtimeMs) {
      return;
    }

    applyFilePayloadToCurrentFile(payload, {
      preserveSelection: true,
      statusMessage: `Updated from disk - ${formatTimestamp(payload.updatedAt)}`,
    });
    syncCurrentSelectionToUrl({ filePath: payload.path });
    emitExplorerStateChange();
  }

  function isSelectionAtElementEnd(selection: Selection, element: HTMLElement) {
    if (!selection.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      return false;
    }

    const afterRange = document.createRange();
    afterRange.selectNodeContents(element);
    afterRange.setStart(range.startContainer, range.startOffset);
    return afterRange.toString().replaceAll("\u00a0", " ").trim() === "";
  }

  function removeAdjacentCommentSpacing(element: HTMLElement) {
    let previousNode = element.previousSibling;
    while (previousNode) {
      const nextPreviousNode = previousNode.previousSibling;
      if (previousNode.nodeType === Node.TEXT_NODE && !(previousNode.textContent ?? "").trim()) {
        previousNode.remove();
        previousNode = nextPreviousNode;
        continue;
      }

      if (
        previousNode instanceof HTMLBRElement
        || (previousNode instanceof HTMLElement && isSingleBreakParagraph(previousNode))
      ) {
        previousNode.remove();
        previousNode = nextPreviousNode;
        continue;
      }

      break;
    }

    let nextNode = element.nextSibling;
    while (nextNode) {
      const nextNextNode = nextNode.nextSibling;
      if (nextNode.nodeType === Node.TEXT_NODE && !(nextNode.textContent ?? "").trim()) {
        nextNode.remove();
        nextNode = nextNextNode;
        continue;
      }

      if (
        nextNode instanceof HTMLBRElement
        || (nextNode instanceof HTMLElement && isSingleBreakParagraph(nextNode))
      ) {
        nextNode.remove();
        nextNode = nextNextNode;
        continue;
      }

      break;
    }
  }

  function convertCommentBlockToParagraph(paragraph: HTMLElement) {
    const commentBody = parseBlockCommentBody(paragraph.textContent ?? "") ?? (paragraph.textContent ?? "");
    paragraph.removeAttribute("data-block-comment");
    setPlainBlockText(paragraph, commentBody);
    removeAdjacentCommentSpacing(paragraph);
  }

  function outdentListItems(selectedItems: HTMLLIElement[]) {
    const movedItems: HTMLLIElement[] = [];

    for (const run of splitListItemRunsByParent(selectedItems)) {
      const firstItem = run[0];
      const lastItem = run[run.length - 1];
      const parentList = getParentListElement(firstItem);
      if (!parentList) {
        continue;
      }

      const parentItem = parentList.closest<HTMLLIElement>("li");
      if (!parentItem || !editor.contains(parentItem)) {
        continue;
      }

      const ancestorList = getParentListElement(parentItem);
      if (!ancestorList) {
        continue;
      }

      const insertionPoint = parentItem.nextSibling;
      const trailingSiblings: HTMLLIElement[] = [];
      let trailingNode = lastItem.nextElementSibling;

      while (trailingNode) {
        const nextTrailingNode = trailingNode.nextElementSibling;
        if (trailingNode instanceof HTMLLIElement) {
          trailingSiblings.push(trailingNode);
        }
        trailingNode = nextTrailingNode;
      }

      for (const item of run) {
        ancestorList.insertBefore(item, insertionPoint);
        movedItems.push(item);
      }

      if (trailingSiblings.length) {
        const nestedList = getOrCreateNestedListForItem(lastItem, parentList.tagName);
        for (const trailingItem of trailingSiblings) {
          nestedList.append(trailingItem);
        }
      }

      if (!parentList.children.length) {
        parentList.remove();
      }
    }

    return movedItems;
  }

  function indentListItems(selectedItems: HTMLLIElement[]) {
    const movedItems: HTMLLIElement[] = [];

    for (const run of splitListItemRunsByParent(selectedItems)) {
      const firstItem = run[0];
      const parentList = getParentListElement(firstItem);
      if (!parentList) {
        continue;
      }

      const previousSibling = firstItem.previousElementSibling instanceof HTMLLIElement
        ? firstItem.previousElementSibling
        : null;
      if (!previousSibling) {
        continue;
      }

      const nestedList = getOrCreateNestedListForItem(previousSibling, parentList.tagName);
      for (const item of run) {
        nestedList.append(item);
        movedItems.push(item);
      }

      if (!parentList.children.length) {
        parentList.remove();
      }
    }

    return movedItems;
  }

  function isSelectionAtListItemStart(selection: Selection, item: HTMLLIElement) {
    if (!selection.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const container = getListItemTextContainer(item);
    if (!container.contains(range.startContainer)) {
      return false;
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(container);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return beforeRange.toString().replaceAll("\u00a0", " ").trim() === "";
  }

  function isTopLevelListItem(item: HTMLLIElement) {
    const parentList = getParentListElement(item);
    return Boolean(parentList && (!parentList.closest("li") || !editor.contains(parentList.closest("li"))));
  }

  function breakOutOfListItem(listItem: HTMLLIElement) {
    if (isTopLevelListItem(listItem)) {
      const paragraph = unwrapTopLevelListItemToParagraph(listItem);
      editor.focus();
      if (paragraph) {
        syncEditorAfterStructuralChange();
        restoreParagraphSelection(paragraph);
        updateFloatingToolbar();
      }
      return true;
    }

    document.execCommand("outdent", false);
    editor.focus();
    syncEditorAfterStructuralChange();
    return true;
  }

  function syncEditorAfterStructuralChange() {
    const previousContent = state.currentContent;
    syncStructuredBlockStyles();
    inspectCurrentDraft();
    recordEditHistory(previousContent, state.currentContent, captureEditorSelection());
    syncCurrentDraftBuffer();
    scheduleDiffGutterRefresh();
    updateStatusLine();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }

  function handleListTab(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const selectedItems = getSelectedListItems(selection);
    if (!selectedItems.length) {
      return false;
    }

    if (selection.isCollapsed && !isSelectionAtListItemStart(selection, selectedItems[0])) {
      return false;
    }

    const shouldCollapseSelection = selection.isCollapsed;
    event.preventDefault();

    if (event.shiftKey) {
      const movedItems = outdentListItems(selectedItems);
      editor.focus();
      if (movedItems.length) {
        syncEditorAfterStructuralChange();
        restoreListItemSelection(movedItems, { collapsed: shouldCollapseSelection });
        updateFloatingToolbar();
      }
      return true;
    }

    const movedItems = indentListItems(selectedItems);
    editor.focus();
    if (movedItems.length) {
      syncEditorAfterStructuralChange();
      restoreListItemSelection(movedItems, { collapsed: shouldCollapseSelection });
      updateFloatingToolbar();
    }
    return true;
  }

  function handleListItemBackspace(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const listItem = getClosestListItem(selection.getRangeAt(0).startContainer);
    if (!listItem || !isSelectionAtListItemStart(selection, listItem)) {
      return false;
    }

    event.preventDefault();
    return breakOutOfListItem(listItem);
  }

  function handleCommentBlockBackspace(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const paragraph = getDirectEditorParagraph(selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment !== "true" || !isSelectionAtElementStart(selection, paragraph)) {
      return false;
    }

    event.preventDefault();
    convertCommentBlockToParagraph(paragraph);
    syncEditorAfterStructuralChange();
    restoreParagraphSelection(paragraph);
    updateFloatingToolbar();
    return true;
  }

  function handleCommentBlockEnter(event: KeyboardEvent) {
    if (event.shiftKey) {
      return false;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const paragraph = getDirectEditorParagraph(selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment !== "true" || !isSelectionAtElementEnd(selection, paragraph)) {
      return false;
    }

    event.preventDefault();
    const nextParagraph = document.createElement("p");
    nextParagraph.append(document.createElement("br"));
    paragraph.parentNode?.insertBefore(nextParagraph, paragraph.nextSibling);
    syncEditorAfterStructuralChange();
    restoreParagraphSelection(nextParagraph);
    updateFloatingToolbar();
    return true;
  }

  function handleEmptyListItemEnter(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const listItem = getClosestListItem(selection.getRangeAt(0).startContainer);
    if (!listItem || serializeListItemMainText(listItem) !== "") {
      return false;
    }

    event.preventDefault();
    return breakOutOfListItem(listItem);
  }

  function runEditorCommand(command: string, value: string | null = null) {
    if (state.mode !== "rich") {
      return;
    }

    if (command === "bold") {
      wrapSelection("strong");
      return;
    }

    if (command === "italic") {
      wrapSelection("em");
      return;
    }

    clearPendingInlineFormats();
    document.execCommand(command, false, value);
    editor.focus();
    syncEditorAfterStructuralChange();
  }

  function unwrapCodeElements(root: DocumentFragment | Element) {
    const codeElements = Array.from(root.querySelectorAll("code"));

    for (const codeElement of codeElements) {
      const parent = codeElement.parentNode;
      if (!parent) {
        continue;
      }

      while (codeElement.firstChild) {
        parent.insertBefore(codeElement.firstChild, codeElement);
      }
      codeElement.remove();
    }
  }

  function removeEmptyCodeElements(root: ParentNode = editor) {
    if (!("querySelectorAll" in root)) {
      return;
    }

    const protectedElements = getProtectedEmptyInlineFormatElements(root);

    for (const codeElement of Array.from(root.querySelectorAll("code"))) {
      if (!(codeElement instanceof HTMLElement)) {
        continue;
      }

      if (protectedElements.has(codeElement)) {
        continue;
      }

      if ((codeElement.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
        continue;
      }

      codeElement.remove();
    }
  }

  function getClosestCodeElement(node: Node | null) {
    let current: Node | null = node;

    while (current && current !== editor) {
      if (current instanceof HTMLElement && current.tagName === "CODE") {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function getClosestInlineFormatElement(
    node: Node | null,
    format: PendingInlineFormatKey,
  ) {
    let current: Node | null = node;

    while (current && current !== editor) {
      if (current instanceof HTMLElement && elementMatchesInlineFormat(current, format)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function createEmptyPendingInlineFormats(): PendingInlineFormats {
    return {
      bold: false,
      code: false,
      comment: false,
      del: false,
      ins: false,
      italic: false,
    };
  }

  function getInlineFormatStateFromNode(node: Node | null): PendingInlineFormats {
    const formats = createEmptyPendingInlineFormats();

    for (const format of INLINE_FORMAT_ORDER) {
      formats[format.key] = Boolean(
        getClosestInlineFormatElement(node, format.key),
      );
    }

    return formats;
  }

  function getInlineMarksFromPendingFormats(formats: PendingInlineFormats) {
    return normalizeInlineMarks(
      INLINE_FORMAT_ORDER
        .filter((format) => formats[format.key])
        .map((format) => getInlineMarkForFormat(format.key)),
    );
  }

  function arePendingInlineFormatsEqual(
    left: PendingInlineFormats | null,
    right: PendingInlineFormats | null,
  ) {
    if (!left || !right) {
      return left === right;
    }

    return left.bold === right.bold
      && left.italic === right.italic
      && left.code === right.code
      && left.comment === right.comment
      && left.del === right.del
      && left.ins === right.ins;
  }

  function shouldPreservePendingInlineFormatsForSelection() {
    if (!pendingInlineFormats) {
      return false;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const currentFormats = getInlineFormatStateFromNode(range.startContainer);
    if (arePendingInlineFormatsEqual(currentFormats, pendingInlineFormats)) {
      return true;
    }

    return hasAdjacentEmptyPendingInlineWrapper(range, pendingInlineFormats);
  }

  function hasAdjacentEmptyPendingInlineWrapper(range: Range, formats: PendingInlineFormats) {
    return findAdjacentInlineWrapper(range, formats, { requireEmpty: true }) !== null;
  }

  function findAdjacentInlineWrapper(
    range: Range,
    formats: PendingInlineFormats,
    { requireEmpty }: { requireEmpty: boolean },
  ) {
    const targetContainer = getInlineRunContainer(range.startContainer);
    if (!targetContainer) {
      return null;
    }

    const pendingMarks = getInlineMarksFromPendingFormats(formats);
    if (!pendingMarks.length) {
      return null;
    }

    const candidateNodes: Node[] = [];
    if (range.startContainer instanceof Text) {
      if (range.startOffset === 0 && range.startContainer.previousSibling) {
        candidateNodes.push(range.startContainer.previousSibling);
      }
      if (range.startOffset === (range.startContainer.textContent?.length ?? 0) && range.startContainer.nextSibling) {
        candidateNodes.push(range.startContainer.nextSibling);
      }
    } else if (range.startContainer instanceof HTMLElement) {
      const beforeNode = range.startContainer.childNodes[range.startOffset - 1];
      const afterNode = range.startContainer.childNodes[range.startOffset];
      if (beforeNode) {
        candidateNodes.push(beforeNode);
      }
      if (afterNode) {
        candidateNodes.push(afterNode);
      }
    }

    return candidateNodes.find((node): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const marks = getMarksFromInlineWrapper(node, { requireEmpty });
      return Boolean(marks && areInlineMarkListsEqual(marks, pendingMarks));
    }) ?? null;
  }

  function getMarksFromInlineWrapper(node: HTMLElement, { requireEmpty }: { requireEmpty: boolean }): InlineMark[] | null {
    const mark = getInlineMarkForElement(node);
    if (!mark) {
      return null;
    }

    const nonWhitespaceText = (node.textContent ?? "").replaceAll("\u00a0", "").trim();
    if (requireEmpty && nonWhitespaceText.length > 0) {
      return null;
    }

    const childElements = Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const nonElementChildren = Array.from(node.childNodes).filter((child) => child.nodeType !== Node.ELEMENT_NODE);
    if (requireEmpty && nonElementChildren.some((child) => (child.textContent ?? "").replaceAll("\u00a0", "").trim().length > 0)) {
      return null;
    }

    if (!childElements.length) {
      return [mark];
    }

    if (childElements.length !== 1) {
      return null;
    }

    const childMarks = getMarksFromInlineWrapper(childElements[0], { requireEmpty });
    if (!childMarks) {
      return null;
    }

    return normalizeInlineMarks([mark, ...childMarks]);
  }

  function moveCaretIntoAdjacentPendingInlineWrapper(formats: PendingInlineFormats) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const wrapper = findAdjacentInlineWrapper(range, formats, { requireEmpty: false });
    if (!wrapper) {
      return false;
    }

    let deepestWrapper: HTMLElement = wrapper;
    while (true) {
      const childElements = Array.from(deepestWrapper.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      if (childElements.length !== 1) {
        break;
      }

      const childMarks = getMarksFromInlineWrapper(childElements[0], { requireEmpty: false });
      if (!childMarks) {
        break;
      }

      deepestWrapper = childElements[0];
    }

    const nextRange = document.createRange();
    const parentContainer = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const wrapperBeforeCaret = parentContainer === wrapper.parentElement
      && range.startContainer instanceof Element
      && range.startContainer.childNodes[range.startOffset - 1] === wrapper;
    nextRange.setStart(deepestWrapper, wrapperBeforeCaret ? deepestWrapper.childNodes.length : 0);
    nextRange.collapse(true);
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    return true;
  }

  function clearPendingInlineFormats() {
    if (!pendingInlineFormats) {
      return;
    }

    pendingInlineFormats = null;
    preservePendingInlineFormatSelectionChanges = 0;
    updateCustomCaret();
  }

  function togglePendingInlineFormat(format: PendingInlineFormatKey) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) {
      return false;
    }

    const baseFormats = pendingInlineFormats ?? getInlineFormatStateFromNode(selection.getRangeAt(0).startContainer);
    const nextFormats = { ...baseFormats, [format]: !baseFormats[format] } satisfies PendingInlineFormats;
    const activeFormatElement = getClosestInlineFormatElement(selection.getRangeAt(0).startContainer, format);

    if (!nextFormats[format] && activeFormatElement) {
      splitInlineFormatElementAtCaret(activeFormatElement);
      pendingInlineFormats = nextFormats;
      updateHistorySelection(captureEditorSelection());
      syncCurrentDraftBuffer();
      updateStatusLine();
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
      return true;
    }

    pendingInlineFormats = nextFormats;
    materializePendingInlineFormatsAtCaret(nextFormats);
    updateCustomCaret();
    return true;
  }

  function materializePendingInlineFormatsAtCaret(formats: PendingInlineFormats) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) {
      return false;
    }

    const targetContainer = getInlineRunContainer(selection.getRangeAt(0).startContainer);
    if (!targetContainer) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!targetContainer.contains(range.startContainer) || !targetContainer.contains(range.endContainer)) {
      return false;
    }

    const marker = createInlineSelectionMarker("caret");
    range.insertNode(marker);
    const markerMarks = getInlineMarksFromPendingFormats(formats);
    const rebuiltLeaves = normalizeInlineLeaves(
      flattenInlineContent(targetContainer.childNodes).map((leaf) => {
        if (leaf.type === "marker" && leaf.role === "caret") {
          return {
            ...leaf,
            marks: markerMarks,
          } satisfies InlineLeaf;
        }

        return leaf;
      }),
    );

    rebuildInlineRunContainer(targetContainer, rebuiltLeaves);
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    restoreCaretToMarker(targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="caret"]') ?? marker);
    return true;
  }

  function shouldClearPendingInlineFormatsForKey(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }

    return [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key);
  }

  function createInlineElementFromFragment(source: HTMLElement, fragment: DocumentFragment) {
    if (!fragment.childNodes.length) {
      return null;
    }

    const element = source.cloneNode(false) as HTMLElement;
    element.append(fragment);
    return element;
  }

  function createInlineMarkElement(mark: InlineMark) {
    if (mark.tag === "comment") {
      const element = document.createElement("span");
      element.dataset.inlineComment = "true";
      return element;
    }

    const element = document.createElement(mark.tag);
    if (mark.tag === "a") {
      element.setAttribute("href", mark.href ?? "");
    }
    return element;
  }

  function splitInlineFormatElementAtCaret(element: HTMLElement) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      return false;
    }

    const beforeRange = document.createRange();
    beforeRange.setStart(element, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeFragment = beforeRange.cloneContents();

    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    afterRange.setEnd(element, element.childNodes.length);
    const afterFragment = afterRange.cloneContents();

    const replacement = document.createDocumentFragment();
    const leadingElement = createInlineElementFromFragment(element, beforeFragment);
    if (leadingElement) {
      replacement.append(leadingElement);
    }

    const marker = document.createElement("span");
    marker.hidden = true;
    marker.dataset.pendingInlineCaret = "true";
    replacement.append(marker);

    const trailingElement = createInlineElementFromFragment(element, afterFragment);
    if (trailingElement) {
      replacement.append(trailingElement);
    }

    element.replaceWith(replacement);
    preservePendingInlineFormatSelectionChanges = 2;
    restoreCaretToMarker(marker);
    return true;
  }

  function insertTextWithPendingInlineFormats(text: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !pendingInlineFormats) {
      return false;
    }

    moveCaretIntoAdjacentPendingInlineWrapper(pendingInlineFormats);

    const insertionSelection = window.getSelection();
    if (!insertionSelection?.rangeCount || !insertionSelection.isCollapsed) {
      return false;
    }

    const insertionRange = insertionSelection.getRangeAt(0);
    if (!editor.contains(insertionRange.startContainer)) {
      return false;
    }

    const activeAncestors: HTMLElement[] = [];
    let currentNode: Node | null = insertionRange.startContainer;
    while (currentNode && currentNode !== editor) {
      if (currentNode instanceof HTMLElement) {
        const currentElement = currentNode;
        const formatKey = INLINE_FORMAT_ORDER.find((format) => elementMatchesInlineFormat(currentElement, format.key))?.key;

        if (formatKey) {
          activeAncestors.push(currentElement);
        }
      }
      currentNode = currentNode.parentNode;
    }

    for (const ancestor of activeAncestors) {
      const formatKey = INLINE_FORMAT_ORDER.find((format) => elementMatchesInlineFormat(ancestor, format.key))?.key;

      if (formatKey && !pendingInlineFormats[formatKey]) {
        splitInlineFormatElementAtCaret(ancestor);
      }
    }

    const currentFormats = getInlineFormatStateFromNode(insertionRange.startContainer);
    const textNode = document.createTextNode(text);
    let rootNode: Node = textNode;

    for (const format of INLINE_FORMAT_ORDER) {
      if (pendingInlineFormats[format.key] && !currentFormats[format.key]) {
        const wrapper = createInlineMarkElement(getInlineMarkForFormat(format.key));
        wrapper.append(rootNode);
        rootNode = wrapper;
      }
    }

    insertionRange.insertNode(rootNode);
    const caretMarker = createInlineSelectionMarker("caret");
    textNode.parentNode?.insertBefore(caretMarker, textNode.nextSibling);
    rootNode.parentNode?.normalize();
    preservePendingInlineFormatSelectionChanges = 2;
    restoreCaretToMarker(caretMarker);
    syncEditorAfterStructuralChange();
    return true;
  }

  function handlePendingInlineBeforeInput(event: InputEvent) {
    if (
      !pendingInlineFormats
      || !["insertText", "insertReplacementText"].includes(event.inputType)
      || event.data === null
    ) {
      return false;
    }

    event.preventDefault();
    return insertTextWithPendingInlineFormats(event.data);
  }

  function getCollapsedRangeRect(range: Range) {
    const directRect = range.getBoundingClientRect();
    if (directRect.height > 0) {
      return directRect;
    }

    const rects = range.getClientRects();
    if (rects.length > 0 && rects[0].height > 0) {
      return rects[0];
    }

    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    marker.dataset.caretMeasure = "true";
    marker.style.position = "relative";
    marker.style.display = "inline-block";
    marker.style.width = "0";
    marker.style.overflow = "hidden";
    marker.style.pointerEvents = "none";
    marker.style.lineHeight = "inherit";

    const measurementRange = range.cloneRange();
    measurementRange.insertNode(marker);
    const markerRect = marker.getBoundingClientRect();
    marker.remove();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return markerRect;
  }

  function getExpandedRangeRect(range: Range) {
    const directRect = range.getBoundingClientRect();
    if (directRect.width > 0 || directRect.height > 0) {
      return directRect;
    }

    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
    if (rects.length > 0) {
      return rects[0];
    }

    return directRect;
  }

  function getVisualViewportMetrics() {
    const viewport = window.visualViewport;
    return {
      height: viewport?.height ?? window.innerHeight,
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? window.innerWidth,
    };
  }

  function getCaretInlineContext(range: Range): CaretRenderContext | null {
    if (
      !editorHasFocus ||
      isComposing ||
      !editor.contains(range.startContainer)
    ) {
      return null;
    }

    const rect = getCollapsedRangeRect(range);
    if (!rect.width && !rect.height) {
      return null;
    }

    const formats = pendingInlineFormats ?? getInlineFormatStateFromNode(range.startContainer);

    return {
      bold: formats.bold,
      italic: formats.italic,
      kind: formats.del ? "del" : formats.ins ? "ins" : formats.comment ? "comment" : formats.code ? "code" : "default",
      rect,
    };
  }

  function hideCustomCaret() {
    editor.removeAttribute("data-custom-caret-visible");
    customCaret.hidden = true;
    delete customCaret.dataset.caretKind;
    delete customCaret.dataset.caretBold;
    delete customCaret.dataset.caretItalic;
  }

  function updateCustomCaret() {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      selection.isCollapsed === false ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    ) {
      hideCustomCaret();
      return;
    }

    const context = getCaretInlineContext(selection.getRangeAt(0));
    if (!context) {
      hideCustomCaret();
      return;
    }

    const shellRect = editorShell.getBoundingClientRect();
    const caretLeft = context.rect.left - shellRect.left;
    const caretTop = context.rect.top - shellRect.top;
    const caretHeight = Math.max(14, context.rect.height || getEditorLineHeight());

    editor.dataset.customCaretVisible = "true";
    customCaret.hidden = false;
    customCaret.dataset.caretKind = context.kind;
    customCaret.dataset.caretBold = context.bold ? "true" : "false";
    customCaret.dataset.caretItalic = context.italic ? "true" : "false";
    customCaret.style.left = `${caretLeft}px`;
    customCaret.style.top = `${caretTop}px`;
    customCaret.style.height = `${caretHeight}px`;
  }

  function getInlineFormatTagNames(format: string) {
    switch (format) {
      case "italic":
      case "em":
      case "i":
        return ["EM", "I"] as const;
      case "bold":
      case "strong":
      case "b":
        return ["STRONG", "B"] as const;
      case "code":
        return ["CODE"] as const;
      case "comment":
        return ["SPAN"] as const;
      case "del":
      case "s":
      case "strike":
        return ["DEL", "S", "STRIKE"] as const;
      case "ins":
        return ["INS"] as const;
      default:
        return null;
    }
  }

  function isInlineCommentElement(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement
      && element.tagName === "SPAN"
      && element.dataset.inlineComment === "true";
  }

  function isBlockLikeChildElement(element: HTMLElement) {
    if (element.dataset.summaryText === "true") {
      return false;
    }

    if (/^(ul|ol|li|details|summary|pre|hr)$/i.test(element.tagName)) {
      return true;
    }

    if (/^(p|div|h1|h2|h3|h4|h5|h6|blockquote)$/i.test(element.tagName)) {
      return true;
    }

    return false;
  }

  function hasDirectBlockLikeChildren(element: HTMLElement) {
    return Array.from(element.children).some((child) => child instanceof HTMLElement && isBlockLikeChildElement(child));
  }

  function isInlineRunContainer(element: HTMLElement) {
    if (element === editor) {
      return false;
    }

    if (element.dataset.summaryText === "true") {
      return true;
    }

    if (/^(p|h1|h2|h3|h4|h5|h6|blockquote)$/i.test(element.tagName)) {
      return true;
    }

    if (element.tagName === "DIV") {
      return !hasDirectBlockLikeChildren(element);
    }

    if (element.tagName === "LI") {
      return !getDirectChildDetailsElement(element) && getDirectChildListElements(element).length === 0;
    }

    return false;
  }

  function getInlineRunContainer(node: Node | null) {
    let current: Node | null = node;

    while (current && current !== editor) {
      if (current instanceof HTMLElement && isInlineRunContainer(current)) {
        return current;
      }

      current = current.parentNode;
    }

    return null;
  }

  function getInlineMarkForElement(element: Element): InlineMark | null {
    if (isInlineCommentElement(element)) {
      return { tag: "comment" };
    }

    const tag = element.tagName.toLowerCase();
    switch (tag) {
      case "strong":
        return { tag: "strong" };
      case "em":
        return { tag: "em" };
      case "code":
        return { tag: "code" };
      case "del":
        return { tag: "del" };
      case "ins":
        return { tag: "ins" };
      case "a":
        return { tag: "a", href: element.getAttribute("href") ?? "" };
      default:
        return null;
    }
  }

  function getInlineMarkForFormat(format: PendingInlineFormatKey): InlineMark {
    switch (format) {
      case "bold":
        return { tag: "strong" };
      case "italic":
        return { tag: "em" };
      case "code":
        return { tag: "code" };
      case "comment":
        return { tag: "comment" };
      case "del":
        return { tag: "del" };
      case "ins":
        return { tag: "ins" };
      default:
        return { tag: "strong" };
    }
  }

  function areInlineMarksEqual(left: InlineMark, right: InlineMark) {
    return left.tag === right.tag && left.href === right.href;
  }

  function areInlineMarkListsEqual(left: InlineMark[], right: InlineMark[]) {
    return left.length === right.length
      && left.every((mark, index) => areInlineMarksEqual(mark, right[index]));
  }

  function normalizeInlineMarks(marks: InlineMark[]) {
    const normalized = [...marks].sort((left, right) => {
      const rankDifference = INLINE_MARK_RANK[left.tag] - INLINE_MARK_RANK[right.tag];
      if (rankDifference !== 0) {
        return rankDifference;
      }

      if (left.tag === "a" && right.tag === "a") {
        return (left.href ?? "").localeCompare(right.href ?? "");
      }

      return 0;
    });

    const deduped: InlineMark[] = [];

    for (const mark of normalized) {
      const previousMark = deduped.at(-1);
      if (previousMark && areInlineMarksEqual(previousMark, mark)) {
        continue;
      }

      deduped.push(mark);
    }

    return deduped;
  }

  function normalizeInlineLeaves(leaves: InlineLeaf[]) {
    const commentPaddedLeaves = normalizeInlineCommentPadding(leaves);
    const result: InlineLeaf[] = [];

    for (const leaf of commentPaddedLeaves) {
      appendInlineLeaf(result, leaf);
    }

    return result;
  }

  function normalizeInlineLeavesForSerialization(leaves: InlineLeaf[]) {
    const boundaryNormalizedLeaves: InlineLeaf[] = [];

    for (const leaf of leaves) {
      for (const normalizedLeaf of normalizeInlineLeafBoundaries(leaf)) {
        appendInlineLeaf(boundaryNormalizedLeaves, normalizedLeaf);
      }
    }

    const commentPaddedLeaves = normalizeInlineCommentPadding(boundaryNormalizedLeaves);
    const result: InlineLeaf[] = [];

    for (const leaf of commentPaddedLeaves) {
      appendInlineLeaf(result, leaf);
    }

    stripSingularTrailingBreak(result);
    return result;
  }

  function stripSingularTrailingBreak(leaves: InlineLeaf[]) {
    const lastLeaf = leaves.at(-1);
    if (!lastLeaf || lastLeaf.type !== "break") {
      return;
    }

    const previousLeaf = leaves.at(-2);
    if (previousLeaf?.type === "break") {
      return;
    }

    leaves.pop();
  }

  function normalizeInlineLeafBoundaries(leaf: InlineLeaf) {
    if (
      leaf.type !== "text"
      || leaf.marks.length === 0
      || leaf.text.length === 0
      || leaf.marks.some((mark) => mark.tag === "ins" || mark.tag === "del")
    ) {
      return [leaf];
    }

    const parts: InlineLeaf[] = [];
    const leadingWhitespaceMatch = leaf.text.match(/^[ \t\u00a0]+/);
    const trailingWhitespaceMatch = leaf.text.match(/[ \t\u00a0]+$/);
    const leadingWhitespace = leadingWhitespaceMatch?.[0] ?? "";
    const trailingWhitespace = trailingWhitespaceMatch?.[0] ?? "";
    const contentStart = leadingWhitespace.length;
    const contentEnd = leaf.text.length - trailingWhitespace.length;
    const coreText = leaf.text.slice(contentStart, Math.max(contentStart, contentEnd));

    if (leadingWhitespace) {
      parts.push({
        type: "text",
        marks: [],
        text: leadingWhitespace,
      });
    }

    if (coreText) {
      parts.push({
        ...leaf,
        text: coreText,
      });
    }

    if (trailingWhitespace) {
      parts.push({
        type: "text",
        marks: [],
        text: trailingWhitespace,
      });
    }

    return parts.length ? parts : [];
  }

  function leafHasCommentMark(leaf: InlineLeaf) {
    const marks = leaf.type === "marker" ? leaf.marks ?? [] : leaf.marks;
    return marks.some((mark) => mark.tag === "comment");
  }

  function isTextLeafWithVisibleContent(leaf: InlineLeaf | undefined): leaf is Extract<InlineLeaf, { type: "text" }> {
    return !!leaf && leaf.type === "text" && /[^\t \u00a0]/.test(leaf.text);
  }

  function ensureSinglePlainSpaceBeforeComment(result: InlineLeaf[], commentStartIndex: number) {
    const previousLeaf = result[commentStartIndex - 1];
    if (!previousLeaf || previousLeaf.type !== "text") {
      return commentStartIndex;
    }

    if (previousLeaf.marks.length > 0) {
      if (/[^\t \u00a0]/.test(previousLeaf.text)) {
        result.splice(commentStartIndex, 0, {
          type: "text",
          marks: [],
          text: " ",
        });
        return commentStartIndex + 1;
      }
      return commentStartIndex;
    }

    previousLeaf.text = previousLeaf.text.replace(/[ \t\u00a0]+$/g, "");
    if (previousLeaf.text.length === 0) {
      result.splice(commentStartIndex - 1, 1);
      commentStartIndex -= 1;
    }

    const updatedPreviousLeaf = result[commentStartIndex - 1];
    if (isTextLeafWithVisibleContent(updatedPreviousLeaf)) {
      result.splice(commentStartIndex, 0, {
        type: "text",
          marks: [],
          text: " ",
      });
      return commentStartIndex + 1;
    }

    return commentStartIndex;
  }

  function ensureSinglePlainSpaceAfterComment(result: InlineLeaf[], commentEndIndex: number) {
    const nextLeaf = result[commentEndIndex + 1];
    if (!nextLeaf || nextLeaf.type !== "text") {
      return;
    }

    if (nextLeaf.marks.length > 0) {
      if (/[^\t \u00a0]/.test(nextLeaf.text)) {
        result.splice(commentEndIndex + 1, 0, {
          type: "text",
          marks: [],
          text: " ",
        });
      }
      return;
    }

    nextLeaf.text = nextLeaf.text.replace(/^[ \t\u00a0]+/g, "");
    if (nextLeaf.text.length === 0) {
      result.splice(commentEndIndex + 1, 1);
    }

    const updatedNextLeaf = result[commentEndIndex + 1];
    if (isTextLeafWithVisibleContent(updatedNextLeaf)) {
      result.splice(commentEndIndex + 1, 0, {
        type: "text",
        marks: [],
        text: " ",
      });
    }
  }

  function normalizeInlineCommentPadding(leaves: InlineLeaf[]) {
    const result = [...leaves];
    let index = 0;

    while (index < result.length) {
      if (!leafHasCommentMark(result[index])) {
        index += 1;
        continue;
      }

      let segmentStart = index;
      let segmentEnd = index;
      while (segmentEnd + 1 < result.length && leafHasCommentMark(result[segmentEnd + 1])) {
        segmentEnd += 1;
      }

      segmentStart = ensureSinglePlainSpaceBeforeComment(result, segmentStart);
      segmentEnd = segmentStart;
      while (segmentEnd + 1 < result.length && leafHasCommentMark(result[segmentEnd + 1])) {
        segmentEnd += 1;
      }
      ensureSinglePlainSpaceAfterComment(result, segmentEnd);

      index = segmentEnd + 1;
    }

    return result;
  }

  function appendInlineLeaf(leaves: InlineLeaf[], nextLeaf: InlineLeaf) {
    const normalizedLeaf = nextLeaf.type === "marker"
      ? {
        ...nextLeaf,
        marks: nextLeaf.marks ? normalizeInlineMarks(nextLeaf.marks) : undefined,
      } satisfies InlineLeaf
      : { ...nextLeaf, marks: normalizeInlineMarks(nextLeaf.marks) } satisfies InlineLeaf;

    if (normalizedLeaf.type !== "text" || !normalizedLeaf.text) {
      leaves.push(normalizedLeaf);
      return;
    }

    const previousLeaf = leaves.at(-1);
    if (
      previousLeaf?.type === "text"
      && areInlineMarkListsEqual(previousLeaf.marks, normalizedLeaf.marks)
    ) {
      previousLeaf.text += normalizedLeaf.text;
      return;
    }

    leaves.push(normalizedLeaf);
  }

  function flattenInlineContent(nodes: Iterable<Node>, marks: InlineMark[] = [], leaves: InlineLeaf[] = []) {
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        appendInlineLeaf(leaves, {
          type: "text",
          marks: [...marks],
          text: node.textContent ?? "",
        });
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const element = node as HTMLElement;
      const markerRole = element.dataset.inlineSelectionMarker;
      if (markerRole === "caret" || markerRole === "selection-start" || markerRole === "selection-end") {
        leaves.push({ type: "marker", role: markerRole, marks: [...marks] });
        continue;
      }

      if (element.tagName === "BR") {
        leaves.push({ type: "break", marks: [...marks] });
        continue;
      }

      const mark = getInlineMarkForElement(element);
      if (mark) {
        flattenInlineContent(element.childNodes, [...marks, mark], leaves);
        continue;
      }

      flattenInlineContent(element.childNodes, marks, leaves);
    }

    return leaves;
  }

  function appendCanonicalInlineLeaf(container: HTMLElement, leaf: InlineLeaf) {
    const marks = leaf.type === "marker" ? leaf.marks ?? [] : leaf.marks;
    let contentNode: Node;

    if (leaf.type === "marker") {
      contentNode = createInlineSelectionMarker(leaf.role);
    } else if (leaf.type === "break") {
      contentNode = document.createElement("br");
    } else {
      contentNode = document.createTextNode(leaf.text);
    }

    if (marks.length) {
      const existingRun = getDeepestMatchingMarkedRun(container.lastChild, marks);
      if (existingRun) {
        existingRun.append(contentNode);
        return;
      }

      for (let index = marks.length - 1; index >= 0; index -= 1) {
        const wrapper = createInlineMarkElement(marks[index]);
        wrapper.append(contentNode);
        contentNode = wrapper;
      }
      container.append(contentNode);
      return;
    }

    if (leaf.type === "text") {
      const wrapper = document.createElement("span");
      wrapper.append(contentNode);
      contentNode = wrapper;
    }

    container.append(contentNode);
  }

  function getDeepestMatchingMarkedRun(node: Node | null, marks: InlineMark[]) {
    if (!(node instanceof HTMLElement) || !marks.length) {
      return null;
    }

    let current: HTMLElement | null = node;
    for (let index = 0; index < marks.length; index += 1) {
      if (!current) {
        return null;
      }

      const currentMark = getInlineMarkForElement(current);
      if (!currentMark || !areInlineMarksEqual(currentMark, marks[index])) {
        return null;
      }

      if (index === marks.length - 1) {
        return current;
      }

      const childElements = Array.from(current.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      if (childElements.length !== 1) {
        return null;
      }

      current = childElements[0];
    }

    return null;
  }

  function rebuildInlineRunContainer(container: HTMLElement, leaves: InlineLeaf[]) {
    container.replaceChildren();

    if (!leaves.length) {
      container.append(document.createElement("br"));
      return;
    }

    for (const leaf of leaves) {
      if (leaf.type === "text" && leaf.text.length === 0) {
        continue;
      }

      appendCanonicalInlineLeaf(container, leaf);
    }

    if (!container.childNodes.length) {
      container.append(document.createElement("br"));
    }
  }

  function canonicalizeInlineRunContainer(container: HTMLElement) {
    const leaves = normalizeInlineLeaves(flattenInlineContent(container.childNodes));
    rebuildInlineRunContainer(container, leaves);
  }

  function canonicalizeInlineRunsForSelectionContainer(container?: HTMLElement | null) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
      return;
    }

    const targetContainer = container ?? getInlineRunContainer(selection.getRangeAt(0).startContainer);
    if (!targetContainer) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!targetContainer.contains(range.startContainer) || !targetContainer.contains(range.endContainer)) {
      return;
    }

    if (selection.isCollapsed) {
      const marker = createInlineSelectionMarker("caret");
      range.insertNode(marker);
      canonicalizeInlineRunContainer(targetContainer);
      preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
      restoreCaretToMarker(targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="caret"]') ?? marker);
      return;
    }

    const endMarker = createInlineSelectionMarker("selection-end");
    const endRange = range.cloneRange();
    endRange.collapse(false);
    endRange.insertNode(endMarker);

    const startMarker = createInlineSelectionMarker("selection-start");
    const startRange = range.cloneRange();
    startRange.collapse(true);
    startRange.insertNode(startMarker);

    canonicalizeInlineRunContainer(targetContainer);
    preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
    restoreSelectionToMarkers(
      targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="selection-start"]') ?? startMarker,
      targetContainer.querySelector<HTMLElement>('[data-inline-selection-marker="selection-end"]') ?? endMarker,
    );
  }

  function canonicalizeAllInlineRunContainers(root: ParentNode) {
    const activeSelectionContainer = root === editor
      ? getInlineRunContainer(window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0).startContainer ?? null : null)
      : null;

    const containers = root instanceof HTMLElement && root !== editor && isInlineRunContainer(root)
      ? [root]
      : "querySelectorAll" in root
        ? Array.from(root.querySelectorAll<HTMLElement>("p, div, h1, h2, h3, h4, h5, h6, blockquote, li, span[data-summary-text='true']"))
            .filter((element) => isInlineRunContainer(element))
        : [];

    for (const candidateContainer of containers) {
      if (candidateContainer === activeSelectionContainer) {
        continue;
      }

      canonicalizeInlineRunContainer(candidateContainer);
    }

    if (activeSelectionContainer && (root === editor || (root instanceof Node && root.contains(activeSelectionContainer)))) {
      canonicalizeInlineRunsForSelectionContainer(activeSelectionContainer);
    }
  }

  function elementMatchesInlineFormat(element: HTMLElement, format: PendingInlineFormatKey) {
    if (format === "comment") {
      return isInlineCommentElement(element);
    }

    const tagNames = getInlineFormatTagNames(format);
    return Boolean(tagNames && (tagNames as readonly string[]).includes(element.tagName));
  }

  function maybeExitInlineFormatAtBoundary(format: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    if (!INLINE_FORMAT_ORDER.some((inlineFormat) => inlineFormat.key === format)) {
      return false;
    }

    const formatElement = getClosestInlineFormatElement(selection.getRangeAt(0).startContainer, format as PendingInlineFormatKey);
    if (!formatElement || !isSelectionAtElementEnd(selection, formatElement)) {
      return false;
    }

    const parent = formatElement.parentNode;
    if (!parent) {
      return false;
    }

    placeCaretAfterNode(formatElement, parent);
    updateHistorySelection(captureEditorSelection());
    window.requestAnimationFrame(() => {
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
    });
    return true;
  }

  function createCodeElementFromFragment(source: HTMLElement, fragment: DocumentFragment) {
    if (!fragment.childNodes.length) {
      return null;
    }

    const codeElement = source.cloneNode(false) as HTMLElement;
    codeElement.append(fragment);
    return codeElement;
  }

  function getInlineFormatSelector(format: PendingInlineFormatKey) {
    switch (format) {
      case "bold":
        return "strong, b";
      case "italic":
        return "em, i";
      case "code":
        return "code";
      case "comment":
        return 'span[data-inline-comment="true"]';
      case "del":
        return "del, s, strike";
      case "ins":
        return "ins";
      default:
        return "";
    }
  }

  function unwrapElementsByTagNames(root: ParentNode, tagNames: readonly string[]) {
    if (!("querySelectorAll" in root) || !tagNames.length) {
      return;
    }

    const selector = tagNames.map((tagName) => tagName.toLowerCase()).join(", ");
    for (const element of Array.from(root.querySelectorAll(selector))) {
      const parent = element.parentNode;
      if (!parent) {
        continue;
      }

      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      element.remove();
    }
  }

  function unwrapInlineFormatElements(
    root: ParentNode,
    format: PendingInlineFormatKey,
  ) {
    if (!("querySelectorAll" in root)) {
      return;
    }

    const selector = getInlineFormatSelector(format);
    if (!selector) {
      return;
    }

    for (const element of Array.from(root.querySelectorAll(selector))) {
      const parent = element.parentNode;
      if (!parent) {
        continue;
      }

      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      element.remove();
    }
  }

  function removeEmptyInlineFormatElements(
    tagNames: readonly string[],
    root: ParentNode = editor,
  ) {
    if (!("querySelectorAll" in root) || !tagNames.length) {
      return;
    }

    const protectedElements = getProtectedEmptyInlineFormatElements(root);
    const selector = tagNames.map((tagName) => tagName.toLowerCase()).join(", ");
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (protectedElements.has(element)) {
        continue;
      }

      if ((element.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
        continue;
      }

      element.remove();
    }
  }

  function removeEmptyInlineFormatElementsForFormat(
    format: PendingInlineFormatKey,
    root: ParentNode = editor,
  ) {
    if (!("querySelectorAll" in root)) {
      return;
    }

    const selector = getInlineFormatSelector(format);
    if (!selector) {
      return;
    }

    const protectedElements = getProtectedEmptyInlineFormatElements(root);
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (protectedElements.has(element)) {
        continue;
      }

      if ((element.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
        continue;
      }

      element.remove();
    }
  }

  function getProtectedEmptyInlineFormatElements(root: ParentNode) {
    const protectedElements = new Set<HTMLElement>();
    if (root !== editor) {
      return protectedElements;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return protectedElements;
    }

    const boundaryNodes = [
      selection.anchorNode,
      selection.focusNode,
      selection.getRangeAt(0).startContainer,
      selection.getRangeAt(0).endContainer,
    ];

    for (const boundaryNode of boundaryNodes) {
      let current: Node | null = boundaryNode;
      while (current && current !== editor) {
        if (current instanceof HTMLElement && getInlineMarkForElement(current)) {
          protectedElements.add(current);
        }
        current = current.parentNode;
      }
    }

    return protectedElements;
  }

  function rangeIntersectsNodeSafely(range: Range, node: Node) {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  }

  function selectionContainsOnlyInlineFormat(range: Range, format: PendingInlineFormatKey) {
    const root = range.commonAncestorContainer;
    const selectedNodes: Node[] = [];
    const maybePushSelectedNode = (node: Node) => {
      if (!editor.contains(node) || !rangeIntersectsNodeSafely(range, node)) {
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? "").length > 0) {
          selectedNodes.push(node);
        }
        return;
      }

      if (node instanceof HTMLBRElement) {
        selectedNodes.push(node);
      }
    };

    maybePushSelectedNode(root);
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (!editor.contains(node)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!rangeIntersectsNodeSafely(range, node)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (node.nodeType === Node.TEXT_NODE) {
            return (node.textContent ?? "").length > 0
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }

          if (node instanceof HTMLBRElement) {
            return NodeFilter.FILTER_ACCEPT;
          }

          return NodeFilter.FILTER_SKIP;
        },
      },
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      selectedNodes.push(currentNode);
      currentNode = walker.nextNode();
    }

    if (!selectedNodes.length) {
      return false;
    }

    return selectedNodes.every((node) => {
      let current: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node.parentNode;

      while (current && current !== editor) {
        if (current instanceof HTMLElement && elementMatchesInlineFormat(current, format)) {
          return true;
        }
        current = current.parentNode;
      }

      return false;
    });
  }

  function unwrapSelectionFromSingleFormatElement(
    selection: Selection,
    range: Range,
    formatElement: HTMLElement,
    tagNames: readonly string[],
  ) {
    const beforeRange = document.createRange();
    beforeRange.setStart(formatElement, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeFragment = beforeRange.cloneContents();

    const selectedFragment = range.cloneContents();
    unwrapElementsByTagNames(selectedFragment, tagNames);

    const afterRange = document.createRange();
    afterRange.setStart(range.endContainer, range.endOffset);
    afterRange.setEnd(formatElement, formatElement.childNodes.length);
    const afterFragment = afterRange.cloneContents();

    const replacement = document.createDocumentFragment();
    const insertedNodes: Node[] = [];
    const leadingElement = createInlineElementFromFragment(formatElement, beforeFragment);
    if (leadingElement) {
      replacement.append(leadingElement);
    }

    for (const node of Array.from(selectedFragment.childNodes)) {
      insertedNodes.push(node);
      replacement.append(node);
    }

    const trailingElement = createInlineElementFromFragment(formatElement, afterFragment);
    if (trailingElement) {
      replacement.append(trailingElement);
    }

    const fallbackRange = document.createRange();
    fallbackRange.setStartBefore(formatElement);
    fallbackRange.collapse(true);
    formatElement.replaceWith(replacement);
    removeEmptyInlineFormatElements(tagNames);
    selectInsertedNodes(selection, insertedNodes, fallbackRange);
    syncEditorAfterStructuralChange();
  }

  function unwrapSelectionFromSingleCodeElement(selection: Selection, range: Range, codeElement: HTMLElement) {
    const beforeRange = document.createRange();
    beforeRange.setStart(codeElement, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeFragment = beforeRange.cloneContents();

    const selectedFragment = range.cloneContents();
    unwrapCodeElements(selectedFragment);

    const afterRange = document.createRange();
    afterRange.setStart(range.endContainer, range.endOffset);
    afterRange.setEnd(codeElement, codeElement.childNodes.length);
    const afterFragment = afterRange.cloneContents();

    const replacement = document.createDocumentFragment();
    const insertedNodes: Node[] = [];
    const leadingCode = createCodeElementFromFragment(codeElement, beforeFragment);
    if (leadingCode) {
      replacement.append(leadingCode);
    }

    for (const node of Array.from(selectedFragment.childNodes)) {
      insertedNodes.push(node);
      replacement.append(node);
    }

    const trailingCode = createCodeElementFromFragment(codeElement, afterFragment);
    if (trailingCode) {
      replacement.append(trailingCode);
    }

    const fallbackRange = document.createRange();
    fallbackRange.setStartBefore(codeElement);
    fallbackRange.collapse(true);
    codeElement.replaceWith(replacement);
    removeEmptyCodeElements();
    selectInsertedNodes(selection, insertedNodes, fallbackRange);
    syncEditorAfterStructuralChange();
  }

  function fragmentContainsOnlyCodeText(fragment: DocumentFragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();

    while (currentNode) {
      const textNode = currentNode as Text;
      if ((textNode.textContent ?? "").length > 0) {
        textNodes.push(textNode);
      }
      currentNode = walker.nextNode();
    }

    if (!textNodes.length) {
      return false;
    }

    return textNodes.every((textNode) => {
      let current: Node | null = textNode.parentNode;

      while (current && current !== fragment) {
        if (current instanceof HTMLElement && current.tagName === "CODE") {
          return true;
        }
        current = current.parentNode;
      }

      return false;
    });
  }

  function selectInsertedNodes(selection: Selection, insertedNodes: Node[], fallbackRange: Range) {
    selection.removeAllRanges();

    if (!insertedNodes.length) {
      selection.addRange(fallbackRange);
      return;
    }

    const nextRange = document.createRange();
    const firstNode = insertedNodes[0];
    const lastNode = insertedNodes[insertedNodes.length - 1];

    if (insertedNodes.length === 1) {
      nextRange.selectNodeContents(firstNode);
    } else {
      nextRange.setStartBefore(firstNode);
      nextRange.setEndAfter(lastNode);
    }

    selection.addRange(nextRange);
  }

  function toggleCodeSelection(selection: Selection, range: Range) {
    const startCode = getClosestCodeElement(range.startContainer);
    const endCode = getClosestCodeElement(range.endContainer);
    if (startCode && startCode === endCode) {
      unwrapSelectionFromSingleCodeElement(selection, range, startCode);
      return;
    }

    const fragment = range.cloneContents();
    const shouldUnwrap = fragmentContainsOnlyCodeText(fragment);
    const extractedFragment = range.extractContents();

    if (shouldUnwrap) {
      unwrapCodeElements(extractedFragment);
      const insertedNodes = Array.from(extractedFragment.childNodes);
      const fallbackRange = document.createRange();
      fallbackRange.setStart(range.startContainer, range.startOffset);
      fallbackRange.collapse(true);
      range.insertNode(extractedFragment);
      removeEmptyCodeElements();
      selectInsertedNodes(selection, insertedNodes, fallbackRange);
      syncEditorAfterStructuralChange();
      return;
    }

    unwrapCodeElements(extractedFragment);
    const wrapper = document.createElement("code");
    wrapper.append(extractedFragment);
    range.insertNode(wrapper);
    removeEmptyCodeElements();
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    syncEditorAfterStructuralChange();
  }

  function wrapSelection(tagName: keyof HTMLElementTagNameMap | "comment") {
    if (state.mode !== "rich") {
      return;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return;
    }

    if (selection.isCollapsed) {
      const pendingFormatKey = tagName === "strong"
        ? "bold"
        : tagName === "em"
          ? "italic"
          : tagName === "code" || tagName === "comment" || tagName === "del" || tagName === "ins"
            ? tagName
            : null;

      if (
        pendingFormatKey
        && togglePendingInlineFormat(pendingFormatKey)
      ) {
        return;
      }
      return;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return;
    }

    clearPendingInlineFormats();
    if (tagName === "code") {
      toggleCodeSelection(selection, range);
      return;
    }

    if (tagName === "strong") {
      toggleInlineFormatSelection(selection, range, "strong", "bold");
      return;
    }

    if (tagName === "em") {
      toggleInlineFormatSelection(selection, range, "em", "italic");
      return;
    }

    if (tagName === "del") {
      toggleInlineFormatSelection(selection, range, "del", "del");
      return;
    }

    if (tagName === "ins") {
      toggleInlineFormatSelection(selection, range, "ins", "ins");
      return;
    }

    if (tagName === "comment") {
      toggleInlineFormatSelection(selection, range, "comment", "comment");
      return;
    }

    const wrapper = document.createElement(tagName);
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    syncEditorAfterStructuralChange();
  }

  function applyToolbarCommand(command: string) {
    switch (command) {
      case "bold":
        runEditorCommand("bold");
        break;
      case "italic":
        runEditorCommand("italic");
        break;
      case "inline-code":
        wrapSelection("code");
        break;
      case "comment":
        wrapSelection("comment");
        break;
      case "del":
        wrapSelection("del");
        break;
      case "ins":
        wrapSelection("ins");
        break;
      case "h1":
        runEditorCommand("formatBlock", "<h1>");
        break;
      case "h2":
        runEditorCommand("formatBlock", "<h2>");
        break;
      case "unordered-list":
        runEditorCommand("insertUnorderedList");
        break;
      case "ordered-list":
        runEditorCommand("insertOrderedList");
        break;
      case "quote":
        runEditorCommand("formatBlock", "<blockquote>");
        break;
      default:
        break;
    }
  }

  function toggleInlineFormatSelection(
    selection: Selection,
    range: Range,
    tagName: "comment" | "strong" | "em" | "del" | "ins",
    formatKey: PendingInlineFormatKey,
  ) {
    const container = getInlineRunContainer(range.commonAncestorContainer) ?? getInlineRunContainer(range.startContainer);
    if (
      container
      && container.contains(range.startContainer)
      && container.contains(range.endContainer)
    ) {
      const startMarker = createInlineSelectionMarker("selection-start");
      const endMarker = createInlineSelectionMarker("selection-end");
      const endRange = range.cloneRange();
      endRange.collapse(false);
      endRange.insertNode(endMarker);
      const startRange = range.cloneRange();
      startRange.collapse(true);
      startRange.insertNode(startMarker);

      const leaves = flattenInlineContent(container.childNodes);
      const beforeLeaves: InlineLeaf[] = [];
      const selectedLeaves: InlineLeaf[] = [];
      const afterLeaves: InlineLeaf[] = [];
      let phase: "before" | "selected" | "after" = "before";

      for (const leaf of leaves) {
        if (leaf.type === "marker") {
          if (leaf.role === "selection-start") {
            phase = "selected";
          } else if (leaf.role === "selection-end") {
            phase = "after";
          }
          continue;
        }

        if (phase === "before") {
          beforeLeaves.push(leaf);
        } else if (phase === "selected") {
          selectedLeaves.push(leaf);
        } else {
          afterLeaves.push(leaf);
        }
      }

      const selectedSemanticLeaves = selectedLeaves.filter((leaf): leaf is Extract<InlineLeaf, { type: "text" }> => {
        return leaf.type === "text" && /[^\t \u00a0]/.test(leaf.text);
      });

      const targetMark = getInlineMarkForFormat(formatKey);
      const shouldRemove = selectedSemanticLeaves.length > 0 && selectedSemanticLeaves.every((leaf) => {
        return leaf.marks.some((mark) => areInlineMarksEqual(mark, targetMark));
      });

      const updatedSelectedLeaves = selectedLeaves.map((leaf) => {
        if (leaf.type !== "text") {
          return leaf;
        }

        const nextMarks = shouldRemove
          ? leaf.marks.filter((mark) => !areInlineMarksEqual(mark, targetMark))
          : [...leaf.marks, targetMark];

        return {
          ...leaf,
          marks: nextMarks,
        } satisfies InlineLeaf;
      });

      const rebuiltLeaves = normalizeInlineLeaves([
        ...beforeLeaves,
        { type: "marker", role: "selection-start" } satisfies InlineLeaf,
        ...updatedSelectedLeaves,
        { type: "marker", role: "selection-end" } satisfies InlineLeaf,
        ...afterLeaves,
      ]);

      rebuildInlineRunContainer(container, rebuiltLeaves);
      preservePendingInlineFormatSelectionChanges = Math.max(preservePendingInlineFormatSelectionChanges, 2);
      restoreSelectionToMarkers(
        container.querySelector<HTMLElement>('[data-inline-selection-marker="selection-start"]') ?? startMarker,
        container.querySelector<HTMLElement>('[data-inline-selection-marker="selection-end"]') ?? endMarker,
      );
      syncEditorAfterStructuralChange();
      return;
    }

    const startFormatElement = getClosestInlineFormatElement(range.startContainer, formatKey);
    const shouldUnwrap = selectionContainsOnlyInlineFormat(range, formatKey);

    if (
      shouldUnwrap
      && startFormatElement
      && startFormatElement.contains(range.commonAncestorContainer)
    ) {
      unwrapSelectionFromSingleFormatElement(
        selection,
        range,
        startFormatElement,
        getInlineFormatTagNames(formatKey) ?? [startFormatElement.tagName],
      );
      return;
    }

    const extractedFragment = range.extractContents();
    unwrapInlineFormatElements(extractedFragment, formatKey);

    if (shouldUnwrap) {
      const insertedNodes = Array.from(extractedFragment.childNodes);
      const fallbackRange = document.createRange();
      fallbackRange.setStart(range.startContainer, range.startOffset);
      fallbackRange.collapse(true);
      range.insertNode(extractedFragment);
      removeEmptyInlineFormatElementsForFormat(formatKey);
      selectInsertedNodes(selection, insertedNodes, fallbackRange);
      syncEditorAfterStructuralChange();
      return;
    }

    const wrapper = createInlineMarkElement(getInlineMarkForFormat(formatKey));
    wrapper.append(extractedFragment);
    range.insertNode(wrapper);
    removeEmptyInlineFormatElementsForFormat(formatKey);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    syncEditorAfterStructuralChange();
  }

  function setHoveredRevisionNode(node: HTMLElement | null) {
    if (hoveredRevisionNode === node) {
      updateRevisionHoverToolbar();
      return;
    }

    hoveredRevisionNode = node;
    updateRevisionHoverToolbar();
  }

  function getHoveredRevisionKind(element: HTMLElement | null): RevisionHoverKind | null {
    if (!element) {
      return null;
    }

    if (element.dataset.inlineComment === "true" || element.dataset.blockComment === "true") {
      return "comment";
    }

    const tag = element.tagName.toLowerCase();
    return tag === "del" || tag === "ins" ? tag : null;
  }

  function setActiveRevisionNodes(nodes: HTMLElement[]) {
    for (const element of activeRevisionNodes) {
      element.removeAttribute("data-revision-hover-active");
    }

    activeRevisionNodes = new Set(nodes);
    for (const element of activeRevisionNodes) {
      element.setAttribute("data-revision-hover-active", "true");
    }
  }

  function getRevisionToolbarKind(nodes: HTMLElement[]): RevisionToolbarKind | null {
    let hasComments = false;
    let hasInsertions = false;
    let hasDeletions = false;

    for (const node of nodes) {
      const kind = getHoveredRevisionKind(node);
      if (kind === "comment") {
        hasComments = true;
      } else if (kind === "ins") {
        hasInsertions = true;
      } else if (kind === "del") {
        hasDeletions = true;
      }
    }

    if (hasComments && (hasInsertions || hasDeletions)) {
      return null;
    }

    if (hasComments) {
      return "comment";
    }

    if (hasInsertions && hasDeletions) {
      return "mixed";
    }

    if (hasInsertions) {
      return "ins";
    }

    if (hasDeletions) {
      return "del";
    }

    return null;
  }

  function getSelectedRevisionToolbarContext(): RevisionToolbarContext | null {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount
      || selection.isCollapsed
      || state.mode !== "rich"
      || !editor.contains(selection.anchorNode)
      || !editor.contains(selection.focusNode)
    ) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const nodes = Array.from(editor.querySelectorAll<HTMLElement>('del, ins, [data-inline-comment="true"], [data-block-comment="true"]'))
      .filter((element) => range.intersectsNode(element));
    if (!nodes.length) {
      return null;
    }

    const kind = getRevisionToolbarKind(nodes);
    if (!kind) {
      return null;
    }

    const rect = getExpandedRangeRect(range);
    if (!rect.width && !rect.height) {
      return null;
    }

    return { kind, nodes, rect };
  }

  function getHoveredRevisionToolbarContext(): RevisionToolbarContext | null {
    const kind = getHoveredRevisionKind(hoveredRevisionNode);
    if (
      !kind ||
      state.mode !== "rich" ||
      !hoveredRevisionNode?.isConnected ||
      !editor.contains(hoveredRevisionNode)
    ) {
      return null;
    }

    const rect = hoveredRevisionNode.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return null;
    }

    return {
      kind,
      nodes: [hoveredRevisionNode],
      rect,
    };
  }

  function isPointWithinExpandedRect(rect: DOMRect, clientX: number, clientY: number, padding: number) {
    return clientX >= rect.left - padding
      && clientX <= rect.right + padding
      && clientY >= rect.top - padding
      && clientY <= rect.bottom + padding;
  }

  function isPointerNearRevisionHoverUi(clientX: number, clientY: number) {
    const revisionKind = getHoveredRevisionKind(hoveredRevisionNode);
    if (!revisionKind || !hoveredRevisionNode?.isConnected || !editor.contains(hoveredRevisionNode)) {
      return false;
    }

    const targetRect = hoveredRevisionNode.getBoundingClientRect();
    if (targetRect.width || targetRect.height) {
      if (isPointWithinExpandedRect(targetRect, clientX, clientY, REVISION_HOVER_PROXIMITY_PX)) {
        return true;
      }
    }

    if (revisionHoverToolbar.hidden) {
      return false;
    }

    const toolbarRect = revisionHoverToolbar.getBoundingClientRect();
    return isPointWithinExpandedRect(toolbarRect, clientX, clientY, REVISION_HOVER_PROXIMITY_PX);
  }

  function updateRevisionHoverToolbar() {
    const context = getSelectedRevisionToolbarContext() ?? getHoveredRevisionToolbarContext();
    if (!context) {
      setActiveRevisionNodes([]);
      revisionHoverToolbar.hidden = true;
      delete revisionHoverToolbar.dataset.revisionKind;
      revisionHoverToolbar.style.background = "";
      revisionHoverAcceptButton.hidden = false;
      revisionHoverAcceptButton.textContent = "accept";
      revisionHoverAcceptButton.setAttribute("aria-label", "Accept revision");
      revisionHoverAcceptButton.title = "Accept revision";
      revisionHoverRejectButton.hidden = false;
      revisionHoverRejectButton.textContent = "reject";
      revisionHoverRejectButton.setAttribute("aria-label", "Reject revision");
      revisionHoverRejectButton.title = "Reject revision";
      return;
    }

    setActiveRevisionNodes(context.nodes);
    const isBulkSelection = context.nodes.length > 1;
    const acceptLabel = context.kind === "comment"
      ? isBulkSelection ? "Resolve selected comments" : "Resolve comment"
      : context.kind === "del"
      ? isBulkSelection ? "Accept selected deletions" : "Accept deletion"
      : context.kind === "ins"
        ? isBulkSelection ? "Accept selected insertions" : "Accept insertion"
        : "Accept selected revisions";
    const rejectLabel = context.kind === "del"
      ? isBulkSelection ? "Reject selected deletions" : "Reject deletion"
      : context.kind === "ins"
        ? isBulkSelection ? "Reject selected insertions" : "Reject insertion"
        : "Reject selected revisions";
    revisionHoverToolbar.dataset.revisionKind = context.kind;
    revisionHoverToolbar.style.background = context.kind === "comment"
      ? "color-mix(in srgb, var(--text) 10%, var(--bg) 90%)"
      : context.kind === "del"
      ? "color-mix(in srgb, var(--danger) 20%, var(--bg) 80%)"
      : context.kind === "ins"
        ? "color-mix(in srgb, var(--success) 20%, var(--bg) 80%)"
        : "color-mix(in srgb, #d0ad12 22%, var(--bg) 78%)";
    revisionHoverAcceptButton.hidden = false;
    revisionHoverAcceptButton.textContent = context.kind === "comment" ? "resolve" : "accept";
    revisionHoverAcceptButton.setAttribute("aria-label", acceptLabel);
    revisionHoverAcceptButton.title = acceptLabel;
    revisionHoverRejectButton.hidden = context.kind === "comment";
    revisionHoverRejectButton.textContent = "reject";
    revisionHoverRejectButton.setAttribute("aria-label", rejectLabel);
    revisionHoverRejectButton.title = rejectLabel;
    revisionHoverToolbar.hidden = false;

    const viewport = getVisualViewportMetrics();
    const contextTop = viewport.top + context.rect.top;
    const contextBottom = viewport.top + context.rect.bottom;
    if (contextBottom < viewport.top + 8 || contextTop > viewport.top + viewport.height - 8) {
      revisionHoverToolbar.hidden = true;
      return;
    }

    const leftEdge = viewport.left + 12;
    const rightEdge = viewport.left + viewport.width - revisionHoverToolbar.offsetWidth - 12;
    const x = Math.min(
      rightEdge,
      Math.max(leftEdge, viewport.left + context.rect.left + context.rect.width / 2 - revisionHoverToolbar.offsetWidth / 2),
    );
    const preferredTop = viewport.top + context.rect.top - revisionHoverToolbar.offsetHeight - 10;
    const fallbackTop = viewport.top + context.rect.bottom + 10;
    const maxTop = viewport.top + viewport.height - revisionHoverToolbar.offsetHeight - 12;
    const y = preferredTop >= viewport.top + 12
      ? preferredTop
      : Math.min(maxTop, fallbackTop);

    revisionHoverToolbar.style.left = `${x}px`;
    revisionHoverToolbar.style.top = `${Math.max(viewport.top + 12, y)}px`;
  }

  function applyHoveredRevisionAction(action: "accept" | "reject") {
    const context = getSelectedRevisionToolbarContext() ?? getHoveredRevisionToolbarContext();
    const targets = context?.nodes.filter((node) => node.parentNode && editor.contains(node)) ?? [];
    if (!targets.length) {
      setHoveredRevisionNode(null);
      return;
    }

    const firstTarget = targets[0];
    if (!firstTarget?.parentNode) {
      setHoveredRevisionNode(null);
      return;
    }

    const caretMarker = document.createElement("span");
    caretMarker.hidden = true;
    firstTarget.parentNode.insertBefore(caretMarker, firstTarget);
    setHoveredRevisionNode(null);
    setActiveRevisionNodes([]);

    for (const target of targets) {
      const revisionKind = getHoveredRevisionKind(target);
      const parent = target.parentNode;
      if (!revisionKind || !parent) {
        continue;
      }

      if (revisionKind === "comment") {
        target.remove();
        continue;
      }

      if ((revisionKind === "del" && action === "accept") || (revisionKind === "ins" && action === "reject")) {
        target.remove();
        continue;
      }

      while (target.firstChild) {
        parent.insertBefore(target.firstChild, target);
      }
      target.remove();
    }

    restoreCaretToMarker(caretMarker);
    syncEditorAfterStructuralChange();
  }

  function updateFloatingToolbar() {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      selection.isCollapsed ||
      state.mode !== "rich" ||
      getSelectedRevisionToolbarContext() !== null ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    ) {
      floatingToolbar.hidden = true;
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = getExpandedRangeRect(range);
    if (!rect.width && !rect.height) {
      floatingToolbar.hidden = true;
      return;
    }

    const viewport = getVisualViewportMetrics();
    const selectionTop = viewport.top + rect.top;
    const selectionBottom = viewport.top + rect.bottom;
    if (selectionBottom < viewport.top + 8 || selectionTop > viewport.top + viewport.height - 8) {
      floatingToolbar.hidden = true;
      return;
    }

    floatingToolbar.hidden = false;
    const leftEdge = viewport.left + 12;
    const rightEdge = viewport.left + viewport.width - floatingToolbar.offsetWidth - 12;
    const x = Math.min(
      rightEdge,
      Math.max(leftEdge, viewport.left + rect.left + rect.width / 2 - floatingToolbar.offsetWidth / 2),
    );
    const preferredTop = viewport.top + rect.top - floatingToolbar.offsetHeight - 10;
    const fallbackTop = viewport.top + rect.bottom + 10;
    const maxTop = viewport.top + viewport.height - floatingToolbar.offsetHeight - 12;
    const y = preferredTop >= viewport.top + 12
      ? preferredTop
      : Math.min(maxTop, fallbackTop);

    floatingToolbar.style.left = `${x}px`;
    floatingToolbar.style.top = `${y}px`;
  }

  async function refreshTree({ preserveSelection = false }: { preserveSelection?: boolean } = {}) {
    const response = await fetch("/api/tree", { cache: "no-store" });
    const payload = (await response.json()) as ProjectSnapshot;
    state.root = payload.root;
    state.rootPath = payload.rootPath;
    state.tree = payload.tree;
    state.changes = payload.changes;
    await refreshThreads();
    emitExplorerStateChange();

    if (preserveSelection && state.currentThreadId) {
      const currentThreadId = state.currentThreadId;
      if (state.threads.some((thread) => thread.id === currentThreadId)) {
        if (!isCurrentThreadUpToDate(currentThreadId)) {
          await openThread(currentThreadId, { source: "reload" });
        }
        if (state.currentThreadId === currentThreadId) {
          return;
        }
      } else {
        setCurrentThread(null);
        state.currentThreadId = "";
        syncCurrentSelectionToUrl({});
        emitExplorerStateChange();
      }
    }

    if (preserveSelection && state.currentPath) {
      const currentPath = state.currentPath;
      await refreshCurrentFileFromDiskIfSafe();
      if (state.currentPath === currentPath) {
        return;
      }
    }

    const requestedThreadId = getRequestedThreadIdFromUrl();
    if (requestedThreadId && state.threads.some((thread) => thread.id === requestedThreadId)) {
      await openThread(requestedThreadId);
      if (state.currentThreadId === requestedThreadId) {
        return;
      }
    }

    const requestedPath = getRequestedPathFromUrl();
    if (requestedPath) {
      await openFile(requestedPath);
      if (state.currentPath === requestedPath) {
        return;
      }
    }

    const firstMarkdownFile = getFirstFile(state.tree, (filePath) => isMarkdownFile(filePath));
    const fallbackFile = firstMarkdownFile || getFirstFile(state.tree);

    if (fallbackFile) {
      await openFile(fallbackFile);
      return;
    }

    state.baselineContent = "";
    state.currentPath = "";
    setCurrentThread(null);
    state.currentThreadId = "";
    state.currentContent = "";
    state.dirty = false;
    state.expectedMtimeMs = null;
    state.headContent = null;
    state.history = null;
    state.pendingWriteConflict = null;
    state.saveIssue = null;
    state.lastLoggedSaveIssue = null;
    editor.textContent = "";
    setHoveredRevisionNode(null);
    clearPendingInlineFormats();
    filePathLabel.textContent = "Select a file";
    updateSaveButtonState();
    updateStatusLine();
    syncCurrentSelectionToUrl({});
    scheduleDiffGutterRefresh();
    updateCustomCaret();
  }

  function scheduleAutoRefresh() {
    if (autoRefreshStopped) {
      return;
    }

    autoRefreshTimeoutId = window.setTimeout(() => {
      void runAutoRefresh();
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  async function runAutoRefresh() {
    if (autoRefreshStopped) {
      return;
    }

    try {
      await refreshTree({ preserveSelection: true });
    } catch {
      // Keep polling even if a transient refresh request fails.
    } finally {
      scheduleAutoRefresh();
    }
  }

  const controls: WorkbenchControls = {
    createEntry,
    openFile,
    openThread,
    sendThreadMessage,
    toggleDirectory,
  };

  hydrateDraftBuffers(await getPersistedDraftRecords());
  bindings.onControlsReady?.(controls);
  emitExplorerStateChange();
  emitCurrentThreadChange();
  applyEditorFontSize();
  updateSaveButtonState();
  await refreshTree();
  scheduleAutoRefresh();
  return () => {
    autoRefreshStopped = true;
    if (autoRefreshTimeoutId !== null) {
      window.clearTimeout(autoRefreshTimeoutId);
    }
    if (diffRefreshFrameId !== null) {
      window.cancelAnimationFrame(diffRefreshFrameId);
    }
    if (selectionPersistenceTimeoutId !== null) {
      window.clearTimeout(selectionPersistenceTimeoutId);
    }
    abortController.abort();
  };
}
