/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, polling, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, polling.
 */

import type { RateLimitSnapshot } from "./codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "./codex/thread-state";
import type {
    ExplorerSnapshot,
    SaveConflictPayload,
    ThreadPayload,
    WorkbenchBindings,
    WorkbenchControls,
    WorkbenchHarness,
} from "./types";
import {
    getRequestedPathFromUrl,
    getRequestedThreadIdFromUrl,
    readStoredHarness,
    syncCurrentSelectionToUrl
} from "./workbench/browser-state";
import {
    createWorkbenchCodeFormatController,
} from "./workbench/code-format";
import {
    removeEmptyInlineFormatElements,
    replaceTag,
    unwrapTransparentSpans,
} from "./workbench/dom-normalization";
import {
    cloneHistorySelection,
    countHistoryStatesSinceSnapshot,
    createHistoryPatch,
    materializeHistoryContent,
    mergeHistoryPatches,
    normalizeEditHistory,
    trimEditHistory,
    type EditHistorySelection,
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
} from "./workbench/markdown-render";
import { createRevisionHoverToolbarController } from "./workbench/revision-hover-toolbar";
import {
    ensureParagraphHasEditableContent,
} from "./workbench/rich-input-dom";
import {
    inspectDraftContent,
    inspectSaveGuardMarkup,
    isSameSaveGuardIssue,
    logSaveGuardIssue,
} from "./workbench/save-guard-inspector";
import {
    captureEditorSelection,
    placeCaretInElement,
    restoreEditorSelection,
    restoreListItemSelection,
} from "./workbench/selection-dom";
import {
    getDirectChildSummaryTextElement,
    hasDirectBlockLikeChildren,
    mergeAdjacentSiblingLists,
    normalizeNestedListHierarchy,
    syncStructuredBlockStyles as syncStructuredBlockDomStyles
} from "./workbench/structured-block-dom";
import {
    deleteTextImmediatelyBeforeSelection,
    getTextBeforeSelectionInElement,
} from "./workbench/text-position-dom";
import {
    formatTimestamp
} from "./workbench/tree-utils";
import {
    getEditorLineHeight,
    getExpandedRangeRect,
    getVisualViewportMetrics,
} from "./workbench/viewport-metrics";
import { hasRequiredWorkbenchDomElements, type WorkbenchDomElements } from "./workbench/workbench-dom";
import {
    createInitialWorkbenchEditorSnapshot,
    createWorkbenchEditorClient,
    type EditorMode,
    type SaveGuardIssue,
    type WorkbenchEditorSnapshot,
} from "./workbench/workbench-editor-client";
import {
    createWorkbenchFileClient,
    type DraftBuffer,
    type WorkbenchFileLifecycleState,
} from "./workbench/workbench-file-client";
import {
    cloneTreeNodes,
    createWorkbenchProjectClient,
    type WorkbenchProjectSnapshot,
} from "./workbench/workbench-project-client";
import {
    createWorkbenchThreadClient,
    type WorkbenchThreadSnapshot,
} from "./workbench/workbench-thread-client";

interface WorkbenchState {
  baselineContent: string;
  currentContent: string;
  draftBuffers: Map<string, DraftBuffer>;
  editor: WorkbenchEditorSnapshot;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history: EditHistoryState | null;
  lastLoggedSaveIssue: SaveGuardIssue | null;
  project: WorkbenchProjectSnapshot;
  thread: WorkbenchThreadSnapshot;
}

const AUTO_REFRESH_INTERVAL_MS = 1500;
const HISTORY_KEYFRAME_INTERVAL = 50;

