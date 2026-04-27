/*
 * Exports:
 * - DraftBuffer: in-memory file draft state including persisted editor markup, conflicts, and save-guard metadata. Keywords: workbench, file, draft, buffer.
 * - WorkbenchFileLifecycleState: mutable file-selection and draft-persistence state shared with the main workbench coordinator. Keywords: workbench, file, state, lifecycle.
 * - WorkbenchFileClientOptions: callbacks and collaborators needed by the file client to coordinate editor, project, and thread behavior. Keywords: workbench, file, options, callbacks.
 * - WorkbenchFileClient: public surface for persisted draft hydration, file open/save/reset flows, and safe on-disk refreshes. Keywords: workbench, file, client, persistence.
 * - createWorkbenchFileClient: create the workbench file sub-client that owns IndexedDB draft persistence and file lifecycle operations. Keywords: workbench, file, IndexedDB, save, reset.
 */

import type { FilePayload, SaveConflictPayload, SaveFilePayload, ThreadPayload } from "../types";
import {
    cloneEditHistory,
    createInitialEditHistory,
    normalizeEditHistory,
    type EditHistorySelection,
    type EditHistoryState,
} from "./edit-history";
import {
    markdownToHtml as renderMarkdownToHtml,
} from "./markdown-render";
import {
    formatTimestamp,
    isMarkdownFile,
    isTextLikeFile,
} from "./tree-utils";
import type { EditorMode, SaveGuardIssue, WorkbenchEditorClient } from "./workbench-editor-client";
import type { WorkbenchProjectClient } from "./workbench-project-client";
import type { WorkbenchThreadClient } from "./workbench-thread-client";

const DRAFT_DATABASE_NAME = "potters-guide-workbench";
const DRAFT_DATABASE_VERSION = 1;
const DRAFT_STORE_NAME = "drafts";

export interface DraftBuffer {
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

export interface WorkbenchFileLifecycleState {
  baselineContent: string;
  currentContent: string;
  currentPath: string;
  currentThread: ThreadPayload | null;
  currentThreadId: string;
  dirty: boolean;
  draftBuffers: Map<string, DraftBuffer>;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history: EditHistoryState | null;
  lastLoggedSaveIssue: SaveGuardIssue | null;
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

type WorkbenchFileOpenSource = "open" | "reload";

export interface WorkbenchFileClientOptions {
  applyEditorFontSize: () => void;
  captureEditorSelection: () => EditHistorySelection | null;
  clearWriteConflict: () => void;
  editor: HTMLDivElement;
  editorClient: Pick<WorkbenchEditorClient,
    | "refreshStatusMessage"
    | "scheduleDiffGutterRefresh"
    | "setCurrentFilePath"
    | "setCurrentThreadId"
    | "setDirty"
    | "setMode"
    | "setPendingWriteConflict"
    | "setSaveIssue"
    | "setStatusMessage"
  >;
  emitExplorerStateChange: () => void;
  hideResetDraftDialog: () => void;
  inspectCurrentDraft: () => { content: string; issue: SaveGuardIssue | null };
  logBlockedSaveIssue: (issue: SaveGuardIssue) => void;
  projectClient: Pick<WorkbenchProjectClient, "expandPath" | "refreshProject">;
  refreshEditorChrome: () => void;
  refreshSaveGuardState: () => { markdown: string; issue: SaveGuardIssue | null };
  renderEditorDocument: (content: string, mode: EditorMode) => void;
  restoreEditorSelection: (selection: EditHistorySelection | null) => void;
  showWriteConflict: (conflict: SaveConflictPayload) => void;
  state: WorkbenchFileLifecycleState;
  syncSelectionToUrl: (selection: { filePath?: string }) => void;
  syncStructuredBlockStyles: () => void;
  threadClient: Pick<WorkbenchThreadClient, "clearThreadSelection">;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
  updateSaveButtonState: () => void;
}

export interface WorkbenchFileClient {
  dispose: () => void;
  hydratePersistedDrafts: () => Promise<void>;
  openFile: (
    filePath: string,
    options?: { ignoreDirty?: boolean; source?: WorkbenchFileOpenSource },
  ) => Promise<void>;
  refreshCurrentFileFromDiskIfSafe: () => Promise<void>;
  resetCurrentDraftToSaved: () => Promise<void>;
  resetCurrentFileToHead: () => Promise<void>;
  saveCurrentFile: (options?: { force?: boolean }) => Promise<void>;
  scheduleSelectionPersistence: () => void;
  syncCurrentDraftBuffer: () => void;
}

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

function hasBufferedDraftState(buffer: DraftBuffer) {
  return buffer.dirty || Boolean(buffer.saveIssue) || Boolean(buffer.pendingWriteConflict);
}

export function createWorkbenchFileClient(
  options: WorkbenchFileClientOptions,
): WorkbenchFileClient {
  const {
    applyEditorFontSize,
    captureEditorSelection,
    clearWriteConflict,
    editor,
    editorClient,
    emitExplorerStateChange,
    hideResetDraftDialog,
    inspectCurrentDraft,
    logBlockedSaveIssue,
    projectClient,
    refreshEditorChrome,
    refreshSaveGuardState,
    renderEditorDocument,
    restoreEditorSelection,
    showWriteConflict,
    state,
    syncSelectionToUrl,
    syncStructuredBlockStyles,
    threadClient,
    updateHistorySelection,
    updateSaveButtonState,
  } = options;

  const draftDatabasePromise = openDraftDatabase();
  let draftPersistenceQueue = Promise.resolve();
  let selectionPersistenceTimeoutId: number | null = null;

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

  function persistDraftBuffer(filePath: string, buffer: DraftBuffer | null) {
    return enqueueDraftPersistence(async () => {
      if (!buffer || !buffer.dirty) {
        await deletePersistedDraftRecord(filePath);
        return;
      }

      await putPersistedDraftRecord(buildPersistedDraftRecord(filePath, buffer));
    });
  }

  function applyDraftBuffer(filePath: string, buffer: DraftBuffer) {
    clearWriteConflict();
    threadClient.clearThreadSelection();
    state.currentThread = null;
    state.currentPath = filePath;
    state.currentThreadId = "";
    state.expectedMtimeMs = buffer.expectedMtimeMs;
    state.mode = buffer.mode;
    editorClient.setCurrentThreadId("");
    editorClient.setCurrentFilePath(filePath);
    editorClient.setMode(buffer.mode);

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
    editorClient.setDirty(buffer.dirty);
    editorClient.setPendingWriteConflict(state.pendingWriteConflict);
    editorClient.setSaveIssue(state.saveIssue);
    updateSaveButtonState();
    editorClient.refreshStatusMessage();
    editorClient.scheduleDiffGutterRefresh();
    restoreEditorSelection(state.history.frames[state.history.currentIndex]?.selection ?? null);
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
    threadClient.clearThreadSelection();
    state.currentThread = null;
    state.currentPath = payload.path;
    state.currentThreadId = "";
    state.expectedMtimeMs = payload.mtimeMs;
    state.headContent = payload.headContent;
    editorClient.setCurrentThreadId("");
    editorClient.setCurrentFilePath(payload.path);
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
    editorClient.setMode(mode);
    editorClient.setDirty(false);
    editorClient.setPendingWriteConflict(null);
    editorClient.setSaveIssue(null);

    if (selectionSnapshot) {
      restoreEditorSelection(selectionSnapshot);
      updateHistorySelection(captureEditorSelection());
    }

    editorClient.refreshStatusMessage(statusMessage);
    editorClient.scheduleDiffGutterRefresh();
    refreshEditorChrome();
  }

  async function fetchFilePayload(filePath: string) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to open file." }));
      editorClient.setStatusMessage(error.error);
      return null;
    }

