/*
 * Exports:
 * - DraftBuffer/FileSessionState: file draft and editing state contracts.
 * - WorkbenchFileClientOptions: one observed document and its editor collaborators.
 * - WorkbenchFileClient: observed updates, draft persistence and guarded mutations.
 * - default WorkbenchFileClient: reconcile one file's disk facts with its local editable draft.
 */

import type { FilePayload } from "workbench-shared/types";
import type { FileDocumentSnapshot, WorkbenchFileDocument } from "./file/WorkbenchFileStore";
import {
    reconcileLiveMarkdownUpdate,
    type LiveMarkdownReconcileAction,
} from "./markdown/live-markdown-reconcile";
import {
    formatTimestamp,
    isMarkdownFile,
    isTextLikeFile,
} from "workbench-shared/workbench/project/tree-utils";
import {
    cloneEditHistory,
    createInitialEditHistory,
    normalizeEditHistory,
    type EditHistorySelection,
} from "./state/edit-history";
import type EditorDocumentAdapter from "./state/EditorDocumentAdapter";
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
export interface WorkbenchFileClientOptions {
  autoSave?: boolean;
  autoSaveDelayMs?: number;
  document: WorkbenchFileDocument;
  editorDocument: EditorDocumentAdapter;
  eventBus: WorkbenchEventBus;
  fileSessionState: FileSessionState;
  sessionState: SessionState;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
}

