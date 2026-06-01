/*
 * Exports:
 * - THREAD_COMPOSER_DRAFT_RETENTION_MS: one-month browser retention for unsent thread composer drafts. Keywords: thread, composer, draft, IndexedDB, retention.
 * - createThreadComposerDraftRecordKey: create the project and thread scoped draft key. Keywords: thread, draft, key, project.
 * - createThreadQuestionnaireDraftRecordKey: create the project, thread, and request scoped questionnaire draft key. Keywords: questionnaire, draft, key.
 * - createThreadSavedComposerDraftRecordKey: create the project scoped saved draft key. Keywords: thread, saved draft, key, project.
 * - deletePersistedThreadComposerDraft: remove one persisted composer draft after send or explicit clearing. Keywords: thread, composer, draft, delete.
 * - deletePersistedThreadQuestionnaireDraft: remove one persisted questionnaire draft after submit or explicit clearing. Keywords: thread, questionnaire, draft, delete.
 * - deletePersistedThreadSavedComposerDraft: remove one project saved composer draft. Keywords: thread, saved draft, delete.
 * - getPersistedThreadComposerDraftRecords: read project-scoped composer drafts and prune expired records. Keywords: thread, composer, draft, hydrate, prune.
 * - getPersistedThreadQuestionnaireDraftRecords: read project-scoped questionnaire drafts and prune expired records. Keywords: thread, questionnaire, draft, hydrate, prune.
 * - getPersistedThreadSavedComposerDraftRecords: read project-scoped saved composer drafts. Keywords: thread, saved draft, hydrate.
 * - putPersistedThreadComposerDraft: upsert one composer draft with an updated timestamp. Keywords: thread, composer, draft, persist.
 * - putPersistedThreadQuestionnaireDraft: upsert one questionnaire draft with an updated timestamp. Keywords: thread, questionnaire, draft, persist.
 * - putPersistedThreadSavedComposerDraft: upsert one project saved composer draft. Keywords: thread, saved draft, persist.
 */

import type { WorkbenchQuestionnaireDraft, WorkbenchThreadComposerDraft, WorkbenchThreadSavedComposerDraft } from "../../types";
import workbenchDraftStorage, {
  THREAD_COMPOSER_DRAFT_STORE_NAME,
  THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME,
  THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME,
} from "../storage/workbench-draft-storage";

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

export interface PersistedThreadSavedComposerDraftRecord extends WorkbenchThreadSavedComposerDraft {
  key: string;
  projectId: string;
}

export function createThreadComposerDraftRecordKey(projectId: string, threadId: string) {
  return `${projectId}/@/thread/${threadId}`;
}

export function createThreadQuestionnaireDraftRecordKey(projectId: string, threadId: string, requestKey: string) {
  return `${projectId}/@/thread/${threadId}/questionnaire/${requestKey}`;
}

export function createThreadSavedComposerDraftRecordKey(projectId: string, draftId: string) {
  return `${projectId}/@/saved-thread-draft/${draftId}`;
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

function normalizeSavedComposerRecord(record: unknown): PersistedThreadSavedComposerDraftRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const candidate = record as Partial<PersistedThreadSavedComposerDraftRecord>;
  if (
    typeof candidate.key !== "string"
    || typeof candidate.projectId !== "string"
    || typeof candidate.id !== "string"
    || typeof candidate.text !== "string"
    || !Array.isArray(candidate.attachments)
    || !Number.isFinite(candidate.createdAt)
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
    createdAt: Math.trunc(candidate.createdAt),
    id: candidate.id,
    key: candidate.key,
    projectId: candidate.projectId,
    text: candidate.text,
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

export async function getPersistedThreadComposerDraftRecords(projectId: string) {
  const rawRecords = await workbenchDraftStorage.getAll<unknown>(THREAD_COMPOSER_DRAFT_STORE_NAME);
  const expirationCutoff = Date.now() - THREAD_COMPOSER_DRAFT_RETENTION_MS;
  const records = rawRecords.flatMap((record) => {
    const normalized = normalizePersistedRecord(record);
    return normalized && normalized.projectId === projectId ? [normalized] : [];
  });
  const expiredRecords = records.filter((record) => record.updatedAt < expirationCutoff);
  if (expiredRecords.length) {
    for (const record of expiredRecords) {
      void workbenchDraftStorage.delete(THREAD_COMPOSER_DRAFT_STORE_NAME, record.key);
    }
  }

  return records.filter((record) => record.updatedAt >= expirationCutoff);
}

export async function getPersistedThreadQuestionnaireDraftRecords(projectId: string) {
  const rawRecords = await workbenchDraftStorage.getAll<unknown>(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME);
  const expirationCutoff = Date.now() - THREAD_COMPOSER_DRAFT_RETENTION_MS;
  const records = rawRecords.flatMap((record) => {
    const normalized = normalizeQuestionnaireRecord(record);
    return normalized && normalized.projectId === projectId ? [normalized] : [];
  });
  const expiredRecords = records.filter((record) => record.updatedAt < expirationCutoff);
  if (expiredRecords.length) {
    for (const record of expiredRecords) {
      void workbenchDraftStorage.delete(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, record.key);
    }
  }

  return records.filter((record) => record.updatedAt >= expirationCutoff);
}

export async function getPersistedThreadSavedComposerDraftRecords(projectId: string) {
  const rawRecords = await workbenchDraftStorage.getAll<unknown>(THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME);
  return rawRecords
    .flatMap((record) => {
      const normalized = normalizeSavedComposerRecord(record);
      return normalized && normalized.projectId === projectId ? [normalized] : [];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function putPersistedThreadComposerDraft(projectId: string, threadId: string, draft: WorkbenchThreadComposerDraft) {
  const record: PersistedThreadComposerDraftRecord = {
    ...draft,
    key: createThreadComposerDraftRecordKey(projectId, threadId),
    projectId,
    threadId,
    updatedAt: Date.now(),
  };
  return workbenchDraftStorage.put(THREAD_COMPOSER_DRAFT_STORE_NAME, record);
}

export function putPersistedThreadSavedComposerDraft(projectId: string, draft: WorkbenchThreadSavedComposerDraft) {
  const record: PersistedThreadSavedComposerDraftRecord = {
    ...draft,
    key: createThreadSavedComposerDraftRecordKey(projectId, draft.id),
    projectId,
    updatedAt: Date.now(),
  };
  return workbenchDraftStorage.put(THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME, record);
}

export function deletePersistedThreadComposerDraft(projectId: string, threadId: string) {
  return workbenchDraftStorage.delete(THREAD_COMPOSER_DRAFT_STORE_NAME, createThreadComposerDraftRecordKey(projectId, threadId));
}

export function deletePersistedThreadSavedComposerDraft(projectId: string, draftId: string) {
  return workbenchDraftStorage.delete(THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME, createThreadSavedComposerDraftRecordKey(projectId, draftId));
}

export function putPersistedThreadQuestionnaireDraft(
  projectId: string,
  threadId: string,
  requestKey: string,
  draft: WorkbenchQuestionnaireDraft,
) {
  const record: PersistedThreadQuestionnaireDraftRecord = {
    ...draft,
    key: createThreadQuestionnaireDraftRecordKey(projectId, threadId, requestKey),
    projectId,
    requestKey,
    threadId,
    updatedAt: Date.now(),
  };
  return workbenchDraftStorage.put(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, record);
}

export function deletePersistedThreadQuestionnaireDraft(projectId: string, threadId: string, requestKey: string) {
  return workbenchDraftStorage.delete(THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, createThreadQuestionnaireDraftRecordKey(projectId, threadId, requestKey));
}