export async function initWorkbench(
  bindings: WorkbenchBindings & { elements?: WorkbenchDomElements | null } = {},
): Promise<() => void> {
  const { elements, ...workbenchBindings } = bindings;
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
  const state: WorkbenchState = {
    baselineContent: "",
    currentContent: "",
    draftBuffers: new Map(),
    editor: createInitialWorkbenchEditorSnapshot(),
    expectedMtimeMs: null,
    headContent: null,
    history: null,
    lastLoggedSaveIssue: null,
    project: projectClient.getSnapshot(),
    thread: threadClient.getSnapshot(),
  };
  const {
    applyHoveredRevisionAction,
    getSelectedRevisionToolbarContext,
    isPointerNearRevisionHoverUi,
    setHoveredRevisionNode,
    updateRevisionHoverToolbar,
  } = createRevisionHoverToolbarController({
    editor,
    getExpandedRangeRect,
    getMode: () => state.editor.mode,
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
    state.project = snapshot;
    threadClient.setProjectContext({
      root: snapshot.root,
      rootPath: snapshot.rootPath,
    });
    emitExplorerStateChange();
  });

  const unsubscribeThreadClient = threadClient.subscribe((snapshot) => {
    const previousThread = state.thread.currentThread;
    const previousRateLimits = state.thread.rateLimits;
    const previousThreadId = state.thread.currentThreadId;
    const previousThreads = state.thread.threads;
    const previousThreadsError = state.thread.threadsError;

    state.thread = snapshot;

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
      placeCaretInElement(editor, summaryText, event.clientX, event.clientY);
    },
    handleEditorFocus: () => {
      editorHasFocus = true;
      updateCustomCaret();
    },
    handleEditorInput: (event) => {
      const previousContent = state.currentContent;
      const { transformedListItem, commentCaretMarker: richInputCommentCaretMarker } = editorClient.handleRichInput(event);
      const commentCaretMarker = richInputCommentCaretMarker ?? maybeActivateInlineCommentShortcut(event);
      syncStructuredBlockStyles();
      if (transformedListItem) {
        restoreListItemSelection([transformedListItem], {
          collapsed: true,
          getListItemTextContainer,
        });
      }
      if (commentCaretMarker) {
        restoreCaretToMarker(commentCaretMarker);
      }
      inspectCurrentDraft();
      recordEditHistory(previousContent, state.currentContent, captureEditorSelection(editor));
      syncCurrentDraftBuffer();
      editorClient.scheduleDiffGutterRefresh();
      editorClient.refreshStatusMessage();
      refreshInlineToolbars();
    },
    handleEditorKeyDown: (event) => {
      if (!state.editor.currentPath || state.editor.mode !== "rich") {
        return;
      }

      maybeClearPendingInlineFormatsForKey(event);

      if (editorClient.handleListStructureKeyDown(event)) {
        return;
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

      if (editorClient.handleFormatKeyDown(event)) {
        return;
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
      if (!state.editor.currentPath) {
        return;
      }

      await openFile(state.editor.currentPath, { ignoreDirty: true, source: "reload" });
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

      updateHistorySelection(captureEditorSelection(editor));
      scheduleSelectionPersistence();
      refreshInlineToolbars();
    },
    handleToolbarCommand: (command) => {
      if (command) {
        editorClient.applyToolbarCommand(command);
      }
    },
    handleViewportChanged: () => {
      editorClient.scheduleDiffGutterRefresh();
      updateFloatingToolbar();
      updateRevisionHoverToolbar();
      updateCustomCaret();
    },
    listStructure: {
      getClosestListItem,
      getListItemTextContainer,
      getSelectedListItems,
      indentListItems,
      isSelectionAtListItemStart,
      isTopLevelListItem,
      outdentListItems,
      syncEditorAfterStructuralChange,
      unwrapTopLevelListItemToParagraph,
      updateFloatingToolbar,
    },
    isSaveButtonInvalid: () => Boolean(state.editor.saveIssue) || Array.from(state.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
    shouldBlockBeforeUnload: () => Boolean(state.editor.saveIssue) || Array.from(state.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
  });
  reportStatusMessage = (message) => {
    editorClient.refreshStatusMessage(message);
  };
  const unsubscribeEditorClient = editorClient.subscribe((snapshot) => {
    const previousSnapshot = state.editor;
    state.editor = snapshot;

    if (
      previousSnapshot.currentPath !== snapshot.currentPath
      || previousSnapshot.dirty !== snapshot.dirty
      || previousSnapshot.fontSize !== snapshot.fontSize
    ) {
      emitExplorerStateChange();
    }
  });

  const inlineFormatController = createWorkbenchInlineFormatController({
    captureEditorSelection: () => captureEditorSelection(editor),
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

  editorClient.configureFormatCommands({
    clearPendingInlineFormats,
    syncEditorAfterStructuralChange,
    toggleCodeSelection,
    toggleInlineFormatSelection,
    togglePendingInlineFormat,
  });

  const canonicalizeAllInlineRunContainers = (root: ParentNode) => {
    inlineFormatController.canonicalizeAllInlineRunContainers(root);
  };

  const getCaretInlineContext = (range: Range) => {
    return inlineFormatController.getCaretInlineContext(range);
  };

  const fileLifecycleState: WorkbenchFileLifecycleState = {
    get baselineContent() {
      return state.baselineContent;
    },
    set baselineContent(value) {
      state.baselineContent = value;
    },
    get currentContent() {
      return state.currentContent;
    },
    set currentContent(value) {
      state.currentContent = value;
    },
    get currentPath() {
      return state.editor.currentPath;
    },
    set currentPath(value) {
      editorClient.setCurrentFilePath(value);
    },
    get currentThread() {
      return state.thread.currentThread;
    },
    set currentThread(value) {
      state.thread.currentThread = value;
    },
    get currentThreadId() {
      return state.thread.currentThreadId;
    },
    set currentThreadId(value) {
      state.thread.currentThreadId = value;
    },
    get dirty() {
      return state.editor.dirty;
    },
    set dirty(value) {
      editorClient.setDirty(value);
    },
    get draftBuffers() {
      return state.draftBuffers;
    },
    set draftBuffers(value) {
      state.draftBuffers = value;
    },
    get expectedMtimeMs() {
      return state.expectedMtimeMs;
    },
    set expectedMtimeMs(value) {
      state.expectedMtimeMs = value;
    },
    get headContent() {
      return state.headContent;
    },
    set headContent(value) {
      state.headContent = value;
    },
    get history() {
      return state.history;
    },
    set history(value) {
      state.history = value;
    },
    get lastLoggedSaveIssue() {
      return state.lastLoggedSaveIssue;
    },
    set lastLoggedSaveIssue(value) {
      state.lastLoggedSaveIssue = value;
    },
    get mode() {
      return state.editor.mode;
    },
    set mode(value) {
      editorClient.setMode(value);
    },
    get pendingWriteConflict() {
      return state.editor.pendingWriteConflict;
    },
    set pendingWriteConflict(value) {
      editorClient.setPendingWriteConflict(value);
    },
    get saveIssue() {
      return state.editor.saveIssue;
    },
    set saveIssue(value) {
      editorClient.setSaveIssue(value);
    },
  };

  const fileClient = createWorkbenchFileClient({
    applyEditorFontSize,
    captureEditorSelection: () => captureEditorSelection(editor),
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
    restoreEditorSelection: (selection) => restoreEditorSelection(editor, selection),
    showWriteConflict,
    state: fileLifecycleState,
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
    editorClient.setPendingWriteConflict(null);
  }

  function showWriteConflict(conflict: SaveConflictPayload) {
    editorClient.showSaveConflict({
      ...conflict,
      expectedUpdatedAt: formatTimestamp(conflict.expectedUpdatedAt),
      actualUpdatedAt: formatTimestamp(conflict.actualUpdatedAt),
    });
  }

  function getLocallyModifiedPaths() {
    const modifiedPaths = new Set<string>();

    if (state.editor.currentPath && state.editor.dirty) {
      modifiedPaths.add(state.editor.currentPath);
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
      root: state.project.root,
      rootPath: state.project.rootPath,
      tree: cloneTreeNodes(state.project.tree),
      threads: state.thread.threads,
      changes: { ...state.project.changes },
      currentPath: state.editor.currentPath,
      currentThreadId: state.thread.currentThreadId,
      expandedDirectories: [...state.project.expandedDirectories],
      locallyModifiedPaths: getLocallyModifiedPaths(),
      threadsError: state.thread.threadsError,
      fontSize: state.editor.fontSize,
    };
  }

  function emitExplorerStateChange() {
    workbenchBindings.onExplorerStateChange?.(getExplorerSnapshot());
  }

  function emitCurrentThreadChange() {
    workbenchBindings.onCurrentThreadChange?.(state.thread.currentThread);
  }

  function emitRateLimitsChange() {
    workbenchBindings.onRateLimitsChange?.(state.thread.rateLimits);
  }

  function setRateLimits(rateLimits: RateLimitSnapshot | null) {
    state.thread.rateLimits = rateLimits;
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
    if (areThreadPayloadsEquivalent(state.thread.currentThread, thread)) {
      return;
    }

    const previousThread = state.thread.currentThread;
    state.thread.currentThread = thread;
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
    if (!state.thread.currentThread) {
      return false;
    }

    const nextThread = updater(state.thread.currentThread);
    if (!nextThread) {
      return false;
    }

    setCurrentThread(nextThread);
    return true;
  }

  function toggleDirectory(path: string) {
    projectClient.toggleDirectory(path);
  }

  function applyEditorFontSize() {
    state.editor = editorClient.getSnapshot();
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
    const protectedElements = getProtectedEmptyInlineFormatElements(root);
    removeEmptyInlineFormatElements(["strong", "em", "code", "del", "ins"], root, protectedElements);

    if (!("querySelectorAll" in root)) {
      return;
    }

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

  function refreshSaveGuardState() {
    if (!state.editor.currentPath || state.editor.mode !== "rich") {
      state.currentContent = "";
      editorClient.setSaveIssue(null);
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      return { markdown: "", issue: null };
    }

    const inspection = inspectSaveGuardMarkup({
      editorRoot: editor,
      isInlineRunContainer,
      normalizeMarkup: normalizeEditorMarkup,
    });
    editorClient.setSaveIssue(inspection.issue);
    syncSaveIssueLogging(inspection.issue, "markup mismatch detected while editing");
    updateSaveButtonState();
    return inspection;
  }

  function inspectCurrentDraft() {
    if (!state.editor.currentPath) {
      state.currentContent = "";
      editorClient.setDirty(false);
      state.expectedMtimeMs = null;
      editorClient.setSaveIssue(null);
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      return { content: "", issue: null };
    }

    if (state.editor.mode !== "rich") {
      editorClient.setSaveIssue(null);
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      const inspection = inspectDraftContent({
        mode: state.editor.mode,
        plainTextContent: editor.textContent ?? "",
      });
      state.currentContent = inspection.content;
      editorClient.setDirty(inspection.content !== state.baselineContent);
      return inspection;
    }

    const saveGuardInspection = refreshSaveGuardState();
    const inspection = inspectDraftContent({
      mode: state.editor.mode,
      plainTextContent: editor.textContent ?? "",
      richInspection: saveGuardInspection,
    });
    state.currentContent = inspection.content;
    editorClient.setDirty(inspection.content !== state.baselineContent);
    return inspection;
  }

  function syncSaveIssueLogging(issue: SaveGuardIssue | null, trigger: string, force = false) {
    if (!issue) {
      state.lastLoggedSaveIssue = null;
      return;
    }

    if (!force && isSameSaveGuardIssue(state.lastLoggedSaveIssue, issue)) {
      return;
    }

    logSaveGuardIssue(issue, state.editor.currentPath, trigger);
    state.lastLoggedSaveIssue = { ...issue };
  }

  function renderEditorDocument(content: string, mode: EditorMode) {
    editorClient.setMode(mode);

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
    renderEditorDocument(nextContent, state.editor.mode);
    inspectCurrentDraft();
    restoreEditorSelection(editor, history.frames[clampedIndex]?.selection ?? null);
    updateHistorySelection(captureEditorSelection(editor));
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
    state.thread.currentThreadId = payload.id;
    state.expectedMtimeMs = null;
    state.headContent = null;
    state.lastLoggedSaveIssue = null;
    editorClient.setCurrentThreadId(payload.id);
    editorClient.showThreadPlaceholder(payload.name || payload.preview || payload.id);
    state.baselineContent = "";
    state.currentContent = "";
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
    if (source === "open" && threadId === state.thread.currentThreadId) {
      return;
    }

    if (state.editor.currentPath) {
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

  function syncEditorAfterStructuralChange() {
    const previousContent = state.currentContent;
    syncStructuredBlockStyles();
    inspectCurrentDraft();
    recordEditHistory(previousContent, state.currentContent, captureEditorSelection(editor));
    syncCurrentDraftBuffer();
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshStatusMessage();
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
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
    const caretHeight = Math.max(14, context.rect.height || getEditorLineHeight(editor));

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

  function updateFloatingToolbar() {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      selection.isCollapsed ||
      state.editor.mode !== "rich" ||
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
    threadClient.clearThreadSelection();
    state.thread.currentThread = null;
    state.thread.currentThreadId = "";
    state.currentContent = "";
    state.expectedMtimeMs = null;
    state.headContent = null;
    state.history = null;
    state.lastLoggedSaveIssue = null;
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
    const shouldBlockOnThreads = Boolean(state.thread.currentThreadId || requestedThreadId);

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

    if (preserveSelection && state.thread.currentThreadId) {
      const currentThreadId = state.thread.currentThreadId;
      if (state.thread.currentThread?.isDraft && state.thread.currentThread.id === currentThreadId) {
        return;
      }

      if (state.thread.threads.some((thread) => thread.id === currentThreadId)) {
        if (!threadClient.isCurrentThreadUpToDate(currentThreadId)) {
          await openThread(currentThreadId, { source: "reload" });
        }
        if (state.thread.currentThreadId === currentThreadId) {
          return;
        }
      } else {
        threadClient.clearThreadSelection();
        state.thread.currentThread = null;
        state.thread.currentThreadId = "";
        syncCurrentSelectionToUrl({});
        emitExplorerStateChange();
      }
    }

    if (preserveSelection && state.editor.currentPath) {
      const currentPath = state.editor.currentPath;
      await refreshCurrentFileFromDiskIfSafe();
      if (state.editor.currentPath === currentPath) {
        return;
      }
    }

    if (requestedThreadId) {
      if (state.thread.threads.some((thread) => thread.id === requestedThreadId)) {
        await openThread(requestedThreadId);
        if (state.thread.currentThreadId === requestedThreadId) {
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
      if (state.editor.currentPath === requestedPath) {
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
      if (state.editor.currentPath) {
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
