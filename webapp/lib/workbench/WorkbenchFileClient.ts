/*
 * Exports:
 * - DraftBuffer: re-exported current file draft state including persisted editor markup, conflicts, and save-guard metadata. Keywords: workbench, file, draft, buffer.
 * - FileSessionState: re-exported owner for current file persistence and history state. Keywords: workbench, file, session, state.
 * - WorkbenchFileClientOptions: coordinator-owned collaborators needed by the file client for document rendering, file-state ownership, project refreshes, and coarse events. Keywords: workbench, file, options, coordinator.
 * - WorkbenchFileClient: public surface for persisted draft hydration, file open/save/reset flows, and safe on-disk refreshes. Keywords: workbench, file, client, persistence.
 * - default WorkbenchFileClient: create the workbench file sub-client that owns IndexedDB draft persistence and file lifecycle operations. Keywords: workbench, file, IndexedDB, save, reset, default export.
 */

import type { FilePayload, SaveConflictPayload, SaveFilePayload } from "../types";
import {
    reconcileLiveMarkdownUpdate,
    type LiveMarkdownReconcileAction,
} from "./markdown/live-markdown-reconcile";
import {
    formatTimestamp,
    isMarkdownFile,
    isWorkbenchOpenableFile,
    isTextLikeFile,
} from "./project/tree-utils";
import {
    cloneEditHistory,
    createInitialEditHistory,
    normalizeEditHistory,
    type EditHistorySelection,
} from "./state/edit-history";
import type EditorDocumentAdapter from "./state/EditorDocumentAdapter";
import type { FileDraftStore } from "./state/FileDraftStore";
import type FileSessionState from "./state/FileSessionState";
import type { DraftBuffer } from "./state/FileSessionState";
import LifecycleScope from "./state/LifecycleScope";
import type SessionState from "./state/SessionState";
import type { SaveGuardIssue } from "./WorkbenchEditorClient";
import type WorkbenchEventBus from "./WorkbenchEventBus";

export type { DraftBuffer, default as FileSessionState } from "./state/FileSessionState";

const FILE_SELECTION_PERSISTENCE_TASK_ID = "file-selection-persistence";
const FILE_SELECTION_PERSISTENCE_DELAY_MS = 260;
const FILE_AUTOSAVE_TASK_ID = "file-autosave";
const FILE_AUTOSAVE_DELAY_MS = 900;
const FILE_AUTO_REFRESH_TASK_ID = "file-auto-refresh";
const FILE_AUTO_REFRESH_DELAY_MS = 5000;

type WorkbenchFileOpenSource = "open" | "reload";
type WorkbenchFileOpenOptions = {
  ignoreDirty?: boolean;
  source?: WorkbenchFileOpenSource;
};

export interface WorkbenchFileClientOptions {
  autoRefreshCleanFileDelayMs?: number;
  autoRefreshCleanFile?: boolean;
  autoSave?: boolean;
  autoSaveDelayMs?: number;
  clearThreadSelection: () => void;
  draftStore: FileDraftStore;
  editorDocument: EditorDocumentAdapter;
  emitExplorerStateChange: () => void;
  eventBus: WorkbenchEventBus;
  expandProjectPath: (path: string) => void;
  fileTransport: {
    read(projectId: string, path: string): Promise<FilePayload>;
    reset(projectId: string, path: string, expectedMtimeMs: number, force?: boolean): Promise<SaveFilePayload | SaveConflictPayload>;
    save(projectId: string, path: string, content: string, expectedMtimeMs: number, force?: boolean): Promise<SaveFilePayload | SaveConflictPayload>;
  };
  fileSessionState: FileSessionState;
  getProjectId: () => string;
  refreshProjectOnSave?: boolean;
  refreshProject: () => Promise<void>;
  sessionState: SessionState;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
}

