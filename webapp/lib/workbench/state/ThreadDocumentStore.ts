/*
 * Exports:
 * - ThreadDocumentStoreSnapshot: readonly document-store projection for rendered thread payloads. Keywords: thread, document, snapshot.
 * - ThreadDocumentStoreListener: subscriber signature for thread document updates. Keywords: thread, document, subscribe.
 * - ThreadDocumentStoreUpsertResult: result of inserting or replacing a thread document. Keywords: thread, document, upsert.
 * - ThreadDocumentStoreOptions: creation options for document equality. Keywords: thread, document, equality.
 * - ThreadDocumentStore: mutable owner for normalized thread documents and selected thread identity. Keywords: thread, document, state, controller.
 * - default ThreadDocumentStore: create the thread document state owner. Keywords: thread, document, state, create.
 */

import type { ThreadPayload, WorkbenchThreadDocumentSnapshot } from "../../types";
import { areDeeplyEqual } from "../deep-equality";
import { createThreadDocumentKeyForThread } from "../thread/thread-document-keys";

export type ThreadDocumentStoreSnapshot = WorkbenchThreadDocumentSnapshot;

export type ThreadDocumentStoreListener = (snapshot: ThreadDocumentStoreSnapshot) => void;

export interface ThreadDocumentStoreUpsertResult {
  didChange: boolean;
  didSelectionChange: boolean;
  document: ThreadPayload;
}

export interface ThreadDocumentStoreOptions {
  areDocumentsEquivalent?: (left: ThreadPayload | null, right: ThreadPayload | null) => boolean;
}

export interface ThreadDocumentStore {
  clear: () => boolean;
  getDocumentByKey: (key: string) => ThreadPayload | null;
  getDocumentByThreadId: (threadId: string) => ThreadPayload | null;
  getSelectedDocument: () => ThreadPayload | null;
  getSelectedThreadKey: () => string;
  getSnapshot: () => ThreadDocumentStoreSnapshot;
  materializeFinalVisibleDocument: (key: string, thread: ThreadPayload, options?: { select?: boolean }) => ThreadDocumentStoreUpsertResult;
  selectDocument: (thread: ThreadPayload | null) => boolean;
  selectDocumentKey: (key: string) => boolean;
  subscribe: (listener: ThreadDocumentStoreListener) => () => void;
  upsertDocument: (thread: ThreadPayload, options?: { select?: boolean }) => ThreadDocumentStoreUpsertResult;
}

function defaultAreDocumentsEquivalent(left: ThreadPayload | null, right: ThreadPayload | null) {
  return left === right || Boolean(left && right && areDeeplyEqual(left, right));
}

function ThreadDocumentStore({
  areDocumentsEquivalent = defaultAreDocumentsEquivalent,
}: ThreadDocumentStoreOptions = {}): ThreadDocumentStore {
  const documentsByKey = new Map<string, ThreadPayload>();
  const keysByThreadId = new Map<string, string>();
  const listeners = new Set<ThreadDocumentStoreListener>();
  let snapshot: ThreadDocumentStoreSnapshot = {
    documentsByKey: {},
    keysByThreadId: {},
    selectedThreadKey: "",
  };
  let selectedThreadKey = "";
  let snapshotDirty = false;

  function getSnapshot(): ThreadDocumentStoreSnapshot {
    if (!snapshotDirty) {
      return snapshot;
    }

    snapshot = {
      documentsByKey: Object.fromEntries(documentsByKey.entries()),
      keysByThreadId: Object.fromEntries(keysByThreadId.entries()),
      selectedThreadKey,
    };
    snapshotDirty = false;
    return snapshot;
  }

  function emit() {
    snapshotDirty = true;
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function getDocumentByKey(key: string) {
    return documentsByKey.get(key) ?? null;
  }

  function getDocumentByThreadId(threadId: string) {
    const key = keysByThreadId.get(threadId) ?? "";
    return key ? getDocumentByKey(key) : null;
  }

  function getSelectedDocument() {
    return selectedThreadKey ? getDocumentByKey(selectedThreadKey) : null;
  }

  function selectDocumentKey(key: string) {
    if (selectedThreadKey === key) {
      return false;
    }

    selectedThreadKey = key;
    emit();
    return true;
  }

  function selectDocument(thread: ThreadPayload | null) {
    const nextSelectedThreadKey = thread ? createThreadDocumentKeyForThread(thread) : "";
    let didDocumentChange = false;
    if (thread) {
      const existing = documentsByKey.get(nextSelectedThreadKey) ?? null;
      if (!areDocumentsEquivalent(existing, thread)) {
        documentsByKey.set(nextSelectedThreadKey, thread);
        keysByThreadId.set(thread.id, nextSelectedThreadKey);
        didDocumentChange = true;
      }
    }

    if (selectedThreadKey === nextSelectedThreadKey) {
      if (didDocumentChange) {
        emit();
        return true;
      }
      return false;
    }

    selectedThreadKey = nextSelectedThreadKey;
    emit();
    return true;
  }

  return {
    clear() {
      const didChange = documentsByKey.size > 0 || keysByThreadId.size > 0 || selectedThreadKey !== "";
      if (!didChange) {
        return false;
      }

      documentsByKey.clear();
      keysByThreadId.clear();
      selectedThreadKey = "";
      emit();
      return true;
    },
    getDocumentByKey,
    getDocumentByThreadId,
    getSelectedDocument,
    getSelectedThreadKey() {
      return selectedThreadKey;
    },
    getSnapshot,
    materializeFinalVisibleDocument(key, thread, options = {}) {
      const existing = documentsByKey.get(key) ?? null;
      const didChange = !areDocumentsEquivalent(existing, thread);
      if (didChange) {
        documentsByKey.set(key, thread);
        keysByThreadId.set(thread.id, key);
      }

      const nextSelectedThreadKey = options.select ? key : selectedThreadKey;
      const didSelectionChange = selectedThreadKey !== nextSelectedThreadKey;
      if (didSelectionChange) {
        selectedThreadKey = nextSelectedThreadKey;
      }

      if (didChange || didSelectionChange) {
        emit();
      }

      return {
        didChange,
        didSelectionChange,
        document: documentsByKey.get(key) ?? thread,
      };
    },
    selectDocument,
    selectDocumentKey,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    upsertDocument(thread, options = {}) {
      const key = createThreadDocumentKeyForThread(thread);
      const existing = documentsByKey.get(key) ?? null;
      const didChange = !areDocumentsEquivalent(existing, thread);
      if (didChange) {
        documentsByKey.set(key, thread);
        keysByThreadId.set(thread.id, key);
      }

      const nextSelectedThreadKey = options.select ? key : selectedThreadKey;
      const didSelectionChange = selectedThreadKey !== nextSelectedThreadKey;
      if (didSelectionChange) {
        selectedThreadKey = nextSelectedThreadKey;
      }

      if (didChange || didSelectionChange) {
        emit();
      }

      return {
        didChange,
        didSelectionChange,
        document: documentsByKey.get(key) ?? thread,
      };
    },
  };
}

export default ThreadDocumentStore;
