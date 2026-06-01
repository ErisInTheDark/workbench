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
} from "./markdown/markdown-html-render";
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
import workbenchDraftStorage, {
    FILE_DRAFT_STORE_NAME,
} from "./storage/workbench-draft-storage";
import type { EditorMode, SaveGuardIssue } from "./WorkbenchEditorClient";
import type WorkbenchEventBus from "./WorkbenchEventBus";

export type { DraftBuffer, default as FileSessionState } from "./state/FileSessionState";

const DRAFT_DISCARD_TOMBSTONE_STORAGE_KEY = "workbench:file-draft-discard-tombstones:v1";
const DRAFT_DISCARD_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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

interface DraftDiscardTombstone {
  discardedAt: number;
  key: string;
  path: string;
  projectId: string;
}

type WorkbenchFileOpenSource = "open" | "reload";
type WorkbenchFileOpenOptions = {
  ignoreDirty?: boolean;
  source?: WorkbenchFileOpenSource;
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

function createDraftRecordKey(projectId: string, filePath: string) {
  return `${projectId}:${filePath}`;
}

function readDraftDiscardTombstones() {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return new Map<string, DraftDiscardTombstone>();
  }

  const records = new Map<string, DraftDiscardTombstone>();
  const now = Date.now();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFT_DISCARD_TOMBSTONE_STORAGE_KEY) ?? "[]") as DraftDiscardTombstone[];
    for (const record of parsed) {
      if (
        !record
        || typeof record.key !== "string"
        || typeof record.projectId !== "string"
        || typeof record.path !== "string"
        || !Number.isFinite(record.discardedAt)
      ) {
        continue;
      }

      if (now - record.discardedAt > DRAFT_DISCARD_TOMBSTONE_RETENTION_MS) {
        continue;
      }

      records.set(record.key, record);
    }
  } catch {
    return records;
  }

  return records;
}

function writeDraftDiscardTombstones(records: Map<string, DraftDiscardTombstone>) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(DRAFT_DISCARD_TOMBSTONE_STORAGE_KEY, JSON.stringify(Array.from(records.values())));
  } catch {
    // Draft tombstones are a best-effort guard around IndexedDB cleanup.
  }
}

function markDraftDiscardTombstone(projectId: string, filePath: string) {
  const records = readDraftDiscardTombstones();
  const key = createDraftRecordKey(projectId, filePath);
  records.set(key, {
    discardedAt: Date.now(),
    key,
    path: filePath,
    projectId,
  });
  writeDraftDiscardTombstones(records);
}

