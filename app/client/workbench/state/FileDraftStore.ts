/*
 * Exports:
 * - FileDraftStoreSnapshot: readonly projection of shared draft buffers keyed by file path.
 * - FileDraftStoreListener: subscriber signature for shared draft-store updates.
 * - default FileDraftStore: create the shared project-scoped draft buffer persistence owner, including unsaved new files;
 *   queued writes for a path coalesce to its latest buffer.
 */

import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";

import {
    markdownToHtml as renderMarkdownToHtml,
} from "../markdown/markdown-html-render";
import type { EditorMode } from "../WorkbenchEditorClient";
import type { WorkbenchFileDraftHistory } from "workbench-shared/state/workbench-client-state";
import {
    normalizeEditHistory,
    trimEditHistory,
    cloneEditHistory,
    type EditHistoryState,
} from "./edit-history";
import {
    cloneDraftBuffer,
    type DraftBuffer,
} from "./FileSessionState";
import type WorkbenchClientStateController from "./WorkbenchClientStateController";

type FileDraftRecord = Extract<WorkbenchClientStateRecord, { kind: "fileDraft" }>;

export interface FileDraftStoreSnapshot {
  draftBuffers: Map<string, DraftBuffer>;
}

export type FileDraftStoreListener = (snapshot: FileDraftStoreSnapshot) => void;

/**
 * A buffer whose `expectedMtimeMs` is null is an unsaved new file: nothing exists on disk yet, so it always counts as
 * dirty and stays until it is saved under a name or discarded.
 */
export interface FileDraftStore {
  clearBuffer: (filePath: string) => Promise<void>;
  createNewFileBuffer: (filePath: string, content: string, mode: EditorMode) => void;
  getBuffer: (filePath: string) => DraftBuffer | null;
  getLocallyModifiedPaths: () => string[];
  getNewFilePaths: () => string[];
  getSnapshot: () => FileDraftStoreSnapshot;
  hasSaveIssue: () => boolean;
  hydratePersistedDrafts: () => Promise<void>;
  setBuffer: (filePath: string, buffer: DraftBuffer) => void;
  subscribe: (listener: FileDraftStoreListener) => () => void;
}

/** Cursor positions are DOM paths for one editor instance, so only the text history is stored. */
function toStoredHistory(history: EditHistoryState): WorkbenchFileDraftHistory {
  const trimmed = trimEditHistory(cloneEditHistory(history)!);
  return {
    currentIndex: trimmed.currentIndex,
    frames: trimmed.frames.map(frame => frame.type === "snapshot"
      ? { kind: "snapshot", content: frame.content, timestamp: frame.timestamp }
      : { kind: "patch", ...frame.patch, timestamp: frame.timestamp }),
  };
}

function fromStoredHistory(history: WorkbenchFileDraftHistory | undefined, content: string): EditHistoryState {
  return normalizeEditHistory(history ? {
    currentIndex: history.currentIndex,
    frames: history.frames.map(frame => frame.kind === "snapshot"
      ? { type: "snapshot", content: frame.content, timestamp: frame.timestamp }
      : {
        type: "patch", timestamp: frame.timestamp,
        patch: { start: frame.start, deletedText: frame.deletedText, insertedText: frame.insertedText },
      }),
  } : null, content);
}

interface QueuedDraftWrite {
  buffer: DraftBuffer | null;
  written: Promise<void>;
}

function buildPersistedDraftRecord(
  daemonRegistrationId: string,
  projectId: string,
  filePath: string,
  buffer: DraftBuffer,
): FileDraftRecord {
  return {
    daemonRegistrationId,
    kind: "fileDraft",
    projectId,
    path: filePath,
    value: {
      baselineContent: buffer.baselineContent,
      content: buffer.content,
      expectedMtimeMs: buffer.expectedMtimeMs,
      headContent: buffer.headContent,
      mode: buffer.mode,
      history: toStoredHistory(buffer.history),
    },
  };
}

function createEditorStateFromContent(content: string, mode: EditorMode) {
  return mode === "rich"
    ? renderMarkdownToHtml(content)
    : content;
}

function cloneDraftBuffers(draftBuffers: Map<string, DraftBuffer>) {
  return new Map(
    Array.from(draftBuffers.entries(), ([path, buffer]) => [path, cloneDraftBuffer(buffer)]),
  );
}

