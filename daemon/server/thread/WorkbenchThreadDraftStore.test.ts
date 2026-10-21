/*
 * Exports: none. Tests protect draft repair, profile derivation, and sidebar projection ownership.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadDraftSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadDraftStore, {
  conformStoredWorkbenchThreadDraft,
} from "./WorkbenchThreadDraftStore";

const projectId = ProjectIdSchema.parse("project");

function draft() {
  return WorkbenchThreadDraftSchema.parse({
    attachments: [],
    clientUpdatedAt: 3,
    composerSettings: {
      agentPath: null,
      agentSource: null,
      harness: "codex",
      model: "model",
      reasoningEffort: null,
      serviceTier: null,
    },
    createdAt: 1,
    draftId: "eb83014c-5b6c-4bd0-963b-27c5641a0f93",
    profileId: null,
    projectId,
    prompt: "\n  first line  \nsecond",
    updatedAt: 2,
  });
}

test("draft owner derives profile and sidebar projection from one draft", () => {
  const store = new WorkbenchThreadDraftStore();
  const value = draft();
  assert.deepEqual(store.profileFromDraft(value), {
    kind: "custom",
    settings: value.composerSettings,
  });
  assert.deepEqual(store.projectEntry(value).title, "first line");
});

test("stored draft repair preserves siblings and canonicalises project identity", () => {
  const value = draft();
  const repaired = conformStoredWorkbenchThreadDraft({
    ...value,
    projectId: "old-project",
    pinned: true,
  }, projectId);
  assert.equal(repaired.success, true);
  if (!repaired.success) return;
  assert.equal(repaired.draft.projectId, projectId);
  assert.equal(repaired.draft.prompt, value.prompt);
  assert.equal(repaired.metadata.pinned, true);
  assert.ok(repaired.repairedPaths.some((path) => path.join(".") === "projectId"));
});
