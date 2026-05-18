/*
 * Exports:
 * - DRAFT_DATABASE_VERSION: shared IndexedDB schema version for workbench draft stores. Keywords: IndexedDB, schema, migration.
 * - THREAD_COMPOSER_DRAFT_RETENTION_MS: one-month browser retention for unsent thread composer drafts. Keywords: thread, composer, draft, IndexedDB, retention.
 * - createThreadComposerDraftRecordKey: create the project and thread scoped draft key. Keywords: thread, draft, key, project.
 * - createThreadQuestionnaireDraftRecordKey: create the project, thread, and request scoped questionnaire draft key. Keywords: questionnaire, draft, key.
 * - deletePersistedThreadComposerDraft: remove one persisted composer draft after send or explicit clearing. Keywords: thread, composer, draft, delete.
 * - deletePersistedThreadQuestionnaireDraft: remove one persisted questionnaire draft after submit or explicit clearing. Keywords: thread, questionnaire, draft, delete.
 * - getPersistedThreadComposerDraftRecords: read project-scoped composer drafts and prune expired records. Keywords: thread, composer, draft, hydrate, prune.
 * - getPersistedThreadQuestionnaireDraftRecords: read project-scoped questionnaire drafts and prune expired records. Keywords: thread, questionnaire, draft, hydrate, prune.
 * - putPersistedThreadComposerDraft: upsert one composer draft with an updated timestamp. Keywords: thread, composer, draft, persist.
 * - putPersistedThreadQuestionnaireDraft: upsert one questionnaire draft with an updated timestamp. Keywords: thread, questionnaire, draft, persist.
 */

import type { WorkbenchQuestionnaireDraft, WorkbenchThreadComposerDraft } from "../../types";

const DRAFT_DATABASE_NAME = "workbench";
export const DRAFT_DATABASE_VERSION = 4;
const FILE_DRAFT_STORE_NAME = "drafts";
const THREAD_COMPOSER_DRAFT_STORE_NAME = "threadComposerDrafts";
const THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME = "threadQuestionnaireDrafts";
export const THREAD_COMPOSER_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PersistedThreadComposerDraftRecord extends WorkbenchThreadComposerDraft {
  key: string;
  projectId: string;
  threadId: string;
}

export interface PersistedThreadQuestionnaireDraftRecord extends WorkbenchQuestionnaireDraft {
  key: string;
  projectId: string;
  requestKey: string;
  threadId: string;
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
      if (event.oldVersion > 0 && event.oldVersion < 2 && database.objectStoreNames.contains(FILE_DRAFT_STORE_NAME)) {
        database.deleteObjectStore(FILE_DRAFT_STORE_NAME);
      }

      if (!database.objectStoreNames.contains(FILE_DRAFT_STORE_NAME)) {
        database.createObjectStore(FILE_DRAFT_STORE_NAME, { keyPath: "key" });
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

const draftDatabasePromise = openDraftDatabase();
let draftPersistenceQueue = Promise.resolve();

function hasObjectStore(database: IDBDatabase, storeName: string) {
  return database.objectStoreNames.contains(storeName);
}

export function createThreadComposerDraftRecordKey(projectId: string, threadId: string) {
  return `${projectId}/@/thread/${threadId}`;
}

export function createThreadQuestionnaireDraftRecordKey(projectId: string, threadId: string, requestKey: string) {
  return `${projectId}/@/thread/${threadId}/questionnaire/${requestKey}`;
}

function normalizePersistedRecord(record: unknown): PersistedThreadComposerDraftRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const candidate = record as Partial<PersistedThreadComposerDraftRecord>;
  if (
    typeof candidate.key !== "string"
    || typeof candidate.projectId !== "string"
    || typeof candidate.threadId !== "string"
    || typeof candidate.text !== "string"
    || !Array.isArray(candidate.attachments)
    || !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }

  const attachments = candidate.attachments.flatMap((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      return [];
    }

    const attachmentCandidate = attachment as { id?: unknown; url?: unknown };
    return typeof attachmentCandidate.id === "string" && typeof attachmentCandidate.url === "string"
      ? [{ id: attachmentCandidate.id, url: attachmentCandidate.url }]
      : [];
  });

  return {
    attachments,
    key: candidate.key,
    projectId: candidate.projectId,
    text: candidate.text,
    threadId: candidate.threadId,
    updatedAt: Math.trunc(candidate.updatedAt),
  };
}

function normalizeStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => (
      typeof entry === "string" ? [[key, entry]] : []
    )),
  );
}

function normalizeQuestionnaireRecord(record: unknown): PersistedThreadQuestionnaireDraftRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const candidate = record as Partial<PersistedThreadQuestionnaireDraftRecord>;
  if (
    typeof candidate.key !== "string"
    || typeof candidate.projectId !== "string"
    || typeof candidate.requestKey !== "string"
    || typeof candidate.threadId !== "string"
    || !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }

  return {
    customValues: normalizeStringRecord(candidate.customValues),
    key: candidate.key,
    projectId: candidate.projectId,
    requestKey: candidate.requestKey,
    selectedValues: normalizeStringRecord(candidate.selectedValues),
    threadId: candidate.threadId,
    updatedAt: Math.trunc(candidate.updatedAt),
  };
}

function enqueueDraftPersistence(operation: () => Promise<void>) {
  draftPersistenceQueue = draftPersistenceQueue
    .catch(() => {
      // Keep later persistence operations flowing after a transient failure.
    })
    .then(operation);

  return draftPersistenceQueue;
}

