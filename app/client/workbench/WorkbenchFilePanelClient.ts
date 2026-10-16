/*
 * Exports:
 * - WorkbenchFilePanelSnapshot: readonly mounted file panel state.
 * - WorkbenchFilePanelListener: subscriber for mounted file panel changes.
 * - WorkbenchFilePanelClientOptions: panel-controller collaborators.
 * - WorkbenchFilePanelClient: imperative mounted file panel API.
 * - default WorkbenchFilePanelClient: own panel DOM, history, drafts, conflicts and cleanup.
 */

import type { FileDocumentSnapshot, WorkbenchFileDocument } from "./file/WorkbenchFileStore";
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
} from "workbench-shared/workbench/project/tree-utils";
import EditHistoryManager from "./state/EditHistoryManager";
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
  dirty: boolean;
  fontSize: number;
  hasPendingWriteConflict: boolean;
  hasSaveIssue: boolean;
}

export type WorkbenchFilePanelListener = (snapshot: WorkbenchFilePanelSnapshot) => void;

export interface WorkbenchFilePanelClientOptions {
  autoSave?: boolean;
  autoSaveDelayMs?: number;
  document: WorkbenchFileDocument;
  surfaces: WorkbenchEditorDomSurfaces;
}

export interface WorkbenchFilePanelClient {
  acceptObservation: (snapshot: FileDocumentSnapshot) => void;
  dispose: () => void;
  getSnapshot: () => WorkbenchFilePanelSnapshot;
  setFontSize: (fontSize: number, options?: { persist?: boolean }) => void;
  previewFontSize: (fontSize: number | null) => void;
  subscribe: (listener: WorkbenchFilePanelListener) => () => void;
}

function WorkbenchFilePanelClient(
  options: WorkbenchFilePanelClientOptions,
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchFilePanelClient {
  const {
    autoSave = false,
    autoSaveDelayMs,
    document,
    surfaces,
  } = options;
  const draftStore = document.drafts;
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
    getProjectChangeSummary: () => document.getSnapshot().data?.changeSummary,
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

      await resetCurrentDraftToSaved();
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
      inspectCurrentDraft: () => { fileClient.inspectCurrentDraft(); },
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
    autoSave,
    autoSaveDelayMs,
    document,
    editorDocument: editorClient.getDocumentAdapter(),
    eventBus,
    fileSessionState,
    sessionState,
    updateHistorySelection: editHistoryManager.updateHistorySelection,
  });

  function getSnapshot(): WorkbenchFilePanelSnapshot {
    const editorUiSnapshot = editorClient.getSnapshot();
    return {
      currentPath: sessionState.currentPath,
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

    if (lastSnapshot.currentPath !== snapshot.currentPath) emit();
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
    }
  }));

  let previousEditorUiSnapshot: EditorUIStateSnapshot = editorClient.getSnapshot();
  lifecycle.addUnsubscribe(editorClient.subscribe((snapshot) => {
    const previousSnapshot = previousEditorUiSnapshot;
    previousEditorUiSnapshot = snapshot;

    if (previousSnapshot.fontSize !== snapshot.fontSize) {
      emit();
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

  function acceptObservation(snapshot: FileDocumentSnapshot) {
    fileClient.acceptObservation(snapshot);
    editorClient.setSaveButtonState();
    editorClient.refreshStatusMessage(snapshot.failure ?? undefined);
    emit();
  }

  async function resetCurrentDraftToSaved() {
    editorClient.hideResetDraftDialog();
    await fileClient.resetCurrentDraftToSaved();
    if (lifecycle.isDisposed) return;
    editor.focus();
    emit();
  }

  async function resetCurrentFileToHead() {
    editorClient.hideResetDraftDialog();
    await fileClient.resetCurrentFileToHead();
    if (lifecycle.isDisposed) return;
    editor.focus();
    emit();
  }

  async function saveCurrentFile(saveOptions?: { force?: boolean }) {
    await fileClient.saveCurrentFile(saveOptions);
    if (lifecycle.isDisposed) return;
    emit();
  }

  function setFontSize(fontSize: number, setOptions?: { persist?: boolean }) {
    editorClient.setFontSize(fontSize, setOptions);
  }

  editorClient.setSaveButtonState();
  emit();

  return {
    acceptObservation,
    dispose: () => {
      fileClient.dispose();
      editorClient.dispose();
      listeners.clear();
      lifecycle.dispose();
    },
    getSnapshot,
    setFontSize,
    previewFontSize: editorClient.previewFontSize,
    subscribe,
  };
}

export default WorkbenchFilePanelClient;
