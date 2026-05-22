/*
 * Exports:
 * - initWorkbench: wire the workbench DOM, polling, editor behavior, and explorer callbacks together. Keywords: workbench, editor, threads, polling.
 */

import type { UserInput } from "./codex/generated/app-server/v2/UserInput";
import { getCurrentTurn } from "./codex/thread-state";
import type {
    ExplorerSnapshot,
    WorkbenchPendingUserInputRequest,
    ThreadPayload,
    WorkbenchBindings,
    WorkbenchControls,
    WorkbenchHarness,
    WorkbenchRouteLoadResult,
    WorkbenchSendThreadMessageOptions,
} from "./types";
import {
    createProjectRoute,
    type WorkbenchRoute,
} from "./workbench/navigation/workbench-route";
import {
    createListItemDomEditor,
} from "./workbench/dom/mutation/list-item-dom-edit";
import {
    ensureParagraphHasEditableContent,
} from "./workbench/dom/mutation/rich-input-dom";
import {
    getDirectChildSummaryTextElement,
} from "./workbench/dom/mutation/structured-block-dom";
import {
    deleteTextImmediatelyBeforeSelection,
    getTextBeforeSelectionInElement,
} from "./workbench/dom/query/text-position-dom";
import {
    captureEditorSelection,
    placeCaretInElement,
    restoreParagraphSelection,
    restoreListItemSelection,
} from "./workbench/dom/selection/selection-dom";
import {
    getInlineRunContainer,
    isInlineRunContainer,
} from "./workbench/editor/inline-run-containers";
import {
    restoreCaretToMarker,
} from "./workbench/editor/WorkbenchInlineFormatController";
import {
    formatTimestamp
} from "./workbench/project/tree-utils";
import {
    readStoredHarness,
} from "./workbench/state/browser-state";
import EditHistoryManager from "./workbench/state/EditHistoryManager";
import FileSessionState from "./workbench/state/FileSessionState";
import LifecycleScope from "./workbench/state/LifecycleScope";
import SessionState from "./workbench/state/SessionState";
import {
    hasRequiredControlButtonsDomSurface,
    hasRequiredDialogDomSurface,
    hasRequiredEditorDomSurface,
    hasRequiredStatusDisplaySurface,
    hasRequiredToolbarDomSurface,
    type WorkbenchDomSurfaces,
} from "./workbench/workbench-dom";
import WorkbenchEditorClient, {
    type EditorUIStateSnapshot
} from "./workbench/WorkbenchEditorClient";
import WorkbenchEventBus from "./workbench/WorkbenchEventBus";
import WorkbenchFileClient from "./workbench/WorkbenchFileClient";
import WorkbenchProjectClient from "./workbench/WorkbenchProjectClient";
import WorkbenchThreadClient from "./workbench/WorkbenchThreadClient";
import { getTurnRenderSignature } from "./workbench/thread/thread-item-signature";

const AUTO_REFRESH_INTERVAL_MS = 1500;
const HISTORY_KEYFRAME_INTERVAL = 50;

