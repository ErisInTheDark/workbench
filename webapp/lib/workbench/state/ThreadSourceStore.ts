/*
 * Exports:
 * - ThreadSourceStore: exact-key owner for raw thread payloads and canonical revisions. Keywords: thread, source, revision, state.
 * - default ThreadSourceStore: create the raw thread source owner. Keywords: thread, source, create.
 */

import type { ThreadPayload } from "../../types";
import { createThreadDocumentKeyForThread } from "../thread/thread-document-keys";

export interface ThreadSourceStore {
  clear: () => void;
  delete: (key: string) => boolean;
  get: (key: string) => ThreadPayload | null;
  getRevision: (key: string) => number;
  has: (key: string) => boolean;
  install: (thread: ThreadPayload) => string;
  update: (key: string, updater: (thread: ThreadPayload) => ThreadPayload | null) => boolean;
}

function ThreadSourceStore(): ThreadSourceStore {
  const revisionsByKey = new Map<string, number>();
  const threadsByKey = new Map<string, ThreadPayload>();

  function incrementRevision(key: string) {
    revisionsByKey.set(key, (revisionsByKey.get(key) ?? 0) + 1);
  }

  return {
    clear() {
      threadsByKey.clear();
      revisionsByKey.clear();
    },
    delete(key) {
      const didDelete = threadsByKey.delete(key);
      if (didDelete) {
        incrementRevision(key);
      }
      return didDelete;
    },
    get(key) {
      return threadsByKey.get(key) ?? null;
    },
    getRevision(key) {
      return revisionsByKey.get(key) ?? 0;
    },
    has(key) {
      return threadsByKey.has(key);
    },
    install(thread) {
      const key = createThreadDocumentKeyForThread(thread);
      threadsByKey.set(key, thread);
      incrementRevision(key);
      return key;
    },
    update(key, updater) {
      const current = threadsByKey.get(key);
      if (!current) {
        return false;
      }

      const replacement = updater(current);
      if (!replacement || replacement === current) {
        return false;
      }

      const replacementKey = createThreadDocumentKeyForThread(replacement);
      if (replacementKey !== key) {
        throw new Error(`Thread source update cannot change key from ${key} to ${replacementKey}.`);
      }

      threadsByKey.set(key, replacement);
      incrementRevision(key);
      return true;
    },
  };
}

export default ThreadSourceStore;
