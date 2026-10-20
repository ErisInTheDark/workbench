/*
 * Exports: none. Tests protect display priority transitions and durable order clone ownership.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadDraftSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadDisplayController, { setWorkbenchThreadEntryPriority } from "./WorkbenchThreadDisplayController";
import { projectWorkbenchThreadDraft } from "./WorkbenchThreadDraftStore";
import { parseWorkbenchThreadStateEntry } from "./workbench-thread-state-record";

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

test("display priority pins or unpins unsettled threads and drafts but never settled ones", () => {
  const metadata = (next: ReturnType<typeof setWorkbenchThreadEntryPriority>) =>
    next && next.entryKind !== "subagent" ? next.metadata : null;
  assert.deepEqual(metadata(setWorkbenchThreadEntryPriority(entry, "pinned")), { archived: false, pinned: true, snoozed: false });
  const providerEntry = (settled: boolean) => parseWorkbenchThreadStateEntry({
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Thread",
  });
  assert.deepEqual(metadata(setWorkbenchThreadEntryPriority(providerEntry(false), "main")), { archived: false, pinned: false, snoozed: false });
  assert.equal(setWorkbenchThreadEntryPriority(providerEntry(true), "main"), null);
});

test("display owner clone can replace order without changing its source", () => {
  const relation = { above: [], below: [] };
  const owner = new WorkbenchThreadDisplayController({ pinned: { "draft:key": relation } });
  const clone = owner.clone();
  clone.displayOrder = { snoozed: { "draft:key": relation } };
  assert.deepEqual(owner.displayOrder, { pinned: { "draft:key": relation } });
  assert.deepEqual(clone.displayOrder, { snoozed: { "draft:key": relation } });
});