export async function WorkbenchClient(
  bindings: WorkbenchBindings & { dom?: WorkbenchDomSurfaces | null } = {},
): Promise<() => void> {
  const { dom, ...workbenchBindings } = bindings;
  if (
    !hasRequiredEditorDomSurface(dom?.editor)
    || !hasRequiredStatusDisplaySurface(dom?.statusDisplay)
    || !hasRequiredControlButtonsDomSurface(dom?.controls)
    || !hasRequiredDialogDomSurface(dom?.dialogs)
    || !hasRequiredToolbarDomSurface(dom?.toolbars)
  ) {
    return () => {};
  }

  const editorSurface = dom.editor;
  const statusDisplay = dom.statusDisplay;
  const controlButtons = dom.controls;
  const dialogSurface = dom.dialogs;
  const toolbarSurface = dom.toolbars;
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

  const coordinatorLifecycle = new LifecycleScope();
  let editorHasFocus = false;
  let explorerStateChangeScheduled = false;
  let isComposing = false;
  let reportStatusMessage = (_message: string) => {};
  let activeRoute: WorkbenchRoute = createProjectRoute("");
  let activeRouteGeneration = 0;
  const eventBus = WorkbenchEventBus();
  const projectClient = WorkbenchProjectClient();
  const threadClient = WorkbenchThreadClient({
    onStatusMessage: (message) => {
      reportStatusMessage(message);
    },
    onThreadStarted: (thread) => {
      if (activeRoute.view !== "thread" || activeRoute.threadId !== thread.id) {
        return;
      }
      emitExplorerStateChange();
    },
  });
  const initialThreadSnapshot = threadClient.getSnapshot();
  const sessionState = SessionState({
    currentThread: initialThreadSnapshot.currentThread,
    currentThreadId: initialThreadSnapshot.currentThreadId,
  });
  const fileSessionState = FileSessionState();
  let fileClient: ReturnType<typeof WorkbenchFileClient>;
  let activeProjectId = projectClient.getSnapshot().currentProjectId;
  coordinatorLifecycle.addUnsubscribe(projectClient.subscribe((snapshot) => {
    const previousProjectId = activeProjectId;
    activeProjectId = snapshot.currentProjectId;
    threadClient.setProjectContext({
      projectId: snapshot.currentProjectId,
      root: snapshot.root,
      rootPath: snapshot.rootPath,
    });
    if (previousProjectId && previousProjectId !== snapshot.currentProjectId && fileClient) {
      fileClient.clearSelection();
      void fileClient.hydratePersistedDrafts();
    }
    emitExplorerStateChange();
  }));

  let previousThreadSnapshot = initialThreadSnapshot;
  coordinatorLifecycle.addUnsubscribe(threadClient.subscribe((snapshot) => {
    const lastSnapshot = previousThreadSnapshot;
    previousThreadSnapshot = snapshot;

    if (
      !areThreadPayloadsEquivalent(lastSnapshot.currentThread, snapshot.currentThread)
      || lastSnapshot.currentThreadId !== snapshot.currentThreadId
    ) {
      const nextThreadId = snapshot.currentThread?.id ?? snapshot.currentThreadId;
      if (activeRoute.view === "thread" && nextThreadId === activeRoute.threadId) {
        applyCurrentThreadSelection(snapshot.currentThread);
      }
    }

    if (lastSnapshot.rateLimits !== snapshot.rateLimits) {
      emitRateLimitsChange();
    }

    if (!arePendingUserInputRequestsEquivalent(
      lastSnapshot.pendingUserInputRequestsByThreadId,
      snapshot.pendingUserInputRequestsByThreadId,
    )) {
      emitPendingUserInputRequestsChange();
    }

    if (
      lastSnapshot.currentThreadId !== snapshot.currentThreadId
      || lastSnapshot.threads !== snapshot.threads
      || lastSnapshot.threadsError !== snapshot.threadsError
    ) {
      emitExplorerStateChange();
    }
  }));

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
  let editHistoryManager: ReturnType<typeof EditHistoryManager>;
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
    getProjectChangeSummary: (path) => projectClient.getSnapshot().changes[path] ?? null,
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
    isSaveButtonInvalid: () => Boolean(fileSessionState.saveIssue) || Array.from(fileSessionState.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
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
    shouldBlockBeforeUnload: () => Boolean(fileSessionState.saveIssue) || Array.from(fileSessionState.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue)),
  });
  let previousEditorUiSnapshot: EditorUIStateSnapshot = editorClient.getSnapshot();
  reportStatusMessage = (message) => {
    editorClient.refreshStatusMessage(message);
  };
  let previousSessionSnapshot = sessionState.getSnapshot();
  coordinatorLifecycle.addUnsubscribe(sessionState.subscribe((snapshot) => {
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
  }));
  let previousFileSessionSnapshot = fileSessionState.getSnapshot();
  coordinatorLifecycle.addUnsubscribe(fileSessionState.subscribe((snapshot) => {
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
  }));
  coordinatorLifecycle.addUnsubscribe(editorClient.subscribe((snapshot) => {
    const previousSnapshot = previousEditorUiSnapshot;
    previousEditorUiSnapshot = snapshot;

    if (previousSnapshot.fontSize !== snapshot.fontSize) {
      emitExplorerStateChange();
    }
  }));
  coordinatorLifecycle.addUnsubscribe(eventBus.subscribe("fileOpened", () => {
    editorClient.refreshEditorChrome();
  }));
  coordinatorLifecycle.addUnsubscribe(eventBus.subscribe("saveConflictCleared", () => {
    editorClient.hideSaveConflictDialog();
  }));
  coordinatorLifecycle.addUnsubscribe(eventBus.subscribe("saveConflictSurfaced", (conflict) => {
    editorClient.showSaveConflict({
      ...conflict,
      expectedUpdatedAt: formatTimestamp(conflict.expectedUpdatedAt),
      actualUpdatedAt: formatTimestamp(conflict.actualUpdatedAt),
    });
  }));

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
    clearThreadSelection: () => {
      threadClient.clearThreadSelection();
    },
    editorDocument: editorClient.getDocumentAdapter(),
    emitExplorerStateChange,
    eventBus,
    expandProjectPath: (filePath) => {
      projectClient.expandPath(filePath);
    },
    fileSessionState,
    getProjectId: () => projectClient.getSnapshot().currentProjectId,
    refreshProject: async () => {
      await projectClient.refreshProject();
    },
    sessionState,
    updateHistorySelection: editHistoryManager.updateHistorySelection,
  });

  function scheduleSelectionPersistence() {
    fileClient.scheduleSelectionPersistence();
  }

  async function openFile(
    filePath: string,
    options?: { ignoreDirty?: boolean; source?: "open" | "reload" },
  ) {
    const didOpen = await fileClient.openFile(filePath, options);
    return didOpen;
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
      currentProjectId: projectSnapshot.currentProjectId,
      projects: projectSnapshot.projects,
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

  function emitPendingUserInputRequestsChange() {
    workbenchBindings.onPendingUserInputRequestsChange?.(threadClient.getSnapshot().pendingUserInputRequestsByThreadId);
  }

  function applyCurrentThreadSelection(thread: ThreadPayload | null) {
    if (
      areThreadPayloadsEquivalent(sessionState.currentThread, thread)
      && sessionState.currentThreadId === (thread?.id ?? "")
    ) {
      return false;
    }

    return sessionState.setCurrentThreadSelection(thread);
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

  function arePendingUserInputRequestsEquivalent(
    left: Record<string, WorkbenchPendingUserInputRequest>,
    right: Record<string, WorkbenchPendingUserInputRequest>,
  ) {
    if (left === right) {
      return true;
    }

    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) {
      return false;
    }

    return leftEntries.every(([threadId, request]) => {
      const matchingRequest = right[threadId];
      return Boolean(matchingRequest) && JSON.stringify(request) === JSON.stringify(matchingRequest);
    });
  }

  function areTurnListsEquivalent(leftTurns: ThreadPayload["turns"], rightTurns: ThreadPayload["turns"]) {
    if (leftTurns.length !== rightTurns.length) {
      return false;
    }

    return leftTurns.every((leftTurn, index) => {
      const rightTurn = rightTurns[index];
      return !!rightTurn
        && leftTurn.id === rightTurn.id
        && leftTurn.status === rightTurn.status
        && leftTurn.itemsView === rightTurn.itemsView
        && getTurnRenderSignature(leftTurn) === getTurnRenderSignature(rightTurn);
    });
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
      && left.forkedFromId === right.forkedFromId
      && left.agentNickname === right.agentNickname
      && left.agentRole === right.agentRole
      && areTurnListsEquivalent(left.turns, right.turns)
      && areCurrentTurnsEquivalent(left, right);
  }

  function toggleDirectory(path: string) {
    projectClient.toggleDirectory(path);
  }

  async function refreshThreads() {
    await threadClient.refreshThreads();
  }

  async function refreshRateLimits() {
    await threadClient.refreshRateLimits();
  }

  function applyThreadPayloadToCurrentView(payload: ThreadPayload, statusMessage?: string) {
    applyCurrentThreadSelection(payload);
    fileClient.selectThread(payload.id);
    editorClient.showThreadPlaceholder(payload.name || payload.preview || payload.id);
    editorClient.clearPendingInlineFormats();
    editorClient.setHoveredRevisionNode(null);
    updateSaveButtonState();
    editorClient.refreshStatusMessage(statusMessage);
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshEditorChrome();
  }

  async function openThread(
    threadId: string,
    { harness, source = "open" }: { harness?: WorkbenchHarness; source?: "open" | "reload" } = {},
  ) {
    if (source === "open" && threadId === sessionState.currentThreadId) {
      return true;
    }

    if (sessionState.currentPath) {
      fileClient.syncCurrentDraftBuffer();
    }

    if (threadClient.isDraftThreadId(threadId)) {
      const draftThread = threadClient.createThread(harness ?? readStoredHarness(), threadId);
      applyThreadPayloadToCurrentView(draftThread);
      emitExplorerStateChange();
      return true;
    }

    await threadClient.openThread(threadId, { harness, source });
    const payload = threadClient.getSnapshot().currentThread;
    if (!payload) {
      return false;
    }

    applyThreadPayloadToCurrentView(payload, `Read thread ${new Date(payload.updatedAt * 1000).toLocaleString()}`);
    emitExplorerStateChange();
    return true;
  }

  async function readThread(threadId: string, harness?: WorkbenchHarness) {
    return await threadClient.readThread(threadId, harness);
  }

  function markThreadSeen(thread: ThreadPayload) {
    threadClient.markThreadSeen(thread);
  }

  async function sendThreadMessage(
    thread: ThreadPayload,
    input: UserInput[],
    options: WorkbenchSendThreadMessageOptions = {},
  ) {
    const payload = await threadClient.sendThreadMessage(thread, input, options);
    if (!payload) {
      return null;
    }

    if (options.selectThread === false && payload.id !== sessionState.currentThreadId) {
      emitExplorerStateChange();
      return payload;
    }

    applyThreadPayloadToCurrentView(payload, "Sent message.");
    emitExplorerStateChange();
    return payload;
  }

  async function stopThread(thread: ThreadPayload) {
    const payload = await threadClient.stopThread(thread);
    if (!payload) {
      return null;
    }

    if (payload.id === sessionState.currentThreadId) {
      applyThreadPayloadToCurrentView(payload, "Requested turn stop.");
    }

    emitExplorerStateChange();
    return payload;
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    const createdPath = await projectClient.createEntry(parentPath, name, type);

    editorClient.refreshStatusMessage(`Created ${createdPath}`);

    return createdPath;
  }

  function clearCurrentSelectionView() {
    fileClient.clearSelection();
    editorClient.setHoveredRevisionNode(null);
    editorClient.clearPendingInlineFormats();
    editorClient.clearSelectionView();
    updateSaveButtonState();
    editorClient.refreshStatusMessage();
    editorClient.scheduleDiffGutterRefresh();
    editorClient.refreshEditorChrome();
  }

  function isRouteGenerationActive(route: WorkbenchRoute, generation: number) {
    return activeRouteGeneration === generation
      && activeRoute.view === route.view
      && activeRoute.projectId === route.projectId
      && activeRoute.filePath === route.filePath
      && activeRoute.threadId === route.threadId;
  }

  function reapplyActiveRouteAfterStaleLoad(route: WorkbenchRoute, generation: number) {
    if (isRouteGenerationActive(route, generation)) {
      return;
    }

    void applyRoute(activeRoute);
  }

  async function ensureRouteProject(route: WorkbenchRoute) {
    const previousProjectId = projectClient.getSnapshot().currentProjectId;
    if (!route.projectId) {
      await projectClient.selectInitialProject();
    } else if (!await projectClient.selectProjectStrict(route.projectId)) {
      return `Project not found: ${route.projectId}`;
    }

    const nextProjectId = projectClient.getSnapshot().currentProjectId;
    if (nextProjectId && previousProjectId !== nextProjectId) {
      await fileClient.hydratePersistedDrafts();
    }

    return "";
  }

  async function applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    activeRoute = route;
    const routeGeneration = ++activeRouteGeneration;

    if (route.view === "invalid") {
      clearCurrentSelectionView();
      threadClient.clearThreadSelection();
      emitExplorerStateChange();
      return { error: route.error || "Invalid route.", ok: false };
    }

    const projectError = await ensureRouteProject(route);
    if (projectError) {
      clearCurrentSelectionView();
      threadClient.clearThreadSelection();
      emitExplorerStateChange();
      return { error: projectError, ok: false };
    }

    if (!isRouteGenerationActive(route, routeGeneration)) {
      return { ok: false };
    }

    if (route.view === "project") {
      if (sessionState.currentPath) {
        fileClient.syncCurrentDraftBuffer();
      }
      threadClient.clearThreadSelection();
      clearCurrentSelectionView();
      emitExplorerStateChange();
      return { ok: true };
    }

    if (route.view === "file") {
      threadClient.clearThreadSelection();
      const didOpen = await openFile(route.filePath);
      reapplyActiveRouteAfterStaleLoad(route, routeGeneration);
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return didOpen ? { ok: true } : { error: `File not found: ${route.filePath}`, ok: false };
    }

    if (route.view === "thread") {
      const didOpen = await openThread(route.threadId);
      reapplyActiveRouteAfterStaleLoad(route, routeGeneration);
      if (!isRouteGenerationActive(route, routeGeneration)) {
        return { ok: false };
      }
      return didOpen ? { ok: true } : { error: `Thread not found: ${route.threadId}`, ok: false };
    }

    return { error: "Unknown route.", ok: false };
  }

  async function refreshTree({ preserveSelection = false }: { preserveSelection?: boolean } = {}) {
    if (projectClient.getSnapshot().currentProjectId) {
      await projectClient.refreshProject();
    } else {
      await projectClient.selectInitialProject();
    }

    const shouldBlockOnThreads = Boolean(sessionState.currentThreadId || activeRoute.view === "thread");

    if (shouldBlockOnThreads) {
      await Promise.all([
        refreshThreads(),
        threadClient.refreshPendingUserInputRequests(),
      ]);
      emitExplorerStateChange();
    } else {
      emitExplorerStateChange();
      void (async () => {
        await Promise.all([
          refreshThreads(),
          threadClient.refreshPendingUserInputRequests(),
        ]);
        emitExplorerStateChange();
      })();
    }

    if (preserveSelection && activeRoute.view === "thread" && sessionState.currentThreadId === activeRoute.threadId) {
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
      } else if (sessionState.currentThread && !sessionState.currentThread.isDraft) {
        return;
      } else {
        threadClient.clearThreadSelection();
        applyCurrentThreadSelection(null);
        emitExplorerStateChange();
      }
    }

    if (preserveSelection && activeRoute.view === "file" && sessionState.currentPath === activeRoute.filePath) {
      const currentPath = sessionState.currentPath;
      await refreshCurrentFileFromDiskIfSafe();
      if (sessionState.currentPath === currentPath) {
        return;
      }
    }
  }

  function startAutoRefresh() {
    coordinatorLifecycle.scheduleRepeat("workbench-auto-refresh", AUTO_REFRESH_INTERVAL_MS, async () => {
      try {
        await refreshTree({ preserveSelection: true });
      } catch {
        // Keep polling even if a transient refresh request fails.
      }
    });
  }

  const controls: WorkbenchControls = {
    applyRoute,
    createThreadDraft: (harness) => {
      const draftThread = threadClient.createThread(harness);
      applyThreadPayloadToCurrentView(draftThread);
      emitExplorerStateChange();
      return draftThread;
    },
    createEntry,
    listModels: threadClient.listModels,
    markThreadSeen,
    readThread,
    sendThreadMessage,
    stopThread,
    submitPendingUserInputRequest: threadClient.submitPendingUserInputRequest,
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
  emitPendingUserInputRequestsChange();
  emitRateLimitsChange();
  updateSaveButtonState();
  await refreshTree();
  void refreshRateLimits();
  startAutoRefresh();
  return () => {
    editorClient.dispose();
    fileClient.dispose();
    projectClient.dispose();
    threadClient.dispose();
    coordinatorLifecycle.dispose();
  };
}