interface WorkbenchFileClient {
  clearSelection: () => void;
  dispose: () => void;
  inspectCurrentDraft: () => { content: string; issue: SaveGuardIssue | null };
  openFile: (
    filePath: string,
    options?: WorkbenchFileOpenOptions,
  ) => Promise<boolean>;
  selectThread: (threadId: string) => void;
  refreshCurrentFileFromDiskIfSafe: () => Promise<void>;
  resetCurrentDraftToSaved: () => Promise<void>;
  resetCurrentFileToHead: () => Promise<void>;
  saveCurrentFile: (options?: { force?: boolean }) => Promise<void>;
  scheduleSelectionPersistence: () => void;
  syncCurrentDraftBuffer: () => void;
}

function hasBufferedDraftState(buffer: DraftBuffer) {
  return buffer.dirty || Boolean(buffer.saveIssue) || Boolean(buffer.pendingWriteConflict);
}

type IncomingMarkdownApplyResult =
  { action: LiveMarkdownReconcileAction["type"]; currentContent: string; dirty: boolean };

function WorkbenchFileClient(
  options: WorkbenchFileClientOptions,
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchFileClient {
  const {
    autoRefreshCleanFileDelayMs = FILE_AUTO_REFRESH_DELAY_MS,
    autoSaveDelayMs = FILE_AUTOSAVE_DELAY_MS,
    clearThreadSelection,
    draftStore,
    editorDocument,
    emitExplorerStateChange,
    eventBus,
    expandProjectPath,
    fileTransport,
    fileSessionState: state,
    getProjectId,
    refreshProjectOnSave = true,
    refreshProject,
    sessionState,
    updateHistorySelection,
  } = options;

  const discardingDraftPaths = new Set<string>();

  async function clearDraftBuffer(filePath: string) {
    await draftStore.clearBuffer(filePath);
  }

  function beginDraftDiscard(filePath: string) {
    discardingDraftPaths.add(filePath);
    lifecycle.cancel(FILE_SELECTION_PERSISTENCE_TASK_ID);
  }

  function finishDraftDiscard(filePath: string) {
    discardingDraftPaths.delete(filePath);
  }

  function clearWriteConflict() {
    const conflictedPath = state.pendingWriteConflict?.path ?? sessionState.currentPath;
    if (!state.pendingWriteConflict) {
      return;
    }

    state.pendingWriteConflict = null;
    eventBus.emit("saveConflictCleared", {
      path: conflictedPath,
    });
  }

  function resetCurrentFileSessionState() {
    state.baselineContent = "";
    state.currentContent = "";
    state.dirty = false;
    state.expectedMtimeMs = null;
    state.headContent = null;
    state.history = null;
    state.saveIssue = null;
    clearWriteConflict();
  }

  function clearSelection() {
    sessionState.currentPath = "";
    resetCurrentFileSessionState();
  }

  function selectThread(threadId: string) {
    void threadId;
    sessionState.currentPath = "";
    resetCurrentFileSessionState();
  }

  function inspectCurrentDraft() {
    if (!sessionState.currentPath) {
      state.currentContent = "";
      state.dirty = false;
      state.expectedMtimeMs = null;
      state.saveIssue = null;
      return { content: "", issue: null };
    }

    const inspection = editorDocument.inspectDraft();
    state.currentContent = inspection.content;
    state.dirty = inspection.content !== state.baselineContent;
    state.saveIssue = inspection.issue;
    return inspection;
  }

  function applyDraftBuffer(filePath: string, buffer: DraftBuffer) {
    clearWriteConflict();
    clearThreadSelection();
    sessionState.currentThread = null;
    sessionState.currentPath = filePath;
    sessionState.currentThreadId = "";
    state.expectedMtimeMs = buffer.expectedMtimeMs;
    state.mode = buffer.mode;
    editorDocument.setEditable(isTextLikeFile(filePath));
    editorDocument.renderDocument(buffer.content, buffer.mode, {
      renderedState: buffer.editorState,
    });
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
    editorDocument.refreshStatusMessage();
    editorDocument.scheduleDiffGutterRefresh();
    editorDocument.restoreSelection(state.history.frames[state.history.currentIndex]?.selection ?? null);
    eventBus.emit("fileOpened", {
      path: filePath,
      source: "draft",
    });
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
    const selectionSnapshot = preserveSelection ? editorDocument.captureSelection() : null;

    clearWriteConflict();
    clearThreadSelection();
    sessionState.currentThread = null;
    sessionState.currentPath = payload.path;
    sessionState.currentThreadId = "";
    state.expectedMtimeMs = payload.mtimeMs;
    state.headContent = payload.headContent;
    state.mode = mode;
    editorDocument.setEditable(isTextLikeFile(payload.path));
    editorDocument.renderDocument(payload.content, mode);
    if (mode === "rich") {
      state.baselineContent = editorDocument.inspectRichDocument().markdown;
      state.currentContent = state.baselineContent;
    } else {
      state.baselineContent = payload.content;
      state.currentContent = payload.content;
      state.saveIssue = null;
    }
    state.dirty = false;
    state.history = createInitialEditHistory(state.currentContent);
    state.pendingWriteConflict = null;
    state.saveIssue = null;

    if (selectionSnapshot) {
      editorDocument.restoreSelection(selectionSnapshot);
      updateHistorySelection(editorDocument.captureSelection());
    }

    editorDocument.refreshStatusMessage(statusMessage);
    editorDocument.scheduleDiffGutterRefresh();
    eventBus.emit("fileOpened", {
      path: payload.path,
      source: "disk",
    });
  }

  async function fetchFilePayload(filePath: string) {
    const projectId = getProjectId();
    try {
      return await fileTransport.read(projectId, filePath);
    } catch (error) {
      editorDocument.refreshStatusMessage(error instanceof Error ? error.message : "Unable to open file.");
      return null;
    }
  }

  function syncCurrentDraftBuffer() {
    if (!sessionState.currentPath) {
      return;
    }

    const filePath = sessionState.currentPath;
    if (discardingDraftPaths.has(filePath)) {
      return;
    }

    const nextBuffer: DraftBuffer = {
      baselineContent: state.baselineContent,
      content: state.currentContent,
      dirty: state.dirty,
      editorState: editorDocument.readRenderedState(state.mode),
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
      void clearDraftBuffer(filePath);
      scheduleAutoSave();
      return;
    }

    draftStore.setBuffer(filePath, nextBuffer);
    scheduleAutoSave();
    emitExplorerStateChange();
  }

  function applyIncomingMarkdownToCurrentFile(incomingContent: string): IncomingMarkdownApplyResult {
    if (state.mode !== "rich") {
      editorDocument.renderDocument(incomingContent, state.mode);
      state.currentContent = incomingContent;
      state.baselineContent = incomingContent;
      state.dirty = false;
      return {
        action: "replaceDocument",
        currentContent: state.currentContent,
        dirty: state.dirty,
      };
    }

    const action = reconcileLiveMarkdownUpdate({
      baselineContent: state.baselineContent,
      currentContent: state.currentContent,
      incomingContent,
      isDirty: state.dirty,
      isFocused: editorDocument.isFocused(),
    });

    switch (action.type) {
      case "metadataOnly":
        state.baselineContent = action.baselineContent;
        state.dirty = state.currentContent !== state.baselineContent;
        return {
          action: action.type,
          currentContent: state.currentContent,
          dirty: state.dirty,
        };
      case "keepLocal":
        state.dirty = state.currentContent !== state.baselineContent;
        return {
          action: action.type,
          currentContent: state.currentContent,
          dirty: state.dirty,
        };
      case "appendRemoteTail": {
        editorDocument.appendMarkdownFragment(action.tailMarkdown);
        const inspection = editorDocument.inspectRichDocument();
        state.currentContent = inspection.markdown;
        state.saveIssue = inspection.issue;
        state.baselineContent = action.nextBaselineContent;
        state.dirty = state.currentContent !== state.baselineContent;
        return {
          action: action.type,
          currentContent: state.currentContent,
          dirty: state.dirty,
        };
      }
      case "replaceDocument":
        editorDocument.renderDocument(action.nextContent, state.mode);
        state.currentContent = editorDocument.inspectRichDocument().markdown;
        state.baselineContent = action.nextContent;
        state.dirty = state.currentContent !== state.baselineContent;
        return {
          action: action.type,
          currentContent: state.currentContent,
          dirty: state.dirty,
        };
    }
  }

  function scheduleSelectionPersistence() {
    if (!sessionState.currentPath || !state.dirty) {
      return;
    }

    // Draft persistence debounce is owned by the file client so cleanup follows file-client disposal.
    lifecycle.scheduleOnce(FILE_SELECTION_PERSISTENCE_TASK_ID, FILE_SELECTION_PERSISTENCE_DELAY_MS, () => {
      syncCurrentDraftBuffer();
    });
  }

  function scheduleAutoSave() {
    if (!options.autoSave || !sessionState.currentPath || !state.dirty || state.saveIssue || state.pendingWriteConflict) {
      return;
    }

    lifecycle.scheduleOnce(FILE_AUTOSAVE_TASK_ID, autoSaveDelayMs, () => {
      void saveCurrentFile().catch(() => {
        editorDocument.refreshStatusMessage("Autosave failed.");
      });
    });
  }

  if (options.autoRefreshCleanFile) {
    lifecycle.scheduleRepeat(FILE_AUTO_REFRESH_TASK_ID, autoRefreshCleanFileDelayMs, async () => {
      await refreshCurrentFileFromDiskIfSafe();
    });
  }

  async function openFile(
    filePath: string,
    { ignoreDirty: _ignoreDirty = false, source = "open" }: WorkbenchFileOpenOptions = {},
  ) {
    void _ignoreDirty;

    if (!isWorkbenchOpenableFile(filePath)) {
      editorDocument.refreshStatusMessage("Only markdown files can be opened in the workbench.");
      return false;
    }

    if (source === "open" && filePath === sessionState.currentPath) {
      return true;
    }

    const isReloadingCurrentFile = source === "reload" && filePath === sessionState.currentPath;
    if (source === "reload") {
      beginDraftDiscard(filePath);
    }

    if (sessionState.currentPath && !isReloadingCurrentFile) {
      syncCurrentDraftBuffer();
    }

    try {
      if (source !== "reload") {
        const bufferedDraft = draftStore.getBuffer(filePath);
        if (bufferedDraft) {
          applyDraftBuffer(filePath, bufferedDraft);
          editorDocument.refreshStatusMessage("Opened draft");
          expandProjectPath(filePath);
          emitExplorerStateChange();
          return true;
        }
      }

      const payload = await fetchFilePayload(filePath);
      if (!payload) {
        return false;
      }

      if (source === "reload") {
        await clearDraftBuffer(filePath);
      }

      applyFilePayloadToCurrentFile(payload, {
        statusMessage: `${source === "reload" ? "Reloaded" : "Read"} ${formatTimestamp(payload.updatedAt)}`,
      });
      expandProjectPath(payload.path);
      emitExplorerStateChange();
      return true;
    } finally {
      if (source === "reload") {
        finishDraftDiscard(filePath);
      }
    }
  }

  async function resetCurrentDraftToSaved() {
    if (!sessionState.currentPath) {
      return;
    }

    await openFile(sessionState.currentPath, { ignoreDirty: true, source: "reload" });
  }

  async function resetCurrentFileToHead() {
    if (!sessionState.currentPath) {
      return;
    }

    const filePath = sessionState.currentPath;
    const expectedMtimeMs = state.expectedMtimeMs;
    if (expectedMtimeMs === null) {
      editorDocument.refreshStatusMessage("The file must be reloaded before it can be reset.");
      return;
    }
    try {
      const payload = await fileTransport.reset(getProjectId(), filePath, expectedMtimeMs);
      if ("actualMtimeMs" in payload) {
        if (sessionState.currentPath === filePath) {
          state.pendingWriteConflict = payload;
          eventBus.emit("saveConflictSurfaced", payload);
          syncCurrentDraftBuffer();
          editorDocument.refreshStatusMessage();
        }
        return;
      }
      if (refreshProjectOnSave) await refreshProject();
      if (sessionState.currentPath === filePath) {
        await openFile(filePath, { ignoreDirty: true, source: "reload" });
        editorDocument.refreshStatusMessage(`Reset to HEAD - ${formatTimestamp(payload.updatedAt)}`);
      } else {
        await clearDraftBuffer(filePath);
      }
    } catch (error) {
      if (sessionState.currentPath === filePath) editorDocument.refreshStatusMessage(error instanceof Error ? error.message : "Unable to reset file to HEAD.");
    }
  }

  async function saveCurrentFile({ force = false }: { force?: boolean } = {}) {
    if (!sessionState.currentPath) {
      return;
    }

    const inspection = inspectCurrentDraft();

    if (inspection.issue) {
      editorDocument.logBlockedSaveIssue(inspection.issue);
      editorDocument.refreshStatusMessage();
      return;
    }

    const filePath = sessionState.currentPath;
    const expectedMtimeMs = state.expectedMtimeMs;
    const content = inspection.content;
    if (expectedMtimeMs === null) {
      editorDocument.refreshStatusMessage("The file must be reloaded before it can be saved.");
      return;
    }
    let payload: SaveFilePayload | SaveConflictPayload;
    try {
      payload = await fileTransport.save(getProjectId(), filePath, content, expectedMtimeMs, force);
    } catch (error) {
      if (sessionState.currentPath === filePath) editorDocument.refreshStatusMessage(error instanceof Error ? error.message : "Unable to save file.");
      return;
    }
    if ("actualMtimeMs" in payload) {
      if (sessionState.currentPath === filePath) {
        state.pendingWriteConflict = payload;
        eventBus.emit("saveConflictSurfaced", payload);
        syncCurrentDraftBuffer();
        editorDocument.refreshStatusMessage();
      }
      return;
    }
    if (refreshProjectOnSave) await refreshProject();
    if (sessionState.currentPath === filePath) {
      state.currentContent = content;
      state.baselineContent = content;
      state.dirty = false;
      state.expectedMtimeMs = payload.mtimeMs;
      clearWriteConflict();
      state.saveIssue = null;
      await clearDraftBuffer(filePath);
      editorDocument.refreshStatusMessage(`Saved ${formatTimestamp(payload.updatedAt)}`);
      editorDocument.scheduleDiffGutterRefresh();
    } else {
      await clearDraftBuffer(filePath);
    }
    emitExplorerStateChange();
  }

  async function refreshCurrentFileFromDiskIfSafe() {
    if (
      !sessionState.currentPath
      || state.dirty
      || state.saveIssue
      || state.pendingWriteConflict
    ) {
      return;
    }

    const payload = await fetchFilePayload(sessionState.currentPath);
    if (!payload || payload.mtimeMs === state.expectedMtimeMs) {
      return;
    }

    if (state.mode === "rich" && sessionState.currentPath === payload.path) {
      state.expectedMtimeMs = payload.mtimeMs;
      state.headContent = payload.headContent;
      const result = applyIncomingMarkdownToCurrentFile(payload.content);
      if (!result.dirty) {
        await clearDraftBuffer(payload.path);
      } else {
        syncCurrentDraftBuffer();
      }
      editorDocument.refreshStatusMessage(`Updated from disk - ${formatTimestamp(payload.updatedAt)}`);
      editorDocument.scheduleDiffGutterRefresh();
    } else {
      applyFilePayloadToCurrentFile(payload, {
        preserveSelection: true,
        statusMessage: `Updated from disk - ${formatTimestamp(payload.updatedAt)}`,
      });
    }
    emitExplorerStateChange();
  }

  function dispose() {
    lifecycle.dispose();
  }

  return {
    clearSelection,
    dispose,
    inspectCurrentDraft,
    openFile,
    selectThread,
    refreshCurrentFileFromDiskIfSafe,
    resetCurrentDraftToSaved,
    resetCurrentFileToHead,
    saveCurrentFile,
    scheduleSelectionPersistence,
    syncCurrentDraftBuffer,
  };
}

export default WorkbenchFileClient;
