/*
 * Exports:
 * - FileDraftStoreSnapshot: readonly projection of shared draft buffers keyed by file path. Keywords: workbench, file, draft, store, snapshot.
 * - FileDraftStoreListener: subscriber signature for shared draft-store updates. Keywords: workbench, file, draft, subscribe.
 * - default FileDraftStore: create the shared project-scoped draft buffer persistence owner. Keywords: workbench, file, draft, app state, persistence, default export.
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

export interface FileDraftStore {
  clearBuffer: (filePath: string) => Promise<void>;
  getBuffer: (filePath: string) => DraftBuffer | null;
  getLocallyModifiedPaths: () => string[];
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

  function bufferFromRecord(record: FileDraftRecord): DraftBuffer {
    return {
      baselineContent: record.value.baselineContent,
      content: record.value.content,
      dirty: record.value.content !== record.value.baselineContent,
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

  function persistDraftBuffer(filePath: string, buffer: DraftBuffer | null) {
    const projectId = getProjectId();
    const daemonRegistrationId = getDaemonRegistrationId();
    if (!clientStateController) {
      return Promise.resolve();
    }
    return enqueueDraftPersistence(async () => {
      if (!buffer || !buffer.dirty) {
        await clientStateController.delete({
          daemonRegistrationId,
          kind: "fileDraft",
          path: filePath,
          projectId,
        });
        return;
      }

      await clientStateController.put(buildPersistedDraftRecord(
        daemonRegistrationId,
        projectId,
        filePath,
        buffer,
      ));
    });
  }

  function getBuffer(filePath: string) {
    adoptPersistedDrafts();
    const buffer = draftBuffers.get(filePath);
    return buffer ? cloneDraftBuffer(buffer) : null;
  }

  function setBuffer(filePath: string, buffer: DraftBuffer) {
    ownedPaths.add(filePath);
    draftBuffers = new Map(draftBuffers);
    draftBuffers.set(filePath, cloneDraftBuffer(buffer));
    void persistDraftBuffer(filePath, buffer);
    emit();
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

  async function hydratePersistedDrafts() {
    adoptPersistedDrafts();
    emit();
  }

  function getLocallyModifiedPaths() {
    adoptPersistedDrafts();
    return Array.from(draftBuffers.entries())
      .filter(([, buffer]) => buffer.dirty)
      .map(([filePath]) => filePath)
      .sort((left, right) => left.localeCompare(right));
  }

  function hasSaveIssue() {
    return Array.from(draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue));
  }

  return {
    clearBuffer,
    getBuffer,
    getLocallyModifiedPaths,
    getSnapshot,
    hasSaveIssue,
    hydratePersistedDrafts,
    setBuffer,
    subscribe,
  };
}

export default FileDraftStore;