function clearDraftDiscardTombstone(projectId: string, filePath: string) {
  const records = readDraftDiscardTombstones();
  const key = createDraftRecordKey(projectId, filePath);
  if (!records.delete(key)) {
    return;
  }

  writeDraftDiscardTombstones(records);
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
    updateHistorySelection,
  } = options;

  let draftPersistenceQueue = Promise.resolve();
  const discardingDraftPaths = new Set<string>();

  async function getPersistedDraftRecords() {
    const projectId = getProjectId();
    const records = await workbenchDraftStorage.getAll<PersistedDraftRecord>(FILE_DRAFT_STORE_NAME);
    return records.filter((record) => record.projectId === projectId);
  }

  async function putPersistedDraftRecord(record: PersistedDraftRecord) {
    await workbenchDraftStorage.put(FILE_DRAFT_STORE_NAME, record);
  }

  async function deletePersistedDraftRecord(projectId: string, filePath: string) {
    await workbenchDraftStorage.delete(FILE_DRAFT_STORE_NAME, createDraftRecordKey(projectId, filePath));
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
    const projectId = getProjectId();
    return enqueueDraftPersistence(async () => {
      if (!buffer || !buffer.dirty) {
        markDraftDiscardTombstone(projectId, filePath);
        await deletePersistedDraftRecord(projectId, filePath);
        return;
      }

      clearDraftDiscardTombstone(projectId, filePath);
      await putPersistedDraftRecord(buildPersistedDraftRecord(projectId, filePath, buffer));
    });
  }

  async function clearDraftBuffer(filePath: string) {
    const previousModified = state.draftBuffers.get(filePath)?.dirty ?? false;
    const nextDraftBuffers = new Map(state.draftBuffers);
    nextDraftBuffers.delete(filePath);
    state.draftBuffers = nextDraftBuffers;
    await persistDraftBuffer(filePath, null);
    if (previousModified) {
      emitExplorerStateChange();
    }
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

    const filePath = sessionState.currentPath;
    if (discardingDraftPaths.has(filePath)) {
      return;
    }

    const previousModified = state.draftBuffers.get(filePath)?.dirty ?? false;
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
      return;
    }

    const nextDraftBuffers = new Map(state.draftBuffers);
    nextDraftBuffers.set(filePath, nextBuffer);
    state.draftBuffers = nextDraftBuffers;
    void persistDraftBuffer(filePath, nextBuffer);
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
    const tombstones = readDraftDiscardTombstones();
    const staleDiscardedRecords: PersistedDraftRecord[] = [];
    const draftEntries = records
      .filter((record) => {
        const isDiscarded = tombstones.has(createDraftRecordKey(record.projectId, record.path));
        if (isDiscarded) {
          staleDiscardedRecords.push(record);
        }

        return !isDiscarded;
      })
      .map((record) => {
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

        return [record.path, buffer] satisfies [string, DraftBuffer];
      });

    state.draftBuffers = new Map(draftEntries);

    for (const record of staleDiscardedRecords) {
      void persistDraftBuffer(record.path, null);
    }
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
        const bufferedDraft = state.draftBuffers.get(filePath);
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
    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: getProjectId(),
        path: filePath,
        resetToHead: true,
        expectedMtimeMs,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to reset file to HEAD." }));
      if (response.status === 409) {
        if (sessionState.currentPath === filePath) {
          state.pendingWriteConflict = error as SaveConflictPayload;
          eventBus.emit("saveConflictSurfaced", error as SaveConflictPayload);
          syncCurrentDraftBuffer();
          editorDocument.refreshStatusMessage();
        }
        return;
      }

      if (sessionState.currentPath === filePath) {
        editorDocument.refreshStatusMessage(error.error);
      }
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    await refreshProject();
    if (sessionState.currentPath === filePath) {
      await openFile(filePath, { ignoreDirty: true, source: "reload" });
      editorDocument.refreshStatusMessage(`Reset to HEAD - ${formatTimestamp(payload.updatedAt)}`);
      return;
    }

    await clearDraftBuffer(filePath);
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
    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: getProjectId(),
        path: filePath,
        content,
        expectedMtimeMs,
        force,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to save file." }));
      if (response.status === 409) {
        if (sessionState.currentPath === filePath) {
          state.pendingWriteConflict = error as SaveConflictPayload;
          eventBus.emit("saveConflictSurfaced", error as SaveConflictPayload);
          syncCurrentDraftBuffer();
          editorDocument.refreshStatusMessage();
        }
        return;
      }

      if (sessionState.currentPath === filePath) {
        editorDocument.refreshStatusMessage(error.error);
      }
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    await refreshProject();
    if (sessionState.currentPath === filePath) {
      state.baselineContent = content;
      state.expectedMtimeMs = payload.mtimeMs;
      clearWriteConflict();
      state.saveIssue = null;

      if (state.currentContent === content) {
        state.dirty = false;
        await clearDraftBuffer(filePath);
      } else {
        state.dirty = true;
        syncCurrentDraftBuffer();
      }
    } else {
      const bufferedDraft = state.draftBuffers.get(filePath);
      if (!bufferedDraft || bufferedDraft.content === content) {
        await clearDraftBuffer(filePath);
      }
    }

    eventBus.emit("saveCompleted", {
      path: filePath,
      updatedAt: payload.updatedAt,
    });
    if (sessionState.currentPath === filePath) {
      editorDocument.refreshStatusMessage(`Saved - ${formatTimestamp(payload.updatedAt)}`);
      editorDocument.scheduleDiffGutterRefresh();
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
