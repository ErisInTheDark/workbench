/*
 * Exports:
 * - WorkbenchFilePanelSnapshot: readonly mounted file panel state.
 * - WorkbenchFilePanelListener: subscriber for mounted file panel changes.
 * - WorkbenchFilePanelClientOptions: panel-controller collaborators.
 * - WorkbenchFilePanelClient: imperative mounted file panel API, including the toolbar, review mode, mark tags, comment
 *   margin, code block headers and the markdown source toggle.
 * - default WorkbenchFilePanelClient: own panel DOM, history, drafts, conflicts, editor commands and cleanup.
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
    placeCaretInElement,
    restoreListItemSelection,
    restoreParagraphSelection,
} from "./dom/selection/selection-dom";
import type { MarkTag } from "workbench-shared/workbench/settings/mark-tags";
import { matchEditorCommand, type EditorCommand } from "./editor/editor-commands";
import {
    getInlineRunContainer,
    isInlineRunContainer,
} from "./editor/inline-run-containers";
import type { WorkbenchCodeBlockController } from "./editor/WorkbenchCodeBlockController";
import type { WorkbenchCommentController } from "./editor/WorkbenchCommentController";
import type { TableStructureCommand, WorkbenchTableController } from "./editor/WorkbenchTableController";
import { isFormatCommand } from "./editor/WorkbenchFormatCommandController";
import type { ReviewMode, SuggestionLayout } from "./editor/WorkbenchSuggestionController";
import {
    formatTimestamp,
} from "workbench-shared/workbench/project/tree-utils";
import EditHistoryManager from "./state/EditHistoryManager";
import FileSessionState from "./state/FileSessionState";
import LifecycleScope from "./state/LifecycleScope";
import SessionState from "./state/SessionState";
import WorkbenchEditorClient, {
    type EditorToolbarState,
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
  /** The file on disk is not its git HEAD version, so it can be restored from git. */
  savedDiffersFromHead: boolean;
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
  /** Tag the selection, or the caret's tagged run or word, while suggesting in rich mode. */
  applyMarkTag: (name: string) => void;
  /** Keep the editor selection through a toolbar press; call on the press, before focus can move. */
  beginToolbarInteraction: (event: Event) => void;
  codeBlocks: WorkbenchCodeBlockController;
  comments: WorkbenchCommentController;
  tables: WorkbenchTableController;
  /** Discard the unsaved draft and reload the file from disk. */
  deleteDraft: () => Promise<void>;
  dispose: () => void;
  getSnapshot: () => WorkbenchFilePanelSnapshot;
  getToolbarState: () => EditorToolbarState;
  /** Write the file's git HEAD version to disk and reload it. */
  restoreFromGit: () => Promise<void>;
  runCommand: (command: EditorCommand) => void;
  save: () => Promise<void>;
  /** The name comments written in source mode are signed with. */
  setCommentAuthor: (author: string | null) => void;
  setFontSize: (fontSize: number, options?: { persist?: boolean }) => void;
  /** The tags Alt+digit applies in suggest mode, in keybind order. */
  setMarkTags: (tags: readonly MarkTag[]) => void;
  setReviewMode: (mode: ReviewMode) => void;
  setShowGitMarkers: (show: boolean) => void;
  setSuggestionLayout: (layout: SuggestionLayout) => void;
  previewFontSize: (fontSize: number | null) => void;
  subscribe: (listener: WorkbenchFilePanelListener) => () => void;
  subscribeToolbarState: (listener: () => void) => () => void;
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
  const dialogSurface = surfaces.dialogs;
  const toolbarSurface = surfaces.toolbars;
  const editor = editorSurface.editor;
  const saveConflictDialog = dialogSurface.saveConflict.dialog;
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
  let commentAuthor: string | null = null;
  const eventBus = WorkbenchEventBus();
  const sessionState = SessionState();
  const fileSessionState = FileSessionState();
  let fileClient: ReturnType<typeof WorkbenchFileClient>;
  const TABLE_STRUCTURE_COMMANDS = new Set<EditorCommand>(["row-above", "row-below", "column-left", "column-right", "delete-row", "delete-column"]);
  const isTableStructureCommand = (command: EditorCommand): command is TableStructureCommand => TABLE_STRUCTURE_COMMANDS.has(command);
  let editHistoryManager: ReturnType<typeof EditHistoryManager>;

  /** Rich mode edits the rendered document; source mode runs the same commands as markdown text edits. */
  function runCommand(command: EditorCommand) {
    if (command === "save") {
      if (sessionState.currentPath) void saveCurrentFile();
      return;
    }

    if (!editorClient.getToolbarState().editable) {
      return;
    }

    const source = fileSessionState.mode === "plain";
    if (command === "undo") {
      editHistoryManager.undoEditHistory();
    } else if (command === "redo") {
      editHistoryManager.redoEditHistory();
    } else if (command === "source") {
      fileClient.switchMode(source ? "rich" : "plain");
    } else if (isTableStructureCommand(command)) {
      if (!source) editorClient.tables.runCommand(command);
    } else if (command === "comment") {
      if (source) editorClient.applySourceCommand(command);
      else editorClient.startCommentDraft();
    } else if (isFormatCommand(command)) {
      if (source) editorClient.applySourceCommand(command);
      else editorClient.applyFormatCommand(command);
    }
  }

  function isDialogOpen(dialog: HTMLDivElement) {
    return !dialog.hidden;
  }

  function hideDialog(dialog: HTMLDivElement) {
    dialog.hidden = true;
  }

  function closeActiveDialog() {
    if (isDialogOpen(saveConflictDialog)) {
      hideDialog(saveConflictDialog);
      editor.focus();
      return true;
    }

    return false;
  }


  const editorClient = WorkbenchEditorClient({
    dialogs: dialogSurface,
    editor: editorSurface,
    statusDisplay,
    toolbars: toolbarSurface,
  }, {
    closeActiveDialog,
    controllerOptions: {
      inlineFormat: {
        getEditorHasFocus: () => editorHasFocus,
        getInlineRunContainer: (node) => getInlineRunContainer(editor, node),
        getIsComposing: () => isComposing,
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
    getCommentAuthor: () => commentAuthor,
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

      editorClient.runInputMutation(() => {
        ({ transformedListItem, transformedBlock } = editorClient.handleRichInput(event));
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
        },
      });
    },
    handleEditorKeyDown: (event) => {
      if (!sessionState.currentPath) {
        return;
      }

      if (fileSessionState.mode === "rich") {
        editorClient.maybeClearPendingInlineFormatsForKey(event);
        if (editorClient.handleListStructureKeyDown(event)) {
          return;
        }
      }

      const command = matchEditorCommand(event);
      if (command) {
        event.preventDefault();
        runCommand(command);
      }
    },
    handleEditorPointerDown: () => {
      editorClient.clearPendingInlineFormats();
    },
    handleOverwriteConflict: async () => {
      await saveCurrentFile({ force: true });
    },
    handlePointerMove: (event) => {
      if (event.target instanceof Node && editor.contains(event.target)) {
        editorClient.comments.syncHoverFromPointer(event.target);
      }
      const revisionNode = event.target instanceof Element ? event.target.closest<HTMLElement>("del, ins") : null;
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
    handleSaveCurrentFile: async () => {
      await saveCurrentFile();
    },
    handleSelectionChange: () => {
      editorClient.handlePendingInlineSelectionChange();

      editHistoryManager.updateHistorySelection(editorClient.getDocumentAdapter().captureSelection());
      scheduleSelectionPersistence();
      editorClient.scheduleEditorChromeRefresh();
    },
    handleViewportChanged: () => {
      editorClient.scheduleDiffGutterRefresh();
      editorClient.scheduleEditorChromeRefresh();
      editorClient.scheduleReviewRefresh();
    },
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
    runHistoryCommand: (command) => {
      if (command === "undo") editHistoryManager.undoEditHistory();
      else editHistoryManager.redoEditHistory();
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
    recordEditHistory: (previousContent, nextContent) => {
      editHistoryManager.recordEditHistory(previousContent, nextContent, editorClient.getDocumentAdapter().captureSelection());
    },
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
      savedDiffersFromHead: fileSessionState.headContent !== null
        && fileSessionState.baselineContent !== fileSessionState.headContent,
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
      || lastSnapshot.baselineContent !== snapshot.baselineContent
      || lastSnapshot.headContent !== snapshot.headContent
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
    editorClient.refreshStatusMessage(snapshot.failure ?? undefined);
    emit();
  }

  async function resetCurrentDraftToSaved() {
    await fileClient.resetCurrentDraftToSaved();
    if (lifecycle.isDisposed) return;
    emit();
  }

  async function resetCurrentFileToHead() {
    await fileClient.resetCurrentFileToHead();
    if (lifecycle.isDisposed) return;
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

  emit();

  return {
    acceptObservation,
    applyMarkTag: (name) => {
      editorClient.applyMarkTag(name);
    },
    beginToolbarInteraction: editorClient.beginToolbarInteraction,
    comments: editorClient.comments,
    deleteDraft: resetCurrentDraftToSaved,
    restoreFromGit: resetCurrentFileToHead,
    save: () => saveCurrentFile(),
    dispose: () => {
      fileClient.dispose();
      editorClient.dispose();
      listeners.clear();
      lifecycle.dispose();
    },
    getSnapshot,
    getToolbarState: editorClient.getToolbarState,
    codeBlocks: editorClient.codeBlocks,
    runCommand,
    tables: editorClient.tables,
    setCommentAuthor: (author) => {
      commentAuthor = author;
    },
    setFontSize,
    setMarkTags: editorClient.setMarkTags,
    setReviewMode: editorClient.setReviewMode,
    setShowGitMarkers: editorClient.setShowGitMarkers,
    setSuggestionLayout: editorClient.setSuggestionLayout,
    previewFontSize: editorClient.previewFontSize,
    subscribe,
    subscribeToolbarState: editorClient.subscribeToolbarState,
  };
}

export default WorkbenchFilePanelClient;
