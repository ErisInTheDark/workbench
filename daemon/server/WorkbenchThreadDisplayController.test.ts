/*
 * Exports: none. Tests protect display priority transitions and durable order clone ownership.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadDraftSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadDisplayController, {
  setWorkbenchThreadEntryDisplaySection,
  setWorkbenchThreadEntryPriority,
} from "./WorkbenchThreadDisplayController";
import { projectWorkbenchThreadDraft } from "./WorkbenchThreadDraftStore";

const entry = projectWorkbenchThreadDraft(WorkbenchThreadDraftSchema.parse({
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
}));

test("display owner applies priority semantics and rejects settled draft placement", () => {
  const pinned = setWorkbenchThreadEntryPriority(entry, "pinned");
  const snoozed = setWorkbenchThreadEntryPriority(entry, "snoozed");
  assert.ok(pinned?.entryKind === "draft");
  assert.ok(snoozed?.entryKind === "draft");
  assert.deepEqual(pinned.metadata, {
    archived: false,
    pinned: true,
    snoozed: false,
  });
  assert.deepEqual(snoozed.metadata, {
    archived: false,
    pinned: false,
    snoozed: true,
  });
  assert.equal(setWorkbenchThreadEntryDisplaySection(entry, "settled"), null);
});

test("display owner clone can replace order without changing its source", () => {
  const relation = { above: [], below: [] };
  const owner = new WorkbenchThreadDisplayController({ pinned: { "draft:key": relation } });
  const clone = owner.clone();
  clone.displayOrder = { snoozed: { "draft:key": relation } };
  assert.deepEqual(owner.displayOrder, { pinned: { "draft:key": relation } });
  assert.deepEqual(clone.displayOrder, { snoozed: { "draft:key": relation } });
});
