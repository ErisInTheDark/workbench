/*
 * Keywords: sidebar, actions, questionnaire, settlement, subagent.
 * No exports. Tests protect action authority and primary settlement without pinning rendered text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchProjectThreadSummary, type WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { getThreadRowActions } from "./thread-row-actions";

const stopped: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
  activityAt: 1, title: "Task", entryKind: "thread", identity: { harness: "codex", threadId: "thread" },
  metadata: { archived: false, pinned: false, snoozed: false },
  lifecycle: { kind: "stopped", reason: "providerInterrupted", turnId: "turn", settled: false },
};
const pending: typeof stopped = {
  ...stopped,
  lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "question", turnId: "turn", settled: false },
  pendingQuestionnaire: {
    itemId: "item", requestKey: "question", turnId: "turn",
    request: { id: "question", title: "Choose", summary: "", submitLabel: "Submit", questions: [] },
  },
};

test("stopped sidebar rows settle directly while retaining priority and claim blockers", () => {
  assert.deepEqual(getThreadRowActions(stopped, "main"), { baseAction: "settle", canShiftSettle: false });
  assert.equal(getThreadRowActions(stopped, "snoozed").baseAction, "wake");
  assert.equal(getThreadRowActions({ ...stopped, lifecycle: { kind: "stopped", reason: "providerInterrupted", turnId: "turn", settled: true } }, "settled").baseAction, "restore");
  const claimed = { ...stopped, gitArc: {
    checkpointCommit: "a".repeat(40), claimedPaths: ["owned.ts"], intentName: "work",
    intentDescription: "", phase: "active" as const, proposals: [], updatedAt: "2026-09-08T00:00:00Z",
  } };
  assert.equal(getThreadRowActions(claimed, "main").baseAction, null);
});

test("a sidebar questionnaire offers completion, never the direct-settle shortcut", () => {
  assert.deepEqual(getThreadRowActions(pending, "main"), { baseAction: "complete", canShiftSettle: false });
  assert.deepEqual(getThreadRowActions({ ...pending, waitingFor: "other" }, "main"), { baseAction: "complete", canShiftSettle: false });
  assert.equal(getThreadRowActions({ ...pending, pendingQuestionnaire: null }, "main").baseAction, null);
});

test("pinned summaries preserve questionnaire completion without enabling shift settlement", () => {
  const summary = createWorkbenchProjectThreadSummary("project", [{
    ...pending, metadata: { archived: false, pinned: true, snoozed: false }, waitingFor: "other",
  }], 1);
  assert.deepEqual(getThreadRowActions(summary.pinnedThreads[0]!, "pinned"), { baseAction: "complete", canShiftSettle: false });
});

test("subagent pending input retains its existing action restrictions", () => {
  const { metadata: _metadata, ...common } = pending;
  const subagent: WorkbenchThreadSidebarEntry = {
    ...common, entryKind: "subagent", createdAt: 1, updatedAt: 1, cwd: "C:/workspace",
    directSubagentIndex: 0, name: "child", parentThreadId: "parent", pinned: false,
    profileId: "profile", profileName: "profile", projectId: "project",
  };
  assert.deepEqual(getThreadRowActions(subagent, "main"), { baseAction: null, canShiftSettle: false });
  assert.deepEqual(getThreadRowActions({ ...subagent, lifecycle: stopped.lifecycle }, "main"), { baseAction: "settle", canShiftSettle: false });
});
