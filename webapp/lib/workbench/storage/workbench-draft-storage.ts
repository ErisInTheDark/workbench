/*
 * Exports:
 * - FILE_DRAFT_STORE_NAME, THREAD_COMPOSER_DRAFT_STORE_NAME, THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME: retained workbench draft object-store names. Keywords: IndexedDB, draft, stores.
 * - Composer and questionnaire draft helpers: persist, read, and delete existing-thread input drafts. Keywords: composer, questionnaire, draft, persistence.
 * - upgradeWorkbenchDraftStorage: remove the obsolete saved-message shelf while preserving existing-thread input. Keywords: IndexedDB, upgrade, cleanup.
 * - WorkbenchDraftStoreName: union of workbench draft object-store names. Keywords: IndexedDB, draft, types.
 * - default workbenchDraftStorage: shared IndexedDB storage adapter for workbench draft persistence. Keywords: IndexedDB, draft, storage.
 */

import IndexedDbStore from "./IndexedDbStore";
import type { WorkbenchComposerInputDraft, WorkbenchQuestionnaireDraft } from "../../types";

const WORKBENCH_DRAFT_DATABASE_NAME = "workbench";
const WORKBENCH_DRAFT_DATABASE_VERSION = 7;

export const FILE_DRAFT_STORE_NAME = "drafts";
export const THREAD_COMPOSER_DRAFT_STORE_NAME = "threadComposerDrafts";
export const THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME = "threadQuestionnaireDrafts";
const OBSOLETE_PROMPT_STORES = ["threadSavedComposerDrafts"] as const;

export type WorkbenchDraftStoreName =
  | typeof FILE_DRAFT_STORE_NAME
  | typeof THREAD_COMPOSER_DRAFT_STORE_NAME
  | typeof THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME;

export function upgradeWorkbenchDraftStorage(database: Pick<IDBDatabase, "deleteObjectStore" | "objectStoreNames">, oldVersion: number) {
  if (oldVersion >= WORKBENCH_DRAFT_DATABASE_VERSION) return;
  for (const storeName of OBSOLETE_PROMPT_STORES) if (database.objectStoreNames.contains(storeName)) database.deleteObjectStore(storeName);
}

const workbenchDraftStorage = new IndexedDbStore<WorkbenchDraftStoreName>({
  databaseName: WORKBENCH_DRAFT_DATABASE_NAME,
  onUpgrade: upgradeWorkbenchDraftStorage,
  stores: [
    {
      deleteBeforeVersion: 2,
      name: FILE_DRAFT_STORE_NAME,
      options: { keyPath: "key" },
    },
    {
      name: THREAD_COMPOSER_DRAFT_STORE_NAME,
      options: { keyPath: "key" },
    },
    {
      name: THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME,
      options: { keyPath: "key" },
    },
  ],
  version: WORKBENCH_DRAFT_DATABASE_VERSION,
});

const THREAD_INPUT_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface PersistedThreadComposerDraftRecord extends WorkbenchComposerInputDraft {
  key: string;
  projectId: string;
  threadId: string;
}

interface PersistedThreadQuestionnaireDraftRecord extends WorkbenchQuestionnaireDraft {
  key: string;
  projectId: string;
  requestKey: string;
  threadId: string;
}

function createQuestionnaireDraftKey(projectId: string, threadId: string, requestKey: string) {
  return `${projectId}/@/thread/${threadId}/questionnaire/${requestKey}`;
}

function createComposerDraftKey(projectId: string, threadId: string) {
  return `${projectId}/@/thread/${threadId}`;
}

function normalizeAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return [];
    const candidate = attachment as { id?: unknown; url?: unknown };
    return typeof candidate.id === "string" && typeof candidate.url === "string" ? [{ id: candidate.id, url: candidate.url }] : [];
  });
}

function normalizeStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => typeof entry === "string" ? [[key, entry]] : []));
}

function normalizeStringArrayRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (typeof entry === "string") return entry.trim() ? [[key, [entry]]] : [];
    if (!Array.isArray(entry)) return [];
    const values = entry.filter((candidate): candidate is string => typeof candidate === "string");
    return values.length ? [[key, values]] : [];
  }));
}

