/* No production exports. Tests protect the focused v7 prompt-store migration. */
import assert from "node:assert/strict";
import test from "node:test";
import { upgradeWorkbenchDraftStorage } from "./workbench-draft-storage";

test("v7 preserves existing-thread drafts and removes only the saved-message shelf", () => {
  const names = new Set(["drafts", "threadQuestionnaireDrafts", "threadComposerDrafts", "threadSavedComposerDrafts"]);
  const deleted: string[] = [];
  upgradeWorkbenchDraftStorage({ deleteObjectStore: (name) => { deleted.push(name); names.delete(name); return {} as IDBObjectStore }, objectStoreNames: { contains: (name) => names.has(name) } as DOMStringList }, 5);
  assert.deepEqual(deleted, ["threadSavedComposerDrafts"]);
  assert.deepEqual([...names], ["drafts", "threadQuestionnaireDrafts", "threadComposerDrafts"]);
});
