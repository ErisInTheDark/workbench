/*
 * Exports:
 * - FileDraftStoreSnapshot: readonly projection of shared draft buffers keyed by file path. Keywords: workbench, file, draft, store, snapshot.
 * - FileDraftStoreListener: subscriber signature for shared draft-store updates. Keywords: workbench, file, draft, subscribe.
 * - default FileDraftStore: create the shared project-scoped draft buffer persistence owner. Keywords: workbench, file, draft, IndexedDB, persistence, default export.
 */

import {
    markdownToHtml as renderMarkdownToHtml,
} from "../markdown/markdown-html-render";
import type { EditorMode } from "../WorkbenchEditorClient";
import {
    cloneEditHistory,
    normalizeEditHistory,
    type EditHistoryState,
} from "./edit-history";
import {
    cloneDraftBuffer,
    type DraftBuffer,
} from "./FileSessionState";
import workbenchDraftStorage, {
    FILE_DRAFT_STORE_NAME,
} from "../storage/workbench-draft-storage";

const DRAFT_DISCARD_TOMBSTONE_STORAGE_KEY = "workbench:file-draft-discard-tombstones:v1";
const DRAFT_DISCARD_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

function cloneDraftBuffers(draftBuffers: Map<string, DraftBuffer>) {
  return new Map(
    Array.from(draftBuffers.entries(), ([path, buffer]) => [path, cloneDraftBuffer(buffer)]),
  );
}

function FileDraftStore(
  getProjectId: () => string,
  onChange: () => void = () => {},
): FileDraftStore {
  const listeners = new Set<FileDraftStoreListener>();
  let draftBuffers = new Map<string, DraftBuffer>();
  let draftPersistenceQueue = Promise.resolve();

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

  function getBuffer(filePath: string) {
    const buffer = draftBuffers.get(filePath);
    return buffer ? cloneDraftBuffer(buffer) : null;
  }

  function setBuffer(filePath: string, buffer: DraftBuffer) {
    draftBuffers = new Map(draftBuffers);
    draftBuffers.set(filePath, cloneDraftBuffer(buffer));
    void persistDraftBuffer(filePath, buffer);
    emit();
  }

  async function clearBuffer(filePath: string) {
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

    draftBuffers = new Map(draftEntries);
    emit();

    for (const record of staleDiscardedRecords) {
      void persistDraftBuffer(record.path, null);
    }
  }

  function getLocallyModifiedPaths() {
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
