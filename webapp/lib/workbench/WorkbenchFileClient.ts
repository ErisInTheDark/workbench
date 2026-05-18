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
    markdownToHtml as renderMarkdownToHtml,
} from "./markdown/markdown-render";
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
    type EditHistoryState,
} from "./state/edit-history";
import type EditorDocumentAdapter from "./state/EditorDocumentAdapter";
import type FileSessionState from "./state/FileSessionState";
import type { DraftBuffer } from "./state/FileSessionState";
import LifecycleScope from "./state/LifecycleScope";
import type SessionState from "./state/SessionState";
import type { EditorMode, SaveGuardIssue } from "./WorkbenchEditorClient";
import type WorkbenchEventBus from "./WorkbenchEventBus";

export type { DraftBuffer, default as FileSessionState } from "./state/FileSessionState";

const DRAFT_DATABASE_NAME = "workbench";
const DRAFT_DATABASE_VERSION = 4;
const DRAFT_STORE_NAME = "drafts";
const THREAD_COMPOSER_DRAFT_STORE_NAME = "threadComposerDrafts";
const THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME = "threadQuestionnaireDrafts";
const FILE_SELECTION_PERSISTENCE_TASK_ID = "file-selection-persistence";
const FILE_SELECTION_PERSISTENCE_DELAY_MS = 260;

interface PersistedDraftRecord {
  key: string;
  projectId: string;
  path: string;
  baselineContent: string;
  content: string;
  expectedMtimeMs: number | null;
  headContent: string | null;
  history?: EditHistoryState | null;
  mode: EditorMode;
}

type WorkbenchFileOpenSource = "open" | "reload";
type WorkbenchFileOpenOptions = {
  ignoreDirty?: boolean;
  source?: WorkbenchFileOpenSource;
  syncUrl?: boolean;
};

export interface WorkbenchFileClientOptions {
  clearThreadSelection: () => void;
  editorDocument: EditorDocumentAdapter;
  emitExplorerStateChange: () => void;
  eventBus: WorkbenchEventBus;
  expandProjectPath: (path: string) => void;
  fileSessionState: FileSessionState;
  getProjectId: () => string;
  refreshProject: () => Promise<void>;
  sessionState: SessionState;
  syncSelectionToUrl: (selection: { filePath?: string }) => void;
  updateHistorySelection: (selection: EditHistorySelection | null) => void;
}

interface WorkbenchFileClient {
  clearSelection: () => void;
  dispose: () => void;
  hydratePersistedDrafts: () => Promise<void>;
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

    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion > 0 && event.oldVersion < 2 && database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.deleteObjectStore(DRAFT_STORE_NAME);
      }

      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME, { keyPath: "key" });
      }

      if (!database.objectStoreNames.contains(THREAD_COMPOSER_DRAFT_STORE_NAME)) {
        database.createObjectStore(THREAD_COMPOSER_DRAFT_STORE_NAME, { keyPath: "key" });
      }

      if (!database.objectStoreNames.contains(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME)) {
        database.createObjectStore(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
      };
      resolve(database);
    };

    request.onerror = () => {
      resolve(null);
    };

    request.onblocked = () => {
      resolve(null);
    };
  });
}

function createDraftRecordKey(projectId: string, filePath: string) {
  return `${projectId}:${filePath}`;
}

