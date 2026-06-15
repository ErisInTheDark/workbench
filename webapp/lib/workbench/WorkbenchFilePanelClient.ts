/*
 * Exports:
 * - WorkbenchFilePanelSnapshot: readonly projection of one mounted file panel state. Keywords: workbench, file, panel, snapshot.
 * - WorkbenchFilePanelListener: subscriber signature for mounted file panel changes. Keywords: workbench, file, panel, subscribe.
 * - WorkbenchFilePanelClientOptions: collaborators needed by one mounted file panel controller. Keywords: workbench, file, panel, options.
 * - WorkbenchFilePanelClient: public imperative API for one mounted file panel. Keywords: workbench, file, panel, API.
 * - default WorkbenchFilePanelClient: create a panel-scoped file editor owner with independent DOM, history, draft, conflict, and cleanup lifecycle. Keywords: workbench, file, panel, editor, lifecycle, default export.
 */

import type { ChangeSummary } from "../types";
import {
    createListItemDomEditor,
} from "./dom/mutation/list-item-dom-edit";
import {
    ensureParagraphHasEditableContent,
} from "./dom/mutation/rich-input-dom";
import {
    getDirectChildSummaryTextElement,
} from "./dom/mutation/structured-block-dom";
import {
    deleteTextImmediatelyBeforeSelection,
    getTextBeforeSelectionInElement,
} from "./dom/query/text-position-dom";
import {
    captureEditorSelection,
    placeCaretInElement,
    restoreListItemSelection,
    restoreParagraphSelection,
} from "./dom/selection/selection-dom";
import {
    getInlineRunContainer,
    isInlineRunContainer,
} from "./editor/inline-run-containers";
import {
    restoreCaretToMarker,
} from "./editor/WorkbenchInlineFormatController";
import {
    formatTimestamp,
} from "./project/tree-utils";
import EditHistoryManager from "./state/EditHistoryManager";
import type { FileDraftStore } from "./state/FileDraftStore";
import FileSessionState from "./state/FileSessionState";
import LifecycleScope from "./state/LifecycleScope";
import SessionState from "./state/SessionState";
import WorkbenchEditorClient, {
    type EditorUIStateSnapshot,
} from "./WorkbenchEditorClient";
import WorkbenchEventBus from "./WorkbenchEventBus";
import WorkbenchFileClient from "./WorkbenchFileClient";
import type { WorkbenchEditorDomSurfaces } from "./workbench-dom";

const HISTORY_KEYFRAME_INTERVAL = 50;

export interface WorkbenchFilePanelSnapshot {
  currentPath: string;
  currentThreadId: string;
  dirty: boolean;
  fontSize: number;
  hasPendingWriteConflict: boolean;
  hasSaveIssue: boolean;
}

export type WorkbenchFilePanelListener = (snapshot: WorkbenchFilePanelSnapshot) => void;

export interface WorkbenchFilePanelClientOptions {
  clearThreadSelection: () => void;
  draftStore: FileDraftStore;
  emitExplorerStateChange: () => void;
  expandProjectPath: (filePath: string) => void;
  getProjectChangeSummary: (path: string) => ChangeSummary | null | undefined;
  getProjectId: () => string;
  refreshProject: () => Promise<void>;
  surfaces: WorkbenchEditorDomSurfaces;
}

export interface WorkbenchFilePanelClient {
  clearSelectionView: () => void;
  dispose: () => void;
  getCurrentPath: () => string;
  getSnapshot: () => WorkbenchFilePanelSnapshot;
  openFile: (filePath: string, options?: { ignoreDirty?: boolean; source?: "open" | "reload" }) => Promise<boolean>;
  refreshCurrentFileFromDiskIfSafe: () => Promise<void>;
  saveCurrentFile: (options?: { force?: boolean }) => Promise<void>;
  setFontSize: (fontSize: number, options?: { persist?: boolean }) => void;
  setStatusMessage: (message?: string) => void;
  showThreadPlaceholder: (threadId: string, label: string, statusMessage?: string) => void;
  subscribe: (listener: WorkbenchFilePanelListener) => () => void;
  syncCurrentDraftBuffer: () => void;
}