export async function getPersistedThreadComposerDraftRecords(projectId: string) {
  const database = await draftDatabasePromise;
  if (!database || !hasObjectStore(database, THREAD_COMPOSER_DRAFT_STORE_NAME)) {
    return [] as PersistedThreadComposerDraftRecord[];
  }

  const transaction = database.transaction(THREAD_COMPOSER_DRAFT_STORE_NAME, "readonly");
  const store = transaction.objectStore(THREAD_COMPOSER_DRAFT_STORE_NAME);
  const request = store.getAll();
  const rawRecords = await wrapIndexedDbRequest(request as IDBRequest<unknown[]>);
  await waitForTransaction(transaction);

  const expirationCutoff = Date.now() - THREAD_COMPOSER_DRAFT_RETENTION_MS;
  const records = rawRecords.flatMap((record) => {
    const normalized = normalizePersistedRecord(record);
    return normalized && normalized.projectId === projectId ? [normalized] : [];
  });
  const expiredRecords = records.filter((record) => record.updatedAt < expirationCutoff);
  if (expiredRecords.length) {
    void enqueueDraftPersistence(async () => {
      const writeDatabase = await draftDatabasePromise;
      if (!writeDatabase || !hasObjectStore(writeDatabase, THREAD_COMPOSER_DRAFT_STORE_NAME)) {
        return;
      }

      const writeTransaction = writeDatabase.transaction(THREAD_COMPOSER_DRAFT_STORE_NAME, "readwrite");
      const writeStore = writeTransaction.objectStore(THREAD_COMPOSER_DRAFT_STORE_NAME);
      for (const record of expiredRecords) {
        writeStore.delete(record.key);
      }
      await waitForTransaction(writeTransaction);
    });
  }

  return records.filter((record) => record.updatedAt >= expirationCutoff);
}

export async function getPersistedThreadQuestionnaireDraftRecords(projectId: string) {
  const database = await draftDatabasePromise;
  if (!database || !hasObjectStore(database, THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME)) {
    return [] as PersistedThreadQuestionnaireDraftRecord[];
  }

  const transaction = database.transaction(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, "readonly");
  const store = transaction.objectStore(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME);
  const request = store.getAll();
  const rawRecords = await wrapIndexedDbRequest(request as IDBRequest<unknown[]>);
  await waitForTransaction(transaction);

  const expirationCutoff = Date.now() - THREAD_COMPOSER_DRAFT_RETENTION_MS;
  const records = rawRecords.flatMap((record) => {
    const normalized = normalizeQuestionnaireRecord(record);
    return normalized && normalized.projectId === projectId ? [normalized] : [];
  });
  const expiredRecords = records.filter((record) => record.updatedAt < expirationCutoff);
  if (expiredRecords.length) {
    void enqueueDraftPersistence(async () => {
      const writeDatabase = await draftDatabasePromise;
      if (!writeDatabase || !hasObjectStore(writeDatabase, THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME)) {
        return;
      }

      const writeTransaction = writeDatabase.transaction(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, "readwrite");
      const writeStore = writeTransaction.objectStore(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME);
      for (const record of expiredRecords) {
        writeStore.delete(record.key);
      }
      await waitForTransaction(writeTransaction);
    });
  }

  return records.filter((record) => record.updatedAt >= expirationCutoff);
}

export function putPersistedThreadComposerDraft(projectId: string, threadId: string, draft: WorkbenchThreadComposerDraft) {
  return enqueueDraftPersistence(async () => {
    const database = await draftDatabasePromise;
    if (!database || !hasObjectStore(database, THREAD_COMPOSER_DRAFT_STORE_NAME)) {
      return;
    }

    const record: PersistedThreadComposerDraftRecord = {
      ...draft,
      key: createThreadComposerDraftRecordKey(projectId, threadId),
      projectId,
      threadId,
      updatedAt: Date.now(),
    };
    const transaction = database.transaction(THREAD_COMPOSER_DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(THREAD_COMPOSER_DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.put(record));
    await waitForTransaction(transaction);
  });
}

export function deletePersistedThreadComposerDraft(projectId: string, threadId: string) {
  return enqueueDraftPersistence(async () => {
    const database = await draftDatabasePromise;
    if (!database || !hasObjectStore(database, THREAD_COMPOSER_DRAFT_STORE_NAME)) {
      return;
    }

    const transaction = database.transaction(THREAD_COMPOSER_DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(THREAD_COMPOSER_DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.delete(createThreadComposerDraftRecordKey(projectId, threadId)));
    await waitForTransaction(transaction);
  });
}

export function putPersistedThreadQuestionnaireDraft(
  projectId: string,
  threadId: string,
  requestKey: string,
  draft: WorkbenchQuestionnaireDraft,
) {
  return enqueueDraftPersistence(async () => {
    const database = await draftDatabasePromise;
    if (!database || !hasObjectStore(database, THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME)) {
      return;
    }

    const record: PersistedThreadQuestionnaireDraftRecord = {
      ...draft,
      key: createThreadQuestionnaireDraftRecordKey(projectId, threadId, requestKey),
      projectId,
      requestKey,
      threadId,
      updatedAt: Date.now(),
    };
    const transaction = database.transaction(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.put(record));
    await waitForTransaction(transaction);
  });
}

export function deletePersistedThreadQuestionnaireDraft(projectId: string, threadId: string, requestKey: string) {
  return enqueueDraftPersistence(async () => {
    const database = await draftDatabasePromise;
    if (!database || !hasObjectStore(database, THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME)) {
      return;
    }

    const transaction = database.transaction(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.delete(createThreadQuestionnaireDraftRecordKey(projectId, threadId, requestKey)));
    await waitForTransaction(transaction);
  });
}
