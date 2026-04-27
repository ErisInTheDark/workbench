/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, polling, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, polling.
 */

import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "./codex/thread-state";
import type {
    ChangeSummary,
    ExplorerSnapshot,
    SaveConflictPayload,
    ThreadPayload,
    ThreadSummary,
    TreeNode,
    WorkbenchBindings,
    WorkbenchControls,
    WorkbenchHarness,
} from "./types";
import {
    getRequestedPathFromUrl,
    getRequestedThreadIdFromUrl,
    readStoredExpandedDirectories,
    readStoredFontSize,
    readStoredHarness,
    syncCurrentSelectionToUrl
} from "./workbench/browser-state";
import {
    createWorkbenchCodeFormatController,
} from "./workbench/code-format";
import {
    cloneHistorySelection,
    countHistoryStatesSinceSnapshot,
    createHistoryPatch,
    materializeHistoryContent,
    mergeHistoryPatches,
    normalizeEditHistory,
    trimEditHistory,
    type EditHistorySelection,
    type EditHistorySelectionPoint,
    type EditHistoryState,
} from "./workbench/edit-history";
import {
    createWorkbenchInlineFormatController,
    restoreCaretToMarker,
    type PendingInlineFormatKey,
} from "./workbench/inline-format";
import {
    getDirectChildDetailsElement,
    getDirectChildListElements,
} from "./workbench/list-dom";
import {
    createListItemDomEditor,
} from "./workbench/list-item-dom-edit";
import {
    markdownToHtml as renderMarkdownToHtml,
    type ParsedBlock,
    type ParsedListItem,
} from "./workbench/markdown-render";
import {
    createWorkbenchMarkupSignature,
    serializeListItemMainText,
    serializeWorkbenchDomToMarkdown,
} from "./workbench/markdown-serialization";
import { createRevisionHoverToolbarController } from "./workbench/revision-hover-toolbar";
import {
    convertCommentBlockToParagraph,
    getDirectChildSummaryTextElement,
    hasDirectBlockLikeChildren,
    mergeAdjacentSiblingLists,
    normalizeNestedListHierarchy,
    syncStructuredBlockStyles as syncStructuredBlockDomStyles
} from "./workbench/structured-block-dom";
import {
    formatTimestamp
} from "./workbench/tree-utils";
import { hasRequiredWorkbenchDomElements, type WorkbenchDomElements } from "./workbench/workbench-dom";
import { createWorkbenchEditorClient, type EditorMode, type SaveGuardIssue } from "./workbench/workbench-editor-client";
import { createWorkbenchFileClient, type DraftBuffer } from "./workbench/workbench-file-client";
import { cloneTreeNodes, createWorkbenchProjectClient } from "./workbench/workbench-project-client";
import { createWorkbenchThreadClient } from "./workbench/workbench-thread-client";

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
  rateLimits: RateLimitSnapshot | null;
  saveIssue: SaveGuardIssue | null;
  expandedDirectories: Set<string>;
}

const AUTO_REFRESH_INTERVAL_MS = 1500;
const HISTORY_KEYFRAME_INTERVAL = 50;