function WorkbenchFilePanelClient(
  options: WorkbenchFilePanelClientOptions,
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchFilePanelClient {
  const {
    clearThreadSelection,
    draftStore,
    emitExplorerStateChange,
    expandProjectPath,
    getProjectChangeSummary,
    getProjectId,
    refreshProject,
    surfaces,
  } = options;
  const listeners = new Set<WorkbenchFilePanelListener>();
  const editorSurface = surfaces.editor;
  const statusDisplay = surfaces.statusDisplay;
  const controlButtons = surfaces.controls;
  const dialogSurface = surfaces.dialogs;
  const toolbarSurface = surfaces.toolbars;
  const editor = editorSurface.editor;
  const saveConflictDialog = dialogSurface.saveConflict.dialog;
  const resetDraftDialog = dialogSurface.resetDraft.dialog;
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

  let editorHasFocus = false;
  let isComposing = false;
  const eventBus = WorkbenchEventBus();
  const sessionState = SessionState();
  const fileSessionState = FileSessionState();
  let fileClient: ReturnType<typeof WorkbenchFileClient>;
  let editHistoryManager: ReturnType<typeof EditHistoryManager>;

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

  const editorClient = WorkbenchEditorClient({
    controls: controlButtons,
    dialogs: dialogSurface,
    editor: {
      customCaret: editorSurface.customCaret,
      diffGutter: editorSurface.diffGutter,
      editor,
    },
    statusDisplay,
    toolbars: toolbarSurface,
  }, {
    closeActiveDialog,
    controllerOptions: {
      inlineFormat: {
        deleteTextImmediatelyBeforeSelection,
        getEditorHasFocus: () => editorHasFocus,
        getInlineRunContainer: (node) => getInlineRunContainer(editor, node),
        getIsComposing: () => isComposing,
        getTextBeforeSelectionInElement,
        isInlineRunContainer: (element) => isInlineRunContainer(editor, element),
        syncCurrentDraftBuffer: () => {
          fileClient.syncCurrentDraftBuffer();
        },
        updateHistorySelection: (selection) => {
          editHistoryManager.updateHistorySelection(selection);
        },
      },
    },
    fileSessionState,
    getEditorHasFocus: () => editorHasFocus,
    getProjectChangeSummary,
    handleCompositionEnd: () => {
      isComposing = false;
    },
    handleCompositionStart: () => {
      isComposing = true;
      editorClient.clearPendingInlineFormats();
      editorClient.refreshEditorChrome();
    },
    handleEditorBeforeInput: (event) => {
      if (editorClient.handlePendingInlineBeforeInput(event)) {
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
      editorClient.clearPendingInlineFormats();
      editorClient.refreshEditorChrome();
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
      editorClient.refreshEditorChrome();
    },
    handleEditorInput: (event) => {
      let transformedListItem: HTMLLIElement | null = null;
      let transformedBlock: HTMLElement | null = null;
      let commentCaretMarker: HTMLElement | null = null;

      editorClient.runInputMutation(() => {
        const {
          transformedListItem: nextTransformedListItem,
          transformedBlock: nextTransformedBlock,
          commentCaretMarker: richInputCommentCaretMarker,
        } = editorClient.handleRichInput(event);
        transformedListItem = nextTransformedListItem;
        transformedBlock = nextTransformedBlock;
        commentCaretMarker = richInputCommentCaretMarker ?? editorClient.maybeActivateInlineCommentShortcut(event);
      }, {
        afterDomMutation: () => {
          if (transformedListItem) {
            restoreListItemSelection([transformedListItem], {
              collapsed: true,
              getListItemTextContainer,
            });
          }

          if (transformedBlock) {
            restoreParagraphSelection(transformedBlock);
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

      editorClient.maybeClearPendingInlineFormatsForKey(event);

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
      editorClient.clearPendingInlineFormats();
    },
    handleEditorToggle: (event) => {
      if (!(event.target instanceof HTMLDetailsElement)) {
        return;
      }

      editorClient.scheduleDiffGutterRefresh();
      editorClient.scheduleEditorChromeRefresh();
    },
    handleOverwriteConflict: async () => {
      await saveCurrentFile({ force: true });
    },
    handlePointerMove: (event) => {
      const revisionNode = event.target instanceof Element
        ? event.target.closest<HTMLElement>('del, ins, [data-inline-comment="true"], [data-block-comment="true"]')
        : null;
      if (revisionNode && editor.contains(revisionNode)) {
        editorClient.setHoveredRevisionNode(revisionNode);
        return;
      }

      if (!editorClient.isPointerNearRevisionHoverUi(event.clientX, event.clientY)) {
        editorClient.setHoveredRevisionNode(null);
      }
    },
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
    handleSaveCurrentFile: async () => {
      await saveCurrentFile();
    },
    handleSelectionChange: () => {
      editorClient.handlePendingInlineSelectionChange();

      editHistoryManager.updateHistorySelection(captureEditorSelection(editor));
      scheduleSelectionPersistence();
      editorClient.scheduleEditorChromeRefresh();
    },
    handleViewportChanged: () => {
      editorClient.scheduleDiffGutterRefresh();
      editorClient.scheduleEditorChromeRefresh();
    },
    isSaveButtonInvalid: () => Boolean(fileSessionState.saveIssue),
    listStructure: {
      getClosestListItem,
      getListItemTextContainer,
      getSelectedListItems,
      indentListItems,
      isSelectionAtListItemStart,
      isTopLevelListItem,
      outdentListItems,
      unwrapTopLevelListItemToParagraph,
    },
    mutationRuntime: {
      inspectCurrentDraft: () => {
        fileClient.inspectCurrentDraft();
      },
      recordEditHistory: (previousContent, nextContent, selection) => {
        editHistoryManager.recordEditHistory(previousContent, nextContent, selection);
      },
      syncCurrentDraftBuffer: () => {
        fileClient.syncCurrentDraftBuffer();
      },
      updateHistorySelection: (selection) => {
        editHistoryManager.updateHistorySelection(selection);
      },
    },
    sessionState,
    shouldBlockBeforeUnload: () => Boolean(fileSessionState.saveIssue) || draftStore.hasSaveIssue(),
  });

  editHistoryManager = EditHistoryManager({
    applyHistoryReplay: (request) => {
      editorClient.runHistoryReplay(request);
    },
    getCurrentContent: () => fileSessionState.currentContent,
    getHistory: () => fileSessionState.history,
    historyKeyframeInterval: HISTORY_KEYFRAME_INTERVAL,
    setHistory: (history) => {
      fileSessionState.history = history;
    },
  });

  fileClient = WorkbenchFileClient({
    clearThreadSelection,
    draftStore,
    editorDocument: editorClient.getDocumentAdapter(),
    emitExplorerStateChange,
    eventBus,
    expandProjectPath,
    fileSessionState,
    getProjectId,
    refreshProject,
    sessionState,
    updateHistorySelection: editHistoryManager.updateHistorySelection,
  });

  function getSnapshot(): WorkbenchFilePanelSnapshot {
    const editorUiSnapshot = editorClient.getSnapshot();
    return {
      currentPath: sessionState.currentPath,
      currentThreadId: sessionState.currentThreadId,
      dirty: fileSessionState.dirty,
      fontSize: editorUiSnapshot.fontSize,
      hasPendingWriteConflict: Boolean(fileSessionState.pendingWriteConflict),
      hasSaveIssue: Boolean(fileSessionState.saveIssue),
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function subscribe(listener: WorkbenchFilePanelListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  let previousSessionSnapshot = sessionState.getSnapshot();
  lifecycle.addUnsubscribe(sessionState.subscribe((snapshot) => {
    const lastSnapshot = previousSessionSnapshot;
    previousSessionSnapshot = snapshot;

    if (
      lastSnapshot.currentPath !== snapshot.currentPath
      || lastSnapshot.currentThreadId !== snapshot.currentThreadId
    ) {
      emit();
      emitExplorerStateChange();
    }
  }));

  let previousFileSessionSnapshot = fileSessionState.getSnapshot();
  lifecycle.addUnsubscribe(fileSessionState.subscribe((snapshot) => {
    const lastSnapshot = previousFileSessionSnapshot;
    previousFileSessionSnapshot = snapshot;

    if (
      lastSnapshot.dirty !== snapshot.dirty
      || lastSnapshot.mode !== snapshot.mode
      || Boolean(lastSnapshot.saveIssue) !== Boolean(snapshot.saveIssue)
      || Boolean(lastSnapshot.pendingWriteConflict) !== Boolean(snapshot.pendingWriteConflict)
    ) {
      emit();
      emitExplorerStateChange();
    }
  }));

  let previousEditorUiSnapshot: EditorUIStateSnapshot = editorClient.getSnapshot();
  lifecycle.addUnsubscribe(editorClient.subscribe((snapshot) => {
    const previousSnapshot = previousEditorUiSnapshot;
    previousEditorUiSnapshot = snapshot;

    if (previousSnapshot.fontSize !== snapshot.fontSize) {
      emit();
      emitExplorerStateChange();
    }
  }));

  lifecycle.addUnsubscribe(eventBus.subscribe("fileOpened", () => {
    editorClient.refreshEditorChrome();
    emit();
  }));
  lifecycle.addUnsubscribe(eventBus.subscribe("saveConflictCleared", () => {
    editorClient.hideSaveConflictDialog();
    emit();
  }));
  lifecycle.addUnsubscribe(eventBus.subscribe("saveConflictSurfaced", (conflict) => {
    editorClient.showSaveConflict({
      ...conflict,
      expectedUpdatedAt: formatTimestamp(conflict.expectedUpdatedAt),
      actualUpdatedAt: formatTimestamp(conflict.actualUpdatedAt),
    });
    emit();
  }));

  function scheduleSelectionPersistence() {
    fileClient.scheduleSelectionPersistence();
  }

  async function openFile(
    filePath: string,
    fileOptions?: { ignoreDirty?: boolean; source?: "open" | "reload" },
  ) {
    const didOpen = await fileClient.openFile(filePath, fileOptions);
    if (didOpen) {
      emit();
    }
    return didOpen;
  }

  async function resetCurrentDraftToSaved() {
    editorClient.hideResetDraftDialog();
    await fileClient.resetCurrentDraftToSaved();
    editor.focus();
    emit();
  }

  async function resetCurrentFileToHead() {
    editorClient.hideResetDraftDialog();
    await fileClient.resetCurrentFileToHead();
    editor.focus();
    emit();
  }

  async function saveCurrentFile(saveOptions?: { force?: boolean }) {
    await fileClient.saveCurrentFile(saveOptions);
    emit();
  }

  async function refreshCurrentFileFromDiskIfSafe() {
    await fileClient.refreshCurrentFileFromDiskIfSafe();
    emit();
  }

  function clearSelectionView() {
    fileClient.clearSelection();
    editorClient.setHoveredRevisionNode(null);
    editorClient.clearPendingInlineFormats();
    editorClient.clearSelectionView();
    editorClient.setSaveButtonState();
    editorClient.refreshStatusMessage();
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshEditorChrome();
    emit();
  }

  function showThreadPlaceholder(threadId: string, label: string, statusMessage?: string) {
    fileClient.selectThread(threadId);
    editorClient.showThreadPlaceholder(label);
    editorClient.clearPendingInlineFormats();
    editorClient.setHoveredRevisionNode(null);
    editorClient.setSaveButtonState();
    editorClient.refreshStatusMessage(statusMessage);
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshEditorChrome();
    emit();
  }

  function syncCurrentDraftBuffer() {
    fileClient.syncCurrentDraftBuffer();
  }

  function setFontSize(fontSize: number, setOptions?: { persist?: boolean }) {
    editorClient.setFontSize(fontSize, setOptions);
  }

  function setStatusMessage(message?: string) {
    editorClient.refreshStatusMessage(message);
  }

  function getCurrentPath() {
    return sessionState.currentPath;
  }

  editorClient.setSaveButtonState();
  emit();

  return {
    clearSelectionView,
    dispose: () => {
      editorClient.dispose();
      fileClient.dispose();
      listeners.clear();
      lifecycle.dispose();
    },
    getCurrentPath,
    getSnapshot,
    openFile,
    refreshCurrentFileFromDiskIfSafe,
    saveCurrentFile,
    setFontSize,
    setStatusMessage,
    showThreadPlaceholder,
    subscribe,
    syncCurrentDraftBuffer,
  };
}

export default WorkbenchFilePanelClient;