function buildPersistedDraftRecord(projectId: string, filePath: string, buffer: DraftBuffer): PersistedDraftRecord {
  return {
    key: createDraftRecordKey(projectId, filePath),
    projectId,
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

function WorkbenchFileClient(
  options: WorkbenchFileClientOptions,
  lifecycle: LifecycleScope = new LifecycleScope(),
): WorkbenchFileClient {
  const {
    clearThreadSelection,
    editorDocument,
    emitExplorerStateChange,
    eventBus,
    expandProjectPath,
    fileSessionState: state,
    getProjectId,
    refreshProject,
    sessionState,
    syncSelectionToUrl,
    updateHistorySelection,
  } = options;

  const draftDatabasePromise = openDraftDatabase();
  let draftPersistenceQueue = Promise.resolve();

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
    const projectId = getProjectId();
    return result.filter((record) => record.projectId === projectId);
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

  async function deletePersistedDraftRecord(projectId: string, filePath: string) {
    const database = await draftDatabasePromise;
    if (!database) {
      return;
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.delete(createDraftRecordKey(projectId, filePath)));
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
      const projectId = getProjectId();
      if (!buffer || !buffer.dirty) {
        await deletePersistedDraftRecord(projectId, filePath);
        return;
      }

      await putPersistedDraftRecord(buildPersistedDraftRecord(projectId, filePath, buffer));
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
    const response = await fetch(`/api/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`, { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to open file." }));
      editorDocument.refreshStatusMessage(error.error);
      return null;
    }

    return await response.json() as FilePayload;
  }

  function syncCurrentDraftBuffer() {
    if (!sessionState.currentPath) {
      return;
    }

    const previousModified = state.draftBuffers.get(sessionState.currentPath)?.dirty ?? false;
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
      const nextDraftBuffers = new Map(state.draftBuffers);
      nextDraftBuffers.delete(sessionState.currentPath);
      state.draftBuffers = nextDraftBuffers;
      void persistDraftBuffer(sessionState.currentPath, null);
      if (previousModified) {
        emitExplorerStateChange();
      }
      return;
    }

    const nextDraftBuffers = new Map(state.draftBuffers);
    nextDraftBuffers.set(sessionState.currentPath, nextBuffer);
    state.draftBuffers = nextDraftBuffers;
    void persistDraftBuffer(sessionState.currentPath, nextBuffer);
    if (previousModified !== nextBuffer.dirty) {
      emitExplorerStateChange();
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
    { ignoreDirty: _ignoreDirty = false, source = "open", syncUrl = true }: WorkbenchFileOpenOptions = {},
  ) {
    void _ignoreDirty;

    if (!isWorkbenchOpenableFile(filePath)) {
      editorDocument.refreshStatusMessage("Only markdown files can be opened in the workbench.");
      return false;
    }

    if (source === "open" && filePath === sessionState.currentPath) {
      return true;
    }

    if (sessionState.currentPath) {
      syncCurrentDraftBuffer();
    }

    if (source !== "reload") {
      const bufferedDraft = state.draftBuffers.get(filePath);
      if (bufferedDraft) {
        applyDraftBuffer(filePath, bufferedDraft);
        if (syncUrl) {
          syncSelectionToUrl({ filePath });
        }
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
      const nextDraftBuffers = new Map(state.draftBuffers);
      nextDraftBuffers.delete(filePath);
      state.draftBuffers = nextDraftBuffers;
      void persistDraftBuffer(filePath, null);
    }

    applyFilePayloadToCurrentFile(payload, {
      statusMessage: `${source === "reload" ? "Reloaded" : "Read"} ${formatTimestamp(payload.updatedAt)}`,
    });
    if (syncUrl) {
      syncSelectionToUrl({ filePath: payload.path });
    }
    expandProjectPath(payload.path);
    emitExplorerStateChange();
    return true;
  }

  async function resetCurrentDraftToSaved() {
    if (!sessionState.currentPath) {
      return;
    }

    await openFile(sessionState.currentPath, { ignoreDirty: true, source: "reload", syncUrl: false });
  }

  async function resetCurrentFileToHead() {
    if (!sessionState.currentPath) {
      return;
    }

    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: getProjectId(),
        path: sessionState.currentPath,
        resetToHead: true,
        expectedMtimeMs: state.expectedMtimeMs,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to reset file to HEAD." }));
      if (response.status === 409) {
        state.pendingWriteConflict = error as SaveConflictPayload;
        eventBus.emit("saveConflictSurfaced", error as SaveConflictPayload);
        syncCurrentDraftBuffer();
        editorDocument.refreshStatusMessage();
        return;
      }

      editorDocument.refreshStatusMessage(error.error);
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    await refreshProject();
    await openFile(sessionState.currentPath, { ignoreDirty: true, source: "reload", syncUrl: false });
    editorDocument.refreshStatusMessage(`Reset to HEAD - ${formatTimestamp(payload.updatedAt)}`);
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

    const content = inspection.content;
    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: getProjectId(),
        path: sessionState.currentPath,
        content,
        expectedMtimeMs: state.expectedMtimeMs,
        force,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to save file." }));
      if (response.status === 409) {
        state.pendingWriteConflict = error as SaveConflictPayload;
        eventBus.emit("saveConflictSurfaced", error as SaveConflictPayload);
        syncCurrentDraftBuffer();
        editorDocument.refreshStatusMessage();
        return;
      }

      editorDocument.refreshStatusMessage(error.error);
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    state.baselineContent = content;
    state.currentContent = content;
    state.dirty = false;
    state.expectedMtimeMs = payload.mtimeMs;
    await refreshProject();
    clearWriteConflict();
    const nextDraftBuffers = new Map(state.draftBuffers);
    nextDraftBuffers.delete(sessionState.currentPath);
    state.draftBuffers = nextDraftBuffers;
    void persistDraftBuffer(sessionState.currentPath, null);
    state.saveIssue = null;
    eventBus.emit("saveCompleted", {
      path: sessionState.currentPath,
      updatedAt: payload.updatedAt,
    });
    editorDocument.refreshStatusMessage(`Saved - ${formatTimestamp(payload.updatedAt)}`);
    emitExplorerStateChange();
    editorDocument.scheduleDiffGutterRefresh();
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

    applyFilePayloadToCurrentFile(payload, {
      preserveSelection: true,
      statusMessage: `Updated from disk - ${formatTimestamp(payload.updatedAt)}`,
    });
    emitExplorerStateChange();
  }

  function dispose() {
    lifecycle.dispose();
  }

  return {
    clearSelection,
    dispose,
    hydratePersistedDrafts,
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
