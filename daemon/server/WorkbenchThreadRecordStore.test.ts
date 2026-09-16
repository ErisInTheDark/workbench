/*
 * Exports: none. Tests protect canonical record membership and clone isolation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadDraftSchema } from "workbench-shared/workbench/thread/thread-state";
import { projectWorkbenchThreadDraft } from "./WorkbenchThreadDraftStore";
import WorkbenchThreadRecordStore from "./WorkbenchThreadRecordStore";

test("record store clones membership without sharing later mutations", () => {
  const draft = WorkbenchThreadDraftSchema.parse({
    attachments: [],
    clientUpdatedAt: 1,
    composerSettings: {
      agentPath: null,
      agentSource: null,
      harness: "codex",
      model: "",
      reasoningEffort: null,
      serviceTier: null,
    },
    createdAt: 1,
    draftId: "eb83014c-5b6c-4bd0-963b-27c5641a0f93",
    profileId: null,
    projectId: ProjectIdSchema.parse("project"),
    prompt: "draft",
    updatedAt: 1,
  });
  const entry = projectWorkbenchThreadDraft(draft);
  const store = new WorkbenchThreadRecordStore([["draft:key", entry]]);
  const clone = store.clone();

  store.delete("draft:key");
  assert.equal(store.get("draft:key"), undefined);
  assert.equal(clone.get("draft:key"), entry);
  assert.deepEqual([...clone.snapshot()], [["draft:key", entry]]);
});