interface WorkbenchFileClient {
  dispose: () => void;
  inspectCurrentDraft: () => { content: string; issue: SaveGuardIssue | null };
  acceptObservation: (snapshot: FileDocumentSnapshot) => void;
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
    autoSaveDelayMs = FILE_AUTOSAVE_DELAY_MS,
    document,
    editorDocument,
    eventBus,
    fileSessionState: state,
    sessionState,
    updateHistorySelection,
  } = options;
  const draftStore = document.drafts;
  let mutating = false;
  let deferredObservation: FileDocumentSnapshot | null = null;

  async function clearDraftBuffer(filePath: string) {
    await draftStore.clearBuffer(filePath);
  }

  function clearDraftInBackground(filePath: string) {
    void clearDraftBuffer(filePath).catch(error => {
      if (!lifecycle.isDisposed) editorDocument.refreshStatusMessage(
        error instanceof Error ? error.message : "Unable to clear the saved draft.");
    });
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
    editorDocument.restoreSelection(state.history.selection ?? null);
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

  function syncCurrentDraftBuffer() {
    if (!sessionState.currentPath || state.expectedMtimeMs === null) {
      return;
    }

    const filePath = sessionState.currentPath;
    inspectCurrentDraft();

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
      clearDraftInBackground(filePath);
      scheduleAutoSave();
      return;
    }

    draftStore.setBuffer(filePath, nextBuffer);
    scheduleAutoSave();
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
    if (lifecycle.isDisposed || mutating || !options.autoSave || !sessionState.currentPath || !state.dirty || state.saveIssue || state.pendingWriteConflict) {
      return;
    }

    lifecycle.scheduleOnce(FILE_AUTOSAVE_TASK_ID, autoSaveDelayMs, () => {
      void saveCurrentFile().catch(() => {
        editorDocument.refreshStatusMessage("Autosave failed.");
      });
    });
  }

  async function resetCurrentDraftToSaved() {
    await reset(false);
  }

  async function resetCurrentFileToHead() {
    await reset(true);
  }

  function finishMutation() {
    mutating = false;
    const pending = deferredObservation;
    deferredObservation = null;
    if (pending && (!pending.data || state.expectedMtimeMs === null
      || pending.data.mtimeMs >= state.expectedMtimeMs)) acceptObservation(pending);
    scheduleAutoSave();
  }

  async function reset(toHead: boolean) {
    if (lifecycle.isDisposed || mutating || state.expectedMtimeMs === null) return;
    mutating = true;
    const before = editorDocument.readRenderedState(state.mode);
    lifecycle.cancel(FILE_SELECTION_PERSISTENCE_TASK_ID);
    try {
      if (toHead) {
        const result = await document.reset(state.expectedMtimeMs);
        if (lifecycle.isDisposed) return;
        if ("actualMtimeMs" in result) {
          state.pendingWriteConflict = result;
          eventBus.emit("saveConflictSurfaced", result);
          syncCurrentDraftBuffer();
          editorDocument.refreshStatusMessage();
          return;
        }
      }
      const payload = await document.read();
      if (lifecycle.isDisposed || editorDocument.readRenderedState(state.mode) !== before) return;
      applyFilePayloadToCurrentFile(payload, { statusMessage: `Reloaded - ${formatTimestamp(payload.updatedAt)}` });
      await clearDraftBuffer(document.path);
    } catch (error) {
      if (!lifecycle.isDisposed) editorDocument.refreshStatusMessage(error instanceof Error ? error.message : "Unable to reload file.");
    } finally {
      if (!lifecycle.isDisposed) syncCurrentDraftBuffer();
      finishMutation();
    }
  }

  async function saveCurrentFile({ force = false }: { force?: boolean } = {}) {
    if (lifecycle.isDisposed || mutating || !sessionState.currentPath) {
      return;
    }

    const inspection = inspectCurrentDraft();

    if (inspection.issue) {
      editorDocument.logBlockedSaveIssue(inspection.issue);
      editorDocument.refreshStatusMessage();
      return;
    }

    const expectedMtimeMs = state.expectedMtimeMs;
    const content = inspection.content;
    if (expectedMtimeMs === null) {
      editorDocument.refreshStatusMessage("The file must be reloaded before it can be saved.");
      return;
    }
    mutating = true;
    try {
      const payload = await document.save(content, expectedMtimeMs, force);
      if (lifecycle.isDisposed) return;
      if ("actualMtimeMs" in payload) {
        state.pendingWriteConflict = payload;
        eventBus.emit("saveConflictSurfaced", payload);
        syncCurrentDraftBuffer();
        editorDocument.refreshStatusMessage();
        return;
      }
      state.baselineContent = content;
      state.expectedMtimeMs = payload.mtimeMs;
      clearWriteConflict();
      inspectCurrentDraft();
      if (state.dirty || state.saveIssue) syncCurrentDraftBuffer();
      else await clearDraftBuffer(document.path);
      if (lifecycle.isDisposed) return;
      editorDocument.refreshStatusMessage(state.dirty ? undefined : `Saved ${formatTimestamp(payload.updatedAt)}`);
      editorDocument.scheduleDiffGutterRefresh();
    } catch (error) {
      if (!lifecycle.isDisposed) editorDocument.refreshStatusMessage(error instanceof Error ? error.message : "Unable to save file.");
    } finally {
      finishMutation();
    }
  }

  function acceptObservation(snapshot: FileDocumentSnapshot) {
    if (lifecycle.isDisposed) return;
    if (mutating) {
      deferredObservation = snapshot;
      return;
    }
    const payload = snapshot.data;
    if (!payload || payload.projectId !== document.location.projectId
      || payload.path !== document.path) return;
    if (snapshot.phase !== "current" && state.expectedMtimeMs !== null) return;
    if (state.expectedMtimeMs === null) {
      const draft = draftStore.getBuffer(document.path);
      if (draft) applyDraftBuffer(document.path, draft);
      else {
        applyFilePayloadToCurrentFile(payload);
        return;
      }
    }
    inspectCurrentDraft();
    state.headContent = payload.headContent;
    editorDocument.scheduleDiffGutterRefresh();
    if (state.dirty || state.saveIssue || state.pendingWriteConflict
      || payload.mtimeMs === state.expectedMtimeMs && payload.content === state.baselineContent) return;
    state.expectedMtimeMs = payload.mtimeMs;
    if (state.mode === "rich") {
      const result = applyIncomingMarkdownToCurrentFile(payload.content);
      if (!result.dirty) {
        clearDraftInBackground(payload.path);
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
  }

  function dispose() {
    if (lifecycle.isDisposed) return;
    syncCurrentDraftBuffer();
    lifecycle.dispose();
  }

  sessionState.currentPath = document.path;
  const restored = draftStore.getBuffer(document.path);
  if (restored) applyDraftBuffer(document.path, restored);
  else {
    editorDocument.renderDocument("", isMarkdownFile(document.path) ? "rich" : "plain");
    editorDocument.setEditable(false);
  }

  return {
    acceptObservation,
    dispose,
    inspectCurrentDraft,
    resetCurrentDraftToSaved,
    resetCurrentFileToHead,
    saveCurrentFile,
    scheduleSelectionPersistence,
    syncCurrentDraftBuffer,
  };
}

export default WorkbenchFileClient;
