/*
 * Exports: none. Tests protect project transaction staging across durable fact owners.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadDraftSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchProjectThreadState from "./WorkbenchProjectThreadState";
import { projectWorkbenchThreadDraft } from "./WorkbenchThreadDraftStore";

test("project staging clones record, draft, profile, and display ownership", () => {
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
  const key = `draft:${draft.draftId}`;
  const displayOrder = { pinned: { [key]: { above: [], below: [] } } };
  const state = new WorkbenchProjectThreadState({
    displayOrder,
    drafts: [[draft.draftId, draft]],
    entries: [[key, projectWorkbenchThreadDraft(draft)]],
    newThreadProfile: { kind: "custom", settings: draft.composerSettings },
  });
  const staged = state.stage();

  staged.drafts.delete(draft.draftId);
  staged.entries.delete(key);
  staged.displayOrder = {};
  staged.newThreadProfile = null;

  assert.equal(state.drafts.get(draft.draftId), draft);
  assert.ok(state.entries.has(key));
  assert.deepEqual(state.displayOrder, displayOrder);
  assert.equal(state.newThreadProfile?.kind, "custom");
});
