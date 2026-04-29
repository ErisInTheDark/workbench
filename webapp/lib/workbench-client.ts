/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, polling, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, polling.
 */

import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "./codex/thread-state";
import type {
    ExplorerSnapshot,
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
import type { EditHistorySelection } from "./workbench/edit-history";
import { createEditHistoryManager, type EditHistoryReplayRequest } from "./workbench/EditHistoryManager";
import type { EditorDocumentAdapter } from "./workbench/EditorDocumentAdapter";
import { createFileSessionState } from "./workbench/FileSessionState";
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
import { createSessionState } from "./workbench/SessionState";
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
    createWorkbenchEditorClient,
    type EditorMode,
    type EditorUIStateSnapshot,
    type SaveGuardIssue,
} from "./workbench/workbench-editor-client";
import { createWorkbenchEventBus } from "./workbench/workbench-event-bus";
import {
    createWorkbenchFileClient,
} from "./workbench/workbench-file-client";
import {
    createWorkbenchProjectClient,
} from "./workbench/workbench-project-client";
import {
    createWorkbenchThreadClient,
} from "./workbench/workbench-thread-client";

const AUTO_REFRESH_INTERVAL_MS = 1500;
const HISTORY_KEYFRAME_INTERVAL = 50;

type EditOperationKind = "input" | "structural" | "replay";
type EditOperationRefreshMode = "deferred" | "immediate";

interface EditOperationContext {
  kind: EditOperationKind;
  nextContent: string | null;
  nextSelection: EditHistorySelection | null;
  previousContent: string;
  previousSelection: EditHistorySelection | null;
  recordHistory: boolean;
  refreshMode: EditOperationRefreshMode;
  syncStructuredStyles: boolean;
  updateHistorySelection: boolean;
}