export async function initWorkbench(
  bindings: WorkbenchBindings & { elements?: WorkbenchDomElements | null } = {},
): Promise<() => void> {
  const { elements, ...workbenchBindings } = bindings;
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
    rateLimits: null,
    saveIssue: null,
    expandedDirectories: new Set(readStoredExpandedDirectories()),
  };

  if (!hasRequiredWorkbenchDomElements(elements)) {
    return () => {};
  }

  const editor = elements.editor;
  const customCaret = elements.customCaret;
  const floatingToolbar = elements.toolbars.floating;
  const revisionHoverToolbar = elements.toolbars.revisionHover;
  const revisionHoverAcceptButton = elements.toolbars.revisionAccept;
  const revisionHoverRejectButton = elements.toolbars.revisionReject;
  const saveConflictDialog = elements.saveConflictDialog.dialog;
  const resetDraftDialog = elements.resetDraftDialog.dialog;
  const {
    getClosestListItem,
    getListItemTextContainer,
    getSelectedListItems,
    indentListItems,
    isSelectionAtListItemStart,
    isTopLevelListItem,
    outdentListItems,
    unwrapTopLevelListItemToParagraph,
  } = createListItemDomEditor({
    root: editor,
    ensureParagraphHasEditableContent,
    getDirectChildSummaryTextElement,
  });

  const abortController = new AbortController();
  let autoRefreshTimeoutId: number | null = null;
  let autoRefreshStopped = false;
  let codexThreadRefreshTimeoutId: number | null = null;
  let codexThreadListRefreshTimeoutId: number | null = null;
  const rateLimitsByHarness = new Map<WorkbenchHarness, RateLimitSnapshot | null>();
  let editorHasFocus = false;
  let isComposing = false;
  const editorShell = elements.diffGutter.parentElement;
  let reportStatusMessage = (_message: string) => {};
  const projectClient = createWorkbenchProjectClient();
  const threadClient = createWorkbenchThreadClient({
    onStatusMessage: (message) => {
      reportStatusMessage(message);
    },
  });
  const {
    applyHoveredRevisionAction,
    getSelectedRevisionToolbarContext,
    isPointerNearRevisionHoverUi,
    setHoveredRevisionNode,
    updateRevisionHoverToolbar,
  } = createRevisionHoverToolbarController({
    editor,
    getExpandedRangeRect,
    getMode: () => state.mode,
    getVisualViewportMetrics,
    onSyncEditorAfterStructuralChange: () => {
      syncEditorAfterStructuralChange();
    },
    revisionHoverAcceptButton,
    revisionHoverRejectButton,
    revisionHoverToolbar,
  });

  if (!editorShell) {
    return () => {};
  }

  const unsubscribeProjectClient = projectClient.subscribe((snapshot) => {
    state.root = snapshot.root;
    state.rootPath = snapshot.rootPath;
    state.tree = snapshot.tree;
    state.changes = snapshot.changes;
    state.expandedDirectories = new Set(snapshot.expandedDirectories);
    threadClient.setProjectContext({
      root: snapshot.root,
      rootPath: snapshot.rootPath,
    });
    emitExplorerStateChange();
  });

  const unsubscribeThreadClient = threadClient.subscribe((snapshot) => {
    const previousThread = state.currentThread;
    const previousRateLimits = state.rateLimits;
    const previousThreadId = state.currentThreadId;
    const previousThreads = state.threads;
    const previousThreadsError = state.threadsError;

    state.currentThread = snapshot.currentThread;
    state.currentThreadId = snapshot.currentThreadId;
    state.rateLimits = snapshot.rateLimits;
    state.threads = snapshot.threads;
    state.threadsError = snapshot.threadsError;

    if (!areThreadPayloadsEquivalent(previousThread, snapshot.currentThread)) {
      emitCurrentThreadChange();
    }

    if (previousRateLimits !== snapshot.rateLimits) {
      emitRateLimitsChange();
    }

    if (
      previousThreadId !== snapshot.currentThreadId
      || previousThreads !== snapshot.threads
      || previousThreadsError !== snapshot.threadsError
    ) {
      emitExplorerStateChange();
    }
  });

  document.execCommand?.("defaultParagraphSeparator", false, "p");

  const dialogs = [saveConflictDialog, resetDraftDialog] as const;

  function isDialogOpen(dialog: HTMLDivElement) {
    return !dialog.hidden;
  }

  function hideDialog(dialog: HTMLDivElement) {
    dialog.hidden = true;
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

  function updateInlineToolbars() {
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
  }

  const refreshInlineToolbars = () => {
    window.requestAnimationFrame(() => {
      updateInlineToolbars();
      updateCustomCaret();
    });
  };

  const editorClient = createWorkbenchEditorClient(elements, {
    closeActiveDialog,
    getDiffGutterContent: () => ({
      currentContent: state.currentContent,
      headContent: state.headContent,
    }),
    getProjectChangeSummary: (path) => projectClient.getSnapshot().changes[path] ?? null,
    handleCompositionEnd: () => {
      isComposing = false;
      window.requestAnimationFrame(updateCustomCaret);
    },
    handleCompositionStart: () => {
      isComposing = true;
      clearPendingInlineFormats();
      updateCustomCaret();
    },
    handleEditorBeforeInput: (event) => {
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
    },
    handleEditorBlur: () => {
      editorHasFocus = false;
      clearPendingInlineFormats();
      updateCustomCaret();
    },
    handleEditorClick: (event) => {
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
    },
    handleEditorFocus: () => {
      editorHasFocus = true;
      updateCustomCaret();
    },
    handleEditorInput: (event) => {
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
      editorClient.scheduleDiffGutterRefresh();
      editorClient.refreshStatusMessage();
      refreshInlineToolbars();
    },
    handleEditorKeyDown: (event) => {
      if (!state.currentPath || state.mode !== "rich") {
        return;
      }

      maybeClearPendingInlineFormatsForKey(event);

      if (event.key === "Tab" && handleListTab(event)) {
        return;
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
    },
    handleEditorPointerDown: () => {
      clearPendingInlineFormats();
    },
    handleEditorToggle: (event) => {
      if (!(event.target instanceof HTMLDetailsElement)) {
        return;
      }

      editorClient.scheduleDiffGutterRefresh();
    },
    handleOverwriteConflict: async () => {
      await saveCurrentFile({ force: true });
    },
    handlePointerMove: (event) => {
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
    },
    handleRefreshInlineToolbars: refreshInlineToolbars,
    handleReloadConflict: async () => {
      if (!state.currentPath) {
        return;
      }

      await openFile(state.currentPath, { ignoreDirty: true, source: "reload" });
    },
    handleResetCurrentDraftToSaved: async () => {
      await resetCurrentDraftToSaved();
    },
    handleResetCurrentFileToHead: async () => {
      await resetCurrentFileToHead();
    },
    handleRevisionAction: (action) => {
      applyHoveredRevisionAction(action);
    },
    handleSaveCurrentFile: async () => {
      await saveCurrentFile();
    },
    handleSelectionChange: () => {
      handlePendingInlineSelectionChange();

      updateHistorySelection(captureEditorSelection());
      scheduleSelectionPersistence();
      refreshInlineToolbars();
    },
    handleToolbarCommand: (command) => {
      applyToolbarCommand(command);
    },
    handleViewportChanged: () => {
      editorClient.scheduleDiffGutterRefresh();
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
    },
    isSaveButtonInvalid: () => Boolean(state.saveIssue) || Array.from(state.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
    shouldBlockBeforeUnload: () => Boolean(state.saveIssue) || Array.from(state.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
  });
  reportStatusMessage = (message) => {
    editorClient.refreshStatusMessage(message);
  };
  const unsubscribeEditorClient = editorClient.subscribe((snapshot) => {
    if (state.fontSize !== snapshot.fontSize) {
      state.fontSize = snapshot.fontSize;
      emitExplorerStateChange();
    }
  });

  const inlineFormatController = createWorkbenchInlineFormatController({
    captureEditorSelection,
    deleteTextImmediatelyBeforeSelection,
    editor,
    getEditorHasFocus: () => editorHasFocus,
    getInlineExpansionContainer,
    getInlineRunContainer,
    getIsComposing: () => isComposing,
    getTextBeforeSelectionInElement,
    isInlineRunContainer,
    refreshStatusMessage: () => {
      editorClient.refreshStatusMessage();
    },
    syncCurrentDraftBuffer,
    syncEditorAfterStructuralChange,
    updateCustomCaret,
    updateHistorySelection,
    updateInlineToolbars,
  });
  const codeFormatController = createWorkbenchCodeFormatController({
    editor,
    getProtectedEmptyInlineFormatElements,
    syncEditorAfterStructuralChange,
  });

  const clearPendingInlineFormats = () => {
    inlineFormatController.clearPendingInlineFormats();
  };

  const handlePendingInlineBeforeInput = (event: InputEvent) => {
    return inlineFormatController.handlePendingInlineBeforeInput(event);
  };

  const handlePendingInlineSelectionChange = () => {
    inlineFormatController.handleSelectionChange();
  };

  const maybeActivateInlineCommentShortcut = (event: Event) => {
    return inlineFormatController.maybeActivateInlineCommentShortcut(event);
  };

  const maybeClearPendingInlineFormatsForKey = (event: KeyboardEvent) => {
    inlineFormatController.maybeClearPendingInlineFormatsForKey(event);
  };

  const toggleInlineFormatSelection = (
    selection: Selection,
    range: Range,
    _tagName: "comment" | "strong" | "em" | "del" | "ins",
    formatKey: "bold" | "italic" | "comment" | "del" | "ins",
  ) => {
    inlineFormatController.toggleInlineFormatSelection(selection, range, formatKey);
  };

  const toggleCodeSelection = (selection: Selection, range: Range) => {
    codeFormatController.toggleCodeSelection(selection, range);
  };

  const togglePendingInlineFormat = (format: PendingInlineFormatKey) => {
    return inlineFormatController.togglePendingInlineFormat(format);
  };

  const canonicalizeAllInlineRunContainers = (root: ParentNode) => {
    inlineFormatController.canonicalizeAllInlineRunContainers(root);
  };

  const getCaretInlineContext = (range: Range) => {
    return inlineFormatController.getCaretInlineContext(range);
  };

  const fileClient = createWorkbenchFileClient({
    applyEditorFontSize,
    captureEditorSelection,
    clearWriteConflict,
    editor,
    editorClient,
    emitExplorerStateChange,
    hideResetDraftDialog,
    inspectCurrentDraft,
    logBlockedSaveIssue: (issue) => {
      syncSaveIssueLogging(issue, "save attempt blocked by markup mismatch", true);
    },
    projectClient,
    refreshEditorChrome: () => {
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
    },
    refreshSaveGuardState,
    renderEditorDocument,
    restoreEditorSelection,
    showWriteConflict,
    state,
    syncSelectionToUrl: syncCurrentSelectionToUrl,
    syncStructuredBlockStyles,
    threadClient,
    updateHistorySelection,
    updateSaveButtonState,
  });

  function scheduleSelectionPersistence() {
    fileClient.scheduleSelectionPersistence();
  }

  function syncCurrentDraftBuffer() {
    fileClient.syncCurrentDraftBuffer();
  }

  async function openFile(
    filePath: string,
    options?: { ignoreDirty?: boolean; source?: "open" | "reload" },
  ) {
    await fileClient.openFile(filePath, options);
  }

  async function resetCurrentDraftToSaved() {
    await fileClient.resetCurrentDraftToSaved();
  }

  async function resetCurrentFileToHead() {
    await fileClient.resetCurrentFileToHead();
  }

  async function saveCurrentFile(options?: { force?: boolean }) {
    await fileClient.saveCurrentFile(options);
  }

  async function refreshCurrentFileFromDiskIfSafe() {
    await fileClient.refreshCurrentFileFromDiskIfSafe();
  }

  function updateHistorySelection(selection: EditHistorySelection | null) {
    if (!state.history?.frames.length) {
      return;
    }

    state.history.frames[state.history.currentIndex].selection = cloneHistorySelection(selection);
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

  function syncStructuredBlockStyles(root: ParentNode = editor) {
    syncStructuredBlockDomStyles(root, {
      canonicalizeInlineRunContainers: canonicalizeAllInlineRunContainers,
      removeEmptyInlineFormattingArtifacts,
    });
  }

  function updateSaveButtonState() {
    editorClient.setSaveButtonState();
  }

  function hideSaveConflictDialog() {
    editorClient.hideSaveConflictDialog();
  }

  function hideResetDraftDialog() {
    editorClient.hideResetDraftDialog();
  }

  function clearWriteConflict() {
    state.pendingWriteConflict = null;
    hideSaveConflictDialog();
  }

  function showWriteConflict(conflict: SaveConflictPayload) {
    state.pendingWriteConflict = conflict;
    editorClient.showSaveConflict({
      ...conflict,
      expectedUpdatedAt: formatTimestamp(conflict.expectedUpdatedAt),
      actualUpdatedAt: formatTimestamp(conflict.actualUpdatedAt),
    });
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
      tree: cloneTreeNodes(state.tree),
      threads: state.threads,
      changes: { ...state.changes },
      currentPath: state.currentPath,
      currentThreadId: state.currentThreadId,
      expandedDirectories: Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)),
      locallyModifiedPaths: getLocallyModifiedPaths(),
      threadsError: state.threadsError,
      fontSize: state.fontSize,
    };
  }

  function emitExplorerStateChange() {
    workbenchBindings.onExplorerStateChange?.(getExplorerSnapshot());
  }

  function emitCurrentThreadChange() {
    workbenchBindings.onCurrentThreadChange?.(state.currentThread);
  }

  function emitRateLimitsChange() {
    workbenchBindings.onRateLimitsChange?.(state.rateLimits);
  }

  function setRateLimits(rateLimits: RateLimitSnapshot | null) {
    state.rateLimits = rateLimits;
    emitRateLimitsChange();
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
      && left.harness === right.harness
      && left.model === right.model
      && left.reasoningEffort === right.reasoningEffort
      && left.agentPath === right.agentPath
      && left.isDraft === right.isDraft
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

    const previousThread = state.currentThread;
    state.currentThread = thread;
    emitCurrentThreadChange();

    if (!thread) {
      setRateLimits(null);
      return;
    }

    if (!previousThread || previousThread.id !== thread.id || previousThread.harness !== thread.harness) {
      setRateLimits(rateLimitsByHarness.get(thread.harness) ?? null);

      void refreshRateLimits();
    }
  }

  function updateCurrentThread(updater: (thread: ThreadPayload) => ThreadPayload | null) {
    if (!state.currentThread) {
      return false;
    }

    const nextThread = updater(state.currentThread);
    if (!nextThread) {
      return false;
    }

    setCurrentThread(nextThread);
    return true;
  }

  function updateCurrentThreadFields(fields: Partial<Omit<ThreadPayload, "turns">>) {
    return updateCurrentThread((thread) => ({
      ...thread,
      ...fields,
    }));
  }

  function toggleDirectory(path: string) {
    projectClient.toggleDirectory(path);
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
    state.fontSize = editorClient.getSnapshot().fontSize;
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
        if (
          current instanceof HTMLElement
          && (current.tagName === "STRONG"
            || current.tagName === "EM"
            || current.tagName === "CODE"
            || current.tagName === "DEL"
            || current.tagName === "INS"
            || current.dataset.inlineComment === "true")
        ) {
          protectedElements.add(current);
        }
        current = current.parentNode;
      }
    }

    return protectedElements;
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

  function inspectSaveGuard() {
    const editorSnapshot = editor.cloneNode(true) as HTMLDivElement;
    const markdown = serializeWorkbenchDomToMarkdown(editorSnapshot, {
      isInlineRunContainer,
      normalizeMarkup: normalizeEditorMarkup,
    });
    const currentMarkup = createWorkbenchMarkupSignature(editorSnapshot, { isInlineRunContainer });
    const roundTripRoot = document.createElement("div");
    roundTripRoot.innerHTML = renderMarkdownToHtml(markdown);
    normalizeEditorMarkup(roundTripRoot);

    const roundTripMarkup = createWorkbenchMarkupSignature(roundTripRoot, { isInlineRunContainer });
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
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshStatusMessage();
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

  async function refreshThreads() {
    await threadClient.refreshThreads();
  }

  async function refreshRateLimits() {
    await threadClient.refreshRateLimits();
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
    editorClient.setCurrentThreadId(payload.id);
    editorClient.showThreadPlaceholder(payload.name || payload.preview || payload.id);
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
    editorClient.refreshStatusMessage(statusMessage);
    editorClient.scheduleDiffGutterRefresh();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  }

  async function openThread(
    threadId: string,
    { harness, source = "open" }: { harness?: WorkbenchHarness; source?: "open" | "reload" } = {},
  ) {
    if (source === "open" && threadId === state.currentThreadId) {
      return;
    }

    if (state.currentPath) {
      syncCurrentDraftBuffer();
    }

    await threadClient.openThread(threadId, { harness, source });
    const payload = threadClient.getSnapshot().currentThread;
    if (!payload) {
      return;
    }

    applyThreadPayloadToCurrentView(payload, `Read thread ${new Date(payload.updatedAt * 1000).toLocaleString()}`);
    syncCurrentSelectionToUrl({ threadId: payload.id });
    emitExplorerStateChange();
  }

  async function sendThreadMessage(threadId: string, input: UserInput[]) {
    await threadClient.sendThreadMessage(threadId, input);
    const payload = threadClient.getSnapshot().currentThread;
    if (!payload) {
      return;
    }

    applyThreadPayloadToCurrentView(payload, "Sent message.");
    syncCurrentSelectionToUrl({ threadId: payload.id });
    emitExplorerStateChange();
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    const createdPath = await projectClient.createEntry(parentPath, name, type);

    if (type === "file") {
      await openFile(createdPath);
      editorClient.refreshStatusMessage(`Created ${createdPath}`);
    } else {
      editorClient.refreshStatusMessage(`Created ${createdPath}`);
    }

    return createdPath;
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
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshStatusMessage();
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

  function clearCurrentSelectionView() {
    state.baselineContent = "";
    state.currentPath = "";
    threadClient.clearThreadSelection();
    state.currentThread = null;
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
    editorClient.clearSelectionView();
    updateSaveButtonState();
    editorClient.refreshStatusMessage();
    syncCurrentSelectionToUrl({});
    editorClient.scheduleDiffGutterRefresh();
    updateCustomCaret();
  }

  async function refreshTree({ preserveSelection = false }: { preserveSelection?: boolean } = {}) {
    const payload = await projectClient.refreshProject();
    const requestedThreadId = getRequestedThreadIdFromUrl();
    const shouldBlockOnThreads = Boolean(state.currentThreadId || requestedThreadId);

    if (shouldBlockOnThreads) {
      await refreshThreads();
      emitExplorerStateChange();
    } else {
      emitExplorerStateChange();
      void (async () => {
        await refreshThreads();
        emitExplorerStateChange();
      })();
    }

    if (preserveSelection && state.currentThreadId) {
      const currentThreadId = state.currentThreadId;
      if (state.currentThread?.isDraft && state.currentThread.id === currentThreadId) {
        return;
      }

      if (state.threads.some((thread) => thread.id === currentThreadId)) {
        if (!threadClient.isCurrentThreadUpToDate(currentThreadId)) {
          await openThread(currentThreadId, { source: "reload" });
        }
        if (state.currentThreadId === currentThreadId) {
          return;
        }
      } else {
        threadClient.clearThreadSelection();
        state.currentThread = null;
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

    if (requestedThreadId) {
      if (state.threads.some((thread) => thread.id === requestedThreadId)) {
        await openThread(requestedThreadId);
        if (state.currentThreadId === requestedThreadId) {
          return;
        }
      } else if (threadClient.isDraftThreadId(requestedThreadId)) {
        const draftThread = threadClient.createThread(readStoredHarness(), requestedThreadId);
        applyThreadPayloadToCurrentView(draftThread);
        emitExplorerStateChange();
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

    clearCurrentSelectionView();
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
    clearSelection: () => {
      if (state.currentPath) {
        syncCurrentDraftBuffer();
      }

      threadClient.clearThreadSelection();
      clearCurrentSelectionView();
      emitExplorerStateChange();
    },
    createThread: (harness) => {
      const draftThread = threadClient.createThread(harness);
      applyThreadPayloadToCurrentView(draftThread);
      syncCurrentSelectionToUrl({ threadId: draftThread.id });
      emitExplorerStateChange();
    },
    createEntry,
    listModels: threadClient.listModels,
    openFile,
    openThread,
    sendThreadMessage,
    setCurrentThreadModel: (threadId, model) => {
      threadClient.setCurrentThreadModel(threadId, model);
    },
    setCurrentThreadAgent: (threadId, agentPath) => {
      threadClient.setCurrentThreadAgent(threadId, agentPath);
    },
    setCurrentThreadReasoningEffort: (threadId, effort) => {
      threadClient.setCurrentThreadReasoningEffort(threadId, effort);
    },
    setDraftThreadHarness: (harness) => {
      threadClient.setDraftThreadHarness(harness);
    },
    toggleDirectory,
  };

  await fileClient.hydratePersistedDrafts();
  workbenchBindings.onControlsReady?.(controls);
  emitExplorerStateChange();
  emitCurrentThreadChange();
  emitRateLimitsChange();
  applyEditorFontSize();
  updateSaveButtonState();
  await refreshTree();
  void refreshRateLimits();
  scheduleAutoRefresh();
  return () => {
    autoRefreshStopped = true;
    unsubscribeEditorClient();
    editorClient.dispose();
    fileClient.dispose();
    unsubscribeProjectClient();
    unsubscribeThreadClient();
    projectClient.dispose();
    threadClient.dispose();
    if (autoRefreshTimeoutId !== null) {
      window.clearTimeout(autoRefreshTimeoutId);
    }
    if (codexThreadRefreshTimeoutId !== null) {
      window.clearTimeout(codexThreadRefreshTimeoutId);
    }
    if (codexThreadListRefreshTimeoutId !== null) {
      window.clearTimeout(codexThreadListRefreshTimeoutId);
    }
    abortController.abort();
  };
}