    return await response.json() as FilePayload;
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
      editorState: state.mode === "rich"
        ? editor.innerHTML
        : editor.textContent ?? "",
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

  async function hydratePersistedDrafts() {
    const records = await getPersistedDraftRecords();
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

  async function openFile(
    filePath: string,
    { ignoreDirty: _ignoreDirty = false, source = "open" }: { ignoreDirty?: boolean; source?: WorkbenchFileOpenSource } = {},
  ) {
    void _ignoreDirty;

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
        applyDraftBuffer(filePath, bufferedDraft);
        syncSelectionToUrl({ filePath });
        editorClient.refreshStatusMessage("Opened draft");
        projectClient.expandPath(filePath);
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
    syncSelectionToUrl({ filePath: payload.path });
    projectClient.expandPath(payload.path);
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
        editorClient.refreshStatusMessage();
        return;
      }

      editorClient.setStatusMessage(error.error);
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    await projectClient.refreshProject();
    await openFile(state.currentPath, { ignoreDirty: true, source: "reload" });
    editorClient.refreshStatusMessage(`Reset to HEAD - ${formatTimestamp(payload.updatedAt)}`);
    editor.focus();
  }

  async function saveCurrentFile({ force = false }: { force?: boolean } = {}) {
    if (!state.currentPath) {
      return;
    }

    const inspection = inspectCurrentDraft();

    if (inspection.issue) {
      logBlockedSaveIssue(inspection.issue);
      editorClient.refreshStatusMessage();
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
        editorClient.refreshStatusMessage();
        return;
      }

      editorClient.setStatusMessage(error.error);
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    state.baselineContent = content;
    state.currentContent = content;
    state.dirty = false;
    state.expectedMtimeMs = payload.mtimeMs;
    await projectClient.refreshProject();
    state.lastLoggedSaveIssue = null;
    clearWriteConflict();
    state.draftBuffers.delete(state.currentPath);
    void persistDraftBuffer(state.currentPath, null);
    state.saveIssue = null;
    updateSaveButtonState();
    editorClient.refreshStatusMessage(`Saved - ${formatTimestamp(payload.updatedAt)}`);
    emitExplorerStateChange();
    editorClient.scheduleDiffGutterRefresh();
  }

  async function refreshCurrentFileFromDiskIfSafe() {
    if (
      !state.currentPath
      || state.dirty
      || state.saveIssue
      || state.pendingWriteConflict
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
    syncSelectionToUrl({ filePath: payload.path });
    emitExplorerStateChange();
  }

  function dispose() {
    if (selectionPersistenceTimeoutId !== null) {
      window.clearTimeout(selectionPersistenceTimeoutId);
    }
  }

  return {
    dispose,
    hydratePersistedDrafts,
    openFile,
    refreshCurrentFileFromDiskIfSafe,
    resetCurrentDraftToSaved,
    resetCurrentFileToHead,
    saveCurrentFile,
    scheduleSelectionPersistence,
    syncCurrentDraftBuffer,
  };
}