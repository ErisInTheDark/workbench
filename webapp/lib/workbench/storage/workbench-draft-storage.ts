/*
 * Exports:
 * - FILE_DRAFT_STORE_NAME, THREAD_COMPOSER_DRAFT_STORE_NAME, THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME, THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME: workbench draft object-store names. Keywords: IndexedDB, draft, stores.
 * - WorkbenchDraftStoreName: union of workbench draft object-store names. Keywords: IndexedDB, draft, types.
 * - default workbenchDraftStorage: shared IndexedDB storage adapter for workbench draft persistence. Keywords: IndexedDB, draft, storage.
 */

import IndexedDbStore from "./IndexedDbStore";

const WORKBENCH_DRAFT_DATABASE_NAME = "workbench";
const WORKBENCH_DRAFT_DATABASE_VERSION = 5;

export const FILE_DRAFT_STORE_NAME = "drafts";
export const THREAD_COMPOSER_DRAFT_STORE_NAME = "threadComposerDrafts";
export const THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME = "threadQuestionnaireDrafts";
export const THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME = "threadSavedComposerDrafts";

export type WorkbenchDraftStoreName =
  | typeof FILE_DRAFT_STORE_NAME
  | typeof THREAD_COMPOSER_DRAFT_STORE_NAME
  | typeof THREAD_QUESTIONNAIRE_DRAFT_STORE_NAME
  | typeof THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME;

const workbenchDraftStorage = new IndexedDbStore<WorkbenchDraftStoreName>({
  databaseName: WORKBENCH_DRAFT_DATABASE_NAME,
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
    {
      name: THREAD_SAVED_COMPOSER_DRAFT_STORE_NAME,
      options: { keyPath: "key" },
    },
  ],
  version: WORKBENCH_DRAFT_DATABASE_VERSION,
});

export default workbenchDraftStorage;