function normalizeQuestionnaireRecord(record: unknown): PersistedThreadQuestionnaireDraftRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const candidate = record as Partial<PersistedThreadQuestionnaireDraftRecord>;
  if (typeof candidate.key !== "string" || typeof candidate.projectId !== "string" || typeof candidate.requestKey !== "string" || typeof candidate.threadId !== "string" || !Number.isFinite(candidate.updatedAt)) return null;
  return {
    attachments: normalizeAttachments(candidate.attachments),
    customValues: normalizeStringRecord(candidate.customValues),
    key: candidate.key,
    projectId: candidate.projectId,
    requestKey: candidate.requestKey,
    selectedValues: normalizeStringArrayRecord(candidate.selectedValues),
    threadId: candidate.threadId,
    updatedAt: Math.trunc(candidate.updatedAt!),
  };
}

function normalizeComposerRecord(record: unknown): PersistedThreadComposerDraftRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const candidate = record as Partial<PersistedThreadComposerDraftRecord>;
  if (typeof candidate.key !== "string" || typeof candidate.projectId !== "string" || typeof candidate.threadId !== "string" || typeof candidate.text !== "string" || !Number.isFinite(candidate.updatedAt)) return null;
  return {
    attachments: normalizeAttachments(candidate.attachments),
    key: candidate.key,
    projectId: candidate.projectId,
    text: candidate.text,
    threadId: candidate.threadId,
    updatedAt: Math.trunc(candidate.updatedAt!),
  };
}

export async function getPersistedThreadComposerDraftRecords(projectId: string) {
  const rawRecords = await workbenchDraftStorage.getAll<unknown>(THREAD_COMPOSER_DRAFT_STORE_NAME);
  const expirationCutoff = Date.now() - THREAD_INPUT_DRAFT_RETENTION_MS;
  const records = rawRecords.flatMap((record) => {
    const normalized = normalizeComposerRecord(record);
    return normalized && normalized.projectId === projectId ? [normalized] : [];
  });
  for (const record of records.filter((candidate) => candidate.updatedAt < expirationCutoff)) {
    void workbenchDraftStorage.delete(THREAD_COMPOSER_DRAFT_STORE_NAME, record.key);
  }
  return records.filter((record) => record.updatedAt >= expirationCutoff);
}

export function putPersistedThreadComposerDraft(projectId: string, threadId: string, draft: WorkbenchComposerInputDraft) {
  const record: PersistedThreadComposerDraftRecord = {
    ...draft,
    key: createComposerDraftKey(projectId, threadId),
    projectId,
    threadId,
    updatedAt: Date.now(),
  };
  return workbenchDraftStorage.put(THREAD_COMPOSER_DRAFT_STORE_NAME, record);
}

export function deletePersistedThreadComposerDraft(projectId: string, threadId: string) {
  return workbenchDraftStorage.delete(THREAD_COMPOSER_DRAFT_STORE_NAME, createComposerDraftKey(projectId, threadId));
}

export async function getPersistedThreadQuestionnaireDraftRecords(projectId: string) {
  const rawRecords = await workbenchDraftStorage.getAll<unknown>(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME);
  const expirationCutoff = Date.now() - THREAD_INPUT_DRAFT_RETENTION_MS;
  const records = rawRecords.flatMap((record) => {
    const normalized = normalizeQuestionnaireRecord(record);
    return normalized && normalized.projectId === projectId ? [normalized] : [];
  });
  for (const record of records.filter((candidate) => candidate.updatedAt < expirationCutoff)) {
    void workbenchDraftStorage.delete(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, record.key);
  }
  return records.filter((record) => record.updatedAt >= expirationCutoff);
}

export function putPersistedThreadQuestionnaireDraft(projectId: string, threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) {
  const record: PersistedThreadQuestionnaireDraftRecord = {
    ...draft,
    key: createQuestionnaireDraftKey(projectId, threadId, requestKey),
    projectId,
    requestKey,
    threadId,
    updatedAt: Date.now(),
  };
  return workbenchDraftStorage.put(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, record);
}

export function deletePersistedThreadQuestionnaireDraft(projectId: string, threadId: string, requestKey: string) {
  return workbenchDraftStorage.delete(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, createQuestionnaireDraftKey(projectId, threadId, requestKey));
}

export default workbenchDraftStorage;