function FileDraftStore(
  getProjectId: () => string,
  onChange: () => void = () => {},
  clientStateController?: WorkbenchClientStateController,
  onPersistenceError: (message: string) => void = () => {},
  getDaemonRegistrationId: () => string = () => clientStateController?.daemonRegistrationId ?? "",
): FileDraftStore {
  const listeners = new Set<FileDraftStoreListener>();
  let draftBuffers = new Map<string, DraftBuffer>();
  /** Paths whose draft this session set or cleared; persisted records only speak for the others. */
  const ownedPaths = new Set<string>();
  let draftPersistenceQueue = Promise.resolve();
  /** Writes waiting in the persistence queue, by path; each is replaced by the latest buffer until it starts. */
  const queuedWrites = new Map<string, QueuedDraftWrite>();

  function bufferFromRecord(record: FileDraftRecord): DraftBuffer {
    return {
      baselineContent: record.value.baselineContent,
      content: record.value.content,
      dirty: record.value.content !== record.value.baselineContent || record.value.expectedMtimeMs === null,
      editorState: createEditorStateFromContent(record.value.content, record.value.mode),
      expectedMtimeMs: record.value.expectedMtimeMs,
      headContent: record.value.headContent,
      history: fromStoredHistory(record.value.history, record.value.content),
      mode: record.value.mode,
      pendingWriteConflict: null,
      saveIssue: null,
    };
  }

  /** App state and the daemon registration can arrive after this store; adopt records for paths this session has not touched. */
  function adoptPersistedDrafts() {
    let adopted = false;
    for (const record of getPersistedDraftRecords()) {
      if (ownedPaths.has(record.path) || draftBuffers.has(record.path)) continue;
      if (!adopted) draftBuffers = new Map(draftBuffers);
      draftBuffers.set(record.path, bufferFromRecord(record));
      adopted = true;
    }
    return adopted;
  }

  /** Reads adopt late records too; they announce them after returning, so open editors still learn of them. */
  function adoptWhileReading() {
    if (adoptPersistedDrafts()) queueMicrotask(emit);
  }

  function getSnapshot(): FileDraftStoreSnapshot {
    return {
      draftBuffers: cloneDraftBuffers(draftBuffers),
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
    onChange();
  }

  function subscribe(listener: FileDraftStoreListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getPersistedDraftRecords() {
    if (!clientStateController) {
      return [];
    }
    const projectId = getProjectId();
    return clientStateController.records("fileDraft").filter((record) => (
      record.daemonRegistrationId === getDaemonRegistrationId()
      && record.projectId === projectId
    ));
  }

  function enqueueDraftPersistence(operation: () => Promise<void>) {
    const result = draftPersistenceQueue.then(operation);
    draftPersistenceQueue = result.catch((error) => {
      onPersistenceError(error instanceof Error ? error.message : "Workbench could not persist the file draft.");
    });
    return result;
  }

  async function writeDraftRecord(controller: WorkbenchClientStateController, filePath: string, buffer: DraftBuffer | null) {
    const projectId = getProjectId();
    const daemonRegistrationId = getDaemonRegistrationId();
    if (!buffer || !buffer.dirty) {
      await controller.delete({
        daemonRegistrationId,
        kind: "fileDraft",
        path: filePath,
        projectId,
      });
      return;
    }

    await controller.put(buildPersistedDraftRecord(
      daemonRegistrationId,
      projectId,
      filePath,
      buffer,
    ));
  }

  /** A path's queued write takes the latest buffer when it runs, so typing persists once per write, not per keystroke. */
  function persistDraftBuffer(filePath: string, buffer: DraftBuffer | null) {
    const controller = clientStateController;
    if (!controller) {
      return Promise.resolve();
    }

    const queued = queuedWrites.get(filePath);
    if (queued) {
      queued.buffer = buffer;
      return queued.written;
    }

    const write: QueuedDraftWrite = { buffer, written: Promise.resolve() };
    queuedWrites.set(filePath, write);
    write.written = enqueueDraftPersistence(async () => {
      queuedWrites.delete(filePath);
      await writeDraftRecord(controller, filePath, write.buffer);
    });
    return write.written;
  }

  function getBuffer(filePath: string) {
    adoptWhileReading();
    const buffer = draftBuffers.get(filePath);
    return buffer ? cloneDraftBuffer(buffer) : null;
  }

  function setBuffer(filePath: string, buffer: DraftBuffer) {
    ownedPaths.add(filePath);
    const stored = cloneDraftBuffer(buffer);
    if (stored.expectedMtimeMs === null) stored.dirty = true;
    draftBuffers = new Map(draftBuffers);
    draftBuffers.set(filePath, stored);
    void persistDraftBuffer(filePath, stored);
    emit();
  }

  function createNewFileBuffer(filePath: string, content: string, mode: EditorMode) {
    setBuffer(filePath, {
      baselineContent: "",
      content,
      dirty: true,
      editorState: createEditorStateFromContent(content, mode),
      expectedMtimeMs: null,
      headContent: null,
      history: fromStoredHistory(undefined, content),
      mode,
      pendingWriteConflict: null,
      saveIssue: null,
    });
  }

  async function clearBuffer(filePath: string) {
    ownedPaths.add(filePath);
    const previousBuffer = draftBuffers.get(filePath);
    if (!previousBuffer) {
      await persistDraftBuffer(filePath, null);
      return;
    }

    draftBuffers = new Map(draftBuffers);
    draftBuffers.delete(filePath);
    await persistDraftBuffer(filePath, null);
    emit();
  }

  /** Announces only drafts it adopted, so callers may run it on every app-state change. */
  async function hydratePersistedDrafts() {
    if (adoptPersistedDrafts()) emit();
  }

  function getLocallyModifiedPaths() {
    adoptWhileReading();
    return Array.from(draftBuffers.entries())
      .filter(([, buffer]) => buffer.dirty)
      .map(([filePath]) => filePath)
      .sort((left, right) => left.localeCompare(right));
  }

  function getNewFilePaths() {
    adoptWhileReading();
    return Array.from(draftBuffers.entries())
      .filter(([, buffer]) => buffer.expectedMtimeMs === null)
      .map(([filePath]) => filePath)
      .sort((left, right) => left.localeCompare(right));
  }

  function hasSaveIssue() {
    return Array.from(draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue));
  }

  return {
    clearBuffer,
    createNewFileBuffer,
    getBuffer,
    getLocallyModifiedPaths,
    getNewFilePaths,
    getSnapshot,
    hasSaveIssue,
    hydratePersistedDrafts,
    setBuffer,
    subscribe,
  };
}

export default FileDraftStore;