interface EditOperationHooks {
  afterDomMutation?: () => void;
  afterSelectionRestore?: () => void;
}

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
  let editorHasFocus = false;
  let explorerStateChangeScheduled = false;
  let isComposing = false;
  const editorShell = elements.diffGutter.parentElement;
  let reportStatusMessage = (_message: string) => {};
  let lastLoggedSaveIssue: SaveGuardIssue | null = null;
  const eventBus = createWorkbenchEventBus();
  const projectClient = createWorkbenchProjectClient();
  const threadClient = createWorkbenchThreadClient({
    onStatusMessage: (message) => {
      reportStatusMessage(message);
    },
  });
  const initialThreadSnapshot = threadClient.getSnapshot();
  const sessionState = createSessionState({
    currentThread: initialThreadSnapshot.currentThread,
    currentThreadId: initialThreadSnapshot.currentThreadId,
  });
  const fileSessionState = createFileSessionState();
  const {
    applyHoveredRevisionAction,
    getSelectedRevisionToolbarContext,
    isPointerNearRevisionHoverUi,
    setHoveredRevisionNode,
    updateRevisionHoverToolbar,
  } = createRevisionHoverToolbarController({
    editor,
    getExpandedRangeRect,
    getMode: () => fileSessionState.mode,
    getVisualViewportMetrics,
    onSyncEditorAfterStructuralChange: syncEditorAfterStructuralChange,
    revisionHoverAcceptButton,
    revisionHoverRejectButton,
    revisionHoverToolbar,
  });

  if (!editorShell) {
    return () => {};
  }

  const unsubscribeProjectClient = projectClient.subscribe((snapshot) => {
    threadClient.setProjectContext({
      root: snapshot.root,
      rootPath: snapshot.rootPath,
    });
    emitExplorerStateChange();
  });

  let previousThreadSnapshot = initialThreadSnapshot;
  const unsubscribeThreadClient = threadClient.subscribe((snapshot) => {
    const lastSnapshot = previousThreadSnapshot;
    previousThreadSnapshot = snapshot;

    if (!areThreadPayloadsEquivalent(lastSnapshot.currentThread, snapshot.currentThread)) {
      applyCurrentThread(snapshot.currentThread);
    }

    applyCurrentThreadId(snapshot.currentThreadId);

    if (lastSnapshot.rateLimits !== snapshot.rateLimits) {
      emitRateLimitsChange();
    }

    if (
      lastSnapshot.currentThreadId !== snapshot.currentThreadId
      || lastSnapshot.threads !== snapshot.threads
      || lastSnapshot.threadsError !== snapshot.threadsError
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

  function refreshEditorChrome() {
    updateInlineToolbars();
    updateCustomCaret();
  }

  const refreshInlineToolbars = () => {
    window.requestAnimationFrame(() => {
      refreshEditorChrome();
    });
  };

  class EditorMutationRunner {
    private isRunning = false;

    private createContext(
      kind: EditOperationKind,
      overrides: Partial<Omit<EditOperationContext, "kind">> = {},
    ): EditOperationContext {
      return {
        kind,
        nextContent: null,
        nextSelection: null,
        previousContent: fileSessionState.currentContent,
        previousSelection: captureEditorSelection(editor),
        recordHistory: kind !== "replay",
        refreshMode: kind === "input" ? "deferred" : "immediate",
        syncStructuredStyles: kind !== "replay",
        updateHistorySelection: kind === "replay",
        ...overrides,
      };
    }

    runInputMutation(mutate: () => void, hooks: EditOperationHooks = {}): void {
      const context = this.createContext("input");
      this.run(context, mutate, hooks);
    }

    runStructuralMutation(mutate: () => void, hooks: EditOperationHooks = {}): void {
      const context = this.createContext("structural");
      this.run(context, mutate, hooks);
    }

    runHistoryReplay(request: EditHistoryReplayRequest): void {
      const context = this.createContext("replay", {
        nextSelection: request.selection,
      });
      this.run(context, () => {
        clearPendingInlineFormats();
        editorDocument.renderDocument(request.content, fileSessionState.mode);
      });
    }

    run(context: EditOperationContext, mutate: () => void, hooks: EditOperationHooks = {}): void {
      if (this.isRunning) {
        throw new Error("Nested editor mutations are not supported.");
      }

      this.isRunning = true;
      try {
        mutate();

        if (context.syncStructuredStyles) {
          syncStructuredBlockStyles();
        }

        if (hooks.afterDomMutation) {
          hooks.afterDomMutation();
        }

        inspectCurrentDraft();
        context.nextContent = fileSessionState.currentContent;

        if (context.nextSelection !== null || context.kind === "replay") {
          editorDocument.restoreSelection(context.nextSelection);
        }

        if (hooks.afterSelectionRestore) {
          hooks.afterSelectionRestore();
        }

        const currentSelection = captureEditorSelection(editor);
        if (context.recordHistory) {
          editHistoryManager.recordEditHistory(context.previousContent, context.nextContent, currentSelection);
        }

        if (context.updateHistorySelection) {
          editHistoryManager.updateHistorySelection(currentSelection);
        }

        syncCurrentDraftBuffer();
        editorClient.scheduleDiffGutterRefresh();
        editorClient.refreshStatusMessage();

        // Input mutations restore transient markers during the same browser input turn,
        // so their chrome refresh waits one frame; structural and replay mutations can
        // refresh immediately after selection restoration and draft inspection.
        if (context.refreshMode === "deferred") {
          refreshInlineToolbars();
          return;
        }

        refreshEditorChrome();
      } catch (error) {
        console.error(`Workbench ${context.kind} mutation failed.`, {
          nextContent: context.nextContent,
          nextSelection: context.nextSelection,
          previousContent: context.previousContent,
          previousSelection: context.previousSelection,
        }, error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    }
  }

  const editorMutationRunner = new EditorMutationRunner();
  let fileClient: ReturnType<typeof createWorkbenchFileClient>;

  const editorClient = createWorkbenchEditorClient(elements, {
    closeActiveDialog,
    fileSessionState,
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
        editHistoryManager.undoEditHistory();
        return;
      }

      if (event.inputType === "historyRedo") {
        event.preventDefault();
        editHistoryManager.redoEditHistory();
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
      let transformedListItem: HTMLLIElement | null = null;
      let commentCaretMarker: HTMLElement | null = null;

      editorMutationRunner.runInputMutation(() => {
        const { transformedListItem: nextTransformedListItem, commentCaretMarker: richInputCommentCaretMarker } = editorClient.handleRichInput(event);
        transformedListItem = nextTransformedListItem;
        commentCaretMarker = richInputCommentCaretMarker ?? maybeActivateInlineCommentShortcut(event);
      }, {
        afterDomMutation: () => {
          if (transformedListItem) {
            restoreListItemSelection([transformedListItem], {
              collapsed: true,
              getListItemTextContainer,
            });
          }

          if (commentCaretMarker) {
            restoreCaretToMarker(commentCaretMarker);
          }
        },
      });
    },
    handleEditorKeyDown: (event) => {
      if (!sessionState.currentPath || fileSessionState.mode !== "rich") {
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
          editHistoryManager.redoEditHistory();
        } else {
          editHistoryManager.undoEditHistory();
        }
        return;
      }

      if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        editHistoryManager.redoEditHistory();
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
      if (!sessionState.currentPath) {
        return;
      }

      await openFile(sessionState.currentPath, { ignoreDirty: true, source: "reload" });
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

      editHistoryManager.updateHistorySelection(captureEditorSelection(editor));
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
    isSaveButtonInvalid: () => Boolean(fileSessionState.saveIssue) || Array.from(fileSessionState.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
    sessionState,
    shouldBlockBeforeUnload: () => Boolean(fileSessionState.saveIssue) || Array.from(fileSessionState.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
  });
  let previousEditorUiSnapshot: EditorUIStateSnapshot = editorClient.getSnapshot();
  reportStatusMessage = (message) => {
    editorClient.refreshStatusMessage(message);
  };
  const editorDocument: EditorDocumentAdapter = {
    captureSelection: () => captureEditorSelection(editor),
    inspectDraft: () => inspectEditorDraft(),
    inspectRichDocument: () => inspectRichDocument(),
    readRenderedState: (mode) => mode === "rich"
      ? editor.innerHTML
      : editor.textContent ?? "",
    refreshStatusMessage: (message) => {
      editorClient.refreshStatusMessage(message);
    },
    renderDocument: (content, mode, options = {}) => {
      if (mode === "rich") {
        editor.innerHTML = options.renderedState ?? renderMarkdownToHtml(content);
      } else {
        editor.textContent = options.renderedState ?? content;
      }

      syncStructuredBlockStyles();
      editor.scrollTop = 0;
    },
    restoreSelection: (selection) => {
      restoreEditorSelection(editor, selection);
    },
    scheduleDiffGutterRefresh: () => {
      editorClient.scheduleDiffGutterRefresh();
    },
    setEditable: (editable) => {
      editor.setAttribute("contenteditable", editable ? "true" : "false");
    },
  };
  let previousSessionSnapshot = sessionState.getSnapshot();
  const unsubscribeSessionState = sessionState.subscribe((snapshot) => {
    const lastSnapshot = previousSessionSnapshot;
    previousSessionSnapshot = snapshot;

    if (
      lastSnapshot.currentPath !== snapshot.currentPath
      || lastSnapshot.currentThreadId !== snapshot.currentThreadId
    ) {
      emitExplorerStateChange();
    }

    if (lastSnapshot.currentThread !== snapshot.currentThread) {
      emitCurrentThreadChange();
    }
  });
  let previousFileSessionSnapshot = fileSessionState.getSnapshot();
  const unsubscribeFileSessionState = fileSessionState.subscribe((snapshot) => {
    const lastSnapshot = previousFileSessionSnapshot;
    previousFileSessionSnapshot = snapshot;

    if (
      lastSnapshot.dirty !== snapshot.dirty
      || lastSnapshot.mode !== snapshot.mode
      || Boolean(lastSnapshot.saveIssue) !== Boolean(snapshot.saveIssue)
      || Boolean(lastSnapshot.pendingWriteConflict) !== Boolean(snapshot.pendingWriteConflict)
      || lastSnapshot.draftBuffers.size !== snapshot.draftBuffers.size
    ) {
      emitExplorerStateChange();
    }
  });
  const unsubscribeEditorClient = editorClient.subscribe((snapshot) => {
    const previousSnapshot = previousEditorUiSnapshot;
    previousEditorUiSnapshot = snapshot;

    if (previousSnapshot.fontSize !== snapshot.fontSize) {
      emitExplorerStateChange();
    }
  });
  const unsubscribeFileOpened = eventBus.subscribe("fileOpened", () => {
    updateFloatingToolbar();
    updateRevisionHoverToolbar();
    updateCustomCaret();
  });
  const unsubscribeSaveConflictCleared = eventBus.subscribe("saveConflictCleared", () => {
    editorClient.hideSaveConflictDialog();
  });
  const unsubscribeSaveConflictSurfaced = eventBus.subscribe("saveConflictSurfaced", (conflict) => {
    editorClient.showSaveConflict({
      ...conflict,
      expectedUpdatedAt: formatTimestamp(conflict.expectedUpdatedAt),
      actualUpdatedAt: formatTimestamp(conflict.actualUpdatedAt),
    });
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
    updateHistorySelection: (selection) => {
      editHistoryManager.updateHistorySelection(selection);
    },
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

  const editHistoryManager = createEditHistoryManager({
    applyHistoryReplay: (request) => {
      editorMutationRunner.runHistoryReplay(request);
    },
    getCurrentContent: () => fileSessionState.currentContent,
    getHistory: () => fileSessionState.history,
    historyKeyframeInterval: HISTORY_KEYFRAME_INTERVAL,
    setHistory: (history) => {
      fileSessionState.history = history;
    },
  });

  fileClient = createWorkbenchFileClient({
    clearThreadSelection: () => {
      threadClient.clearThreadSelection();
    },
    editorDocument,
    emitExplorerStateChange,
    eventBus,
    expandProjectPath: (filePath) => {
      projectClient.expandPath(filePath);
    },
    fileSessionState,
    logBlockedSaveIssue: (issue) => {
      syncSaveIssueLogging(issue, "save attempt blocked by markup mismatch", true);
    },
    refreshProject: async () => {
      await projectClient.refreshProject();
    },
    sessionState,
    setLastLoggedSaveIssue: (issue) => {
      lastLoggedSaveIssue = issue;
    },
    syncSelectionToUrl: syncCurrentSelectionToUrl,
    updateHistorySelection: editHistoryManager.updateHistorySelection,
  });

  function scheduleSelectionPersistence() {
    fileClient.scheduleSelectionPersistence();
  }

  function syncCurrentDraftBuffer() {
    fileClient.syncCurrentDraftBuffer();
  }

  function inspectCurrentDraft() {
    return fileClient.inspectCurrentDraft();
  }

  async function openFile(
    filePath: string,
    options?: { ignoreDirty?: boolean; source?: "open" | "reload" },
  ) {
    await fileClient.openFile(filePath, options);
  }

  async function resetCurrentDraftToSaved() {
    hideResetDraftDialog();
    await fileClient.resetCurrentDraftToSaved();
    editor.focus();
  }

  async function resetCurrentFileToHead() {
    hideResetDraftDialog();
    await fileClient.resetCurrentFileToHead();
    editor.focus();
  }

  async function saveCurrentFile(options?: { force?: boolean }) {
    await fileClient.saveCurrentFile(options);
  }

  async function refreshCurrentFileFromDiskIfSafe() {
    await fileClient.refreshCurrentFileFromDiskIfSafe();
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

  function hideResetDraftDialog() {
    editorClient.hideResetDraftDialog();
  }

  function getLocallyModifiedPaths() {
    const modifiedPaths = new Set<string>();

    if (sessionState.currentPath && fileSessionState.dirty) {
      modifiedPaths.add(sessionState.currentPath);
    }

    for (const [filePath, buffer] of fileSessionState.draftBuffers) {
      if (buffer.dirty) {
        modifiedPaths.add(filePath);
      }
    }

    return Array.from(modifiedPaths).sort((left, right) => left.localeCompare(right));
  }

  function getExplorerSnapshot(): ExplorerSnapshot {
    const projectSnapshot = projectClient.getSnapshot();
    const threadSnapshot = threadClient.getSnapshot();
    const editorUiSnapshot = editorClient.getSnapshot();

    return {
      root: projectSnapshot.root,
      rootPath: projectSnapshot.rootPath,
      tree: projectSnapshot.tree,
      threads: threadSnapshot.threads,
      changes: projectSnapshot.changes,
      currentPath: sessionState.currentPath,
      currentThreadId: sessionState.currentThreadId,
      expandedDirectories: projectSnapshot.expandedDirectories,
      locallyModifiedPaths: getLocallyModifiedPaths(),
      threadsError: threadSnapshot.threadsError,
      fontSize: editorUiSnapshot.fontSize,
    };
  }

  function flushExplorerStateChange() {
    workbenchBindings.onExplorerStateChange?.(getExplorerSnapshot());
  }

  function emitExplorerStateChange() {
    if (explorerStateChangeScheduled) {
      return;
    }

    explorerStateChangeScheduled = true;
    queueMicrotask(() => {
      explorerStateChangeScheduled = false;
      flushExplorerStateChange();
    });
  }

  function emitCurrentThreadChange() {
    workbenchBindings.onCurrentThreadChange?.(sessionState.currentThread);
  }

  function emitRateLimitsChange() {
    workbenchBindings.onRateLimitsChange?.(threadClient.getSnapshot().rateLimits);
  }

  function applyCurrentThread(thread: ThreadPayload | null) {
    if (areThreadPayloadsEquivalent(sessionState.currentThread, thread)) {
      return false;
    }

    sessionState.currentThread = thread;
    return true;
  }

  function applyCurrentThreadId(threadId: string) {
    if (sessionState.currentThreadId === threadId) {
      return false;
    }

    sessionState.currentThreadId = threadId;
    return true;
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

  function toggleDirectory(path: string) {
    projectClient.toggleDirectory(path);
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

  function inspectRichDocument() {
    const inspection = inspectSaveGuardMarkup({
      editorRoot: editor,
      isInlineRunContainer,
      normalizeMarkup: normalizeEditorMarkup,
    });
    return inspection;
  }

  function inspectEditorDraft() {
    if (!sessionState.currentPath) {
      return { content: "", issue: null };
    }

    if (fileSessionState.mode !== "rich") {
      return inspectDraftContent({
        mode: fileSessionState.mode,
        plainTextContent: editor.textContent ?? "",
      });
    }

    const saveGuardInspection = inspectRichDocument();
    syncSaveIssueLogging(saveGuardInspection.issue, "markup mismatch detected while editing");
    const inspection = inspectDraftContent({
      mode: fileSessionState.mode,
      plainTextContent: editor.textContent ?? "",
      richInspection: saveGuardInspection,
    });
    return inspection;
  }

  function syncSaveIssueLogging(issue: SaveGuardIssue | null, trigger: string, force = false) {
    if (!issue) {
      lastLoggedSaveIssue = null;
      return;
    }

    if (!force && isSameSaveGuardIssue(lastLoggedSaveIssue, issue)) {
      return;
    }

    logSaveGuardIssue(issue, sessionState.currentPath, trigger);
    lastLoggedSaveIssue = { ...issue };
  }

  function renderEditorDocument(content: string, mode: EditorMode) {
    editorDocument.renderDocument(content, mode);
  }

  async function refreshThreads() {
    await threadClient.refreshThreads();
  }

  async function refreshRateLimits() {
    await threadClient.refreshRateLimits();
  }

  function applyThreadPayloadToCurrentView(payload: ThreadPayload, statusMessage?: string) {
    applyCurrentThread(payload);
    applyCurrentThreadId(payload.id);
    fileClient.selectThread(payload.id);
    editorClient.showThreadPlaceholder(payload.name || payload.preview || payload.id);
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
    if (source === "open" && threadId === sessionState.currentThreadId) {
      return;
    }

    if (sessionState.currentPath) {
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

  function syncEditorAfterStructuralChange(mutate: () => void, hooks: EditOperationHooks = {}) {
    editorMutationRunner.runStructuralMutation(mutate, hooks);
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
      fileSessionState.mode !== "rich" ||
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
    fileClient.clearSelection();
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
    const shouldBlockOnThreads = Boolean(sessionState.currentThreadId || requestedThreadId);

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

    if (preserveSelection && sessionState.currentThreadId) {
      const currentThreadId = sessionState.currentThreadId;
      if (sessionState.currentThread?.isDraft && sessionState.currentThread.id === currentThreadId) {
        return;
      }

      if (threadClient.hasThread(currentThreadId)) {
        if (!threadClient.isCurrentThreadUpToDate(currentThreadId)) {
          await openThread(currentThreadId, { source: "reload" });
        }
        if (sessionState.currentThreadId === currentThreadId) {
          return;
        }
      } else {
        threadClient.clearThreadSelection();
        applyCurrentThread(null);
        applyCurrentThreadId("");
        syncCurrentSelectionToUrl({});
        emitExplorerStateChange();
      }
    }

    if (preserveSelection && sessionState.currentPath) {
      const currentPath = sessionState.currentPath;
      await refreshCurrentFileFromDiskIfSafe();
      if (sessionState.currentPath === currentPath) {
        return;
      }
    }

    if (requestedThreadId) {
      if (threadClient.hasThread(requestedThreadId)) {
        await openThread(requestedThreadId);
        if (sessionState.currentThreadId === requestedThreadId) {
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
      if (sessionState.currentPath === requestedPath) {
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
      if (sessionState.currentPath) {
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
  updateSaveButtonState();
  await refreshTree();
  void refreshRateLimits();
  scheduleAutoRefresh();
  return () => {
    autoRefreshStopped = true;
    unsubscribeSessionState();
    unsubscribeFileSessionState();
    unsubscribeEditorClient();
    unsubscribeFileOpened();
    unsubscribeSaveConflictCleared();
    unsubscribeSaveConflictSurfaced();
    editorClient.dispose();
    fileClient.dispose();
    unsubscribeProjectClient();
    unsubscribeThreadClient();
    projectClient.dispose();
    threadClient.dispose();
    if (autoRefreshTimeoutId !== null) {
      window.clearTimeout(autoRefreshTimeoutId);
    }
    abortController.abort();
  };
}
