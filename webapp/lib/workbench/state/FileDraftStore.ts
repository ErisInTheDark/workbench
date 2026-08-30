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
import {
    createInitialEditHistory,
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

function buildPersistedDraftRecord(
  controller: WorkbenchClientStateController,
  projectId: string,
  filePath: string,
  buffer: DraftBuffer,
): FileDraftRecord {
  return {
    daemonRegistrationId: controller.daemonRegistrationId,
    kind: "fileDraft",
    projectId,
    path: filePath,
    value: {
      baselineContent: buffer.baselineContent,
      content: buffer.content,
      expectedMtimeMs: buffer.expectedMtimeMs,
      headContent: buffer.headContent,
      mode: buffer.mode,
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

  function getPersistedDraftRecords() {
    if (!clientStateController) {
      return [];
    }
    const projectId = getProjectId();
    return clientStateController.records("fileDraft").filter((record) => (
      record.daemonRegistrationId === clientStateController.daemonRegistrationId
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
    if (!clientStateController) {
      return Promise.resolve();
    }
    return enqueueDraftPersistence(async () => {
      if (!buffer || !buffer.dirty) {
        await clientStateController.delete({
          daemonRegistrationId: clientStateController.daemonRegistrationId,
          kind: "fileDraft",
          path: filePath,
          projectId,
        });
        return;
      }

      await clientStateController.put(buildPersistedDraftRecord(
        clientStateController,
        projectId,
        filePath,
        buffer,
      ));
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
    const draftEntries = getPersistedDraftRecords()
      .map((record) => {
        const buffer: DraftBuffer = {
          baselineContent: record.value.baselineContent,
          content: record.value.content,
          dirty: record.value.content !== record.value.baselineContent,
          editorState: createEditorStateFromContent(record.value.content, record.value.mode),
          expectedMtimeMs: record.value.expectedMtimeMs,
          headContent: record.value.headContent,
          history: createInitialEditHistory(record.value.content),
          mode: record.value.mode,
          pendingWriteConflict: null,
          saveIssue: null,
        };

        return [record.path, buffer] satisfies [string, DraftBuffer];
      });

    draftBuffers = new Map(draftEntries);
    emit();
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
