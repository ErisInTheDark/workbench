/*
 * Exports:
 * - No production exports; Node tests cover durable parent/child identity, metadata-first labels, and stable colors. Keywords: thread, subagent, metadata, label, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import {
  getNextSubagentHydrationBatch,
  getSubagentSummary,
  getSubagentHarness,
  getSubagentThreadIds,
  getWorkbenchSubagentCommandTargetKey,
  filterSubagentsByParentThreadId,
  filterSubagentThreadSummaries,
  mergeWorkbenchSubagentSummaries,
  reconcileWorkbenchSubagentPage,
  resolveWorkbenchSubagentCommandTargets,
  getThreadAgentAccentColor,
  getThreadAgentLabelParts,
  getThreadAgentTabLabel,
  getSubagentTabLayout,
  sortWorkbenchSubagents,
} from "./thread-subagents.ts";

const subagent: WorkbenchSubagentSummary = {
  activityStatus: "inactive",
  createdAt: 1,
  cwd: "C:/workspace",
  directSubagentIndex: 0,
  harness: "codex",
  lastActivityAt: 1,
  name: "Mimi",
  parentThreadId: "parent",
  profileId: "profile",
  profileName: "Lily INFINITE",
  projectId: "project",
  threadId: "child",
  title: "Inspect code",
  updatedAt: 1,
};

test("derives child identity exclusively from durable summaries", () => {
  const summaries = [subagent];
  assert.deepEqual(getSubagentThreadIds(summaries), ["child"]);
  assert.equal(getSubagentSummary(summaries, "child"), subagent);
  assert.equal(getSubagentSummary(summaries, "other"), null);
  assert.equal(getSubagentHarness(summaries, "child", "codex"), "codex");
  assert.equal(getSubagentHarness([{ ...subagent, harness: "opencode" }], "child", "codex"), "opencode");
  assert.equal(getSubagentHarness(summaries, "other", "copilot"), "copilot");
  assert.deepEqual(
    filterSubagentThreadSummaries([
      { id: "parent" },
      { id: "child" },
    ] as never, new Set(["child"])).map(({ id }) => id),
    ["parent"],
  );
});

test("resolves command selectors without guessing reused subagent names", () => {
  const reusedName = { ...subagent, lifecycle: { kind: "completed" as const, reason: "userCompleted" as const, settled: true }, threadId: "older-child" };
  const targets = [
    { kind: "id" as const, value: "child" },
    { kind: "id" as const, value: "unknown-child" },
    { kind: "name" as const, value: "MIMI" },
    { kind: "name" as const, value: "Missing" },
  ];

  assert.deepEqual(resolveWorkbenchSubagentCommandTargets([subagent], targets), [
    { fallbackName: null, subagent, targetKey: "id:child", threadId: "child" },
    { fallbackName: null, subagent: null, targetKey: "id:unknown-child", threadId: "unknown-child" },
    { fallbackName: "MIMI", subagent, targetKey: "name:mimi", threadId: "child" },
    { fallbackName: "Missing", subagent: null, targetKey: "name:missing", threadId: null },
  ]);
  assert.deepEqual(resolveWorkbenchSubagentCommandTargets([subagent, reusedName], [targets[2]!]), [
    { fallbackName: "MIMI", subagent: null, targetKey: "name:mimi", threadId: null },
  ]);
  assert.equal(getWorkbenchSubagentCommandTargetKey({ kind: "id", value: "Case-Sensitive" }), "id:Case-Sensitive");
});

test("filters durable summaries to direct children without changing their order", () => {
  const earlierChild = { ...subagent, threadId: "earlier-child" };
  const siblingChild = { ...subagent, parentThreadId: "other-parent", threadId: "sibling-child" };
  const laterChild = { ...subagent, threadId: "later-child" };

  assert.deepEqual(
    filterSubagentsByParentThreadId([earlierChild, siblingChild, laterChild], "parent"),
    [earlierChild, laterChild],
  );
});

test("merges active-project root summaries by durable child identity", () => {
  const earlier = { ...subagent, createdAt: 1, threadId: "earlier" };
  const olderDuplicate = { ...subagent, createdAt: 2, threadId: "duplicate", title: "Older", updatedAt: 2 };
  const newerDuplicate = { ...olderDuplicate, title: "Newer", updatedAt: 3 };
  const later = { ...subagent, createdAt: 4, threadId: "later" };

  const merged = mergeWorkbenchSubagentSummaries([
    [olderDuplicate, later],
    [earlier, newerDuplicate],
  ]);

  assert.deepEqual(merged.map(({ threadId }) => threadId), ["earlier", "duplicate", "later"]);
  assert.equal(merged[1]?.title, "Newer");
  assert.deepEqual(
    filterSubagentThreadSummaries([
      { id: "root" },
      { id: "earlier" },
      { id: "duplicate" },
      { id: "later" },
    ] as never, new Set(getSubagentThreadIds(merged))).map(({ id }) => id),
    ["root"],
  );
});

test("reuses subagent page state when metadata polling has no visible change", () => {
  const fallback = [subagent];
  assert.equal(reconcileWorkbenchSubagentPage({
    current: null,
    fallback,
    pageSubagents: [{ ...subagent }],
    preserveAdditionalPages: false,
  }), null);

  const current = [{ ...subagent }];
  assert.equal(reconcileWorkbenchSubagentPage({
    current,
    fallback: [],
    pageSubagents: [{ ...subagent }],
    preserveAdditionalPages: false,
  }), current);
});

test("replaces subagent page state when polled metadata changes", () => {
  const current = [{ ...subagent }];
  const reconciled = reconcileWorkbenchSubagentPage({
    current,
    fallback: [],
    pageSubagents: [{ ...subagent, activityStatus: "active", updatedAt: 2 }],
    preserveAdditionalPages: false,
  });

  assert.notEqual(reconciled, current);
  assert.deepEqual(reconciled, [{ ...subagent, activityStatus: "active", updatedAt: 2 }]);
});

test("preserves loaded older subagents when refreshing the first page", () => {
  const firstPageSubagent = { ...subagent, threadId: "first-page" };
  const olderSubagent = { ...subagent, threadId: "older-page" };
  const current = [firstPageSubagent, olderSubagent];
  assert.equal(reconcileWorkbenchSubagentPage({
    current,
    fallback: [],
    pageSubagents: [{ ...firstPageSubagent }],
    preserveAdditionalPages: true,
  }), current);

  assert.deepEqual(reconcileWorkbenchSubagentPage({
    current,
    fallback: [],
    pageSubagents: [{ ...firstPageSubagent, title: "Updated" }],
    preserveAdditionalPages: true,
  }), [
    { ...firstPageSubagent, title: "Updated" },
    olderSubagent,
  ]);
});

test("prefers the durable subagent name while preserving the agent role", () => {
  const thread = { agentNickname: "native nickname", agentRole: "reviewer" };
  assert.deepEqual(getThreadAgentLabelParts(thread, subagent), {
    nickname: "Mimi",
    role: "reviewer",
    text: "Mimi (reviewer)",
  });
  assert.equal(getThreadAgentTabLabel(thread, subagent), "Mimi (reviewer)");
  assert.equal(
    getThreadAgentAccentColor(subagent),
    getThreadAgentAccentColor({ directSubagentIndex: 0, parentThreadId: "parent" }),
  );
});

test("orders lifecycle deterministically and folds only settled children", () => {
  const working = { ...subagent, lifecycle: { agent: { agentStatus: "working" as const }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const }, lastActivityAt: 1, threadId: "working" };
  const attention = { ...subagent, lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const }, threadId: "attention" };
  const terminal = { ...subagent, lifecycle: { kind: "completed" as const, reason: "userCompleted" as const, settled: false }, pinned: true, threadId: "terminal" };
  const settled = { ...terminal, lifecycle: { ...terminal.lifecycle, settled: true }, pinned: false, threadId: "settled" };
  assert.deepEqual(
    sortWorkbenchSubagents([working, settled, terminal, attention]).map(({ threadId }) => threadId),
    ["attention", "terminal", "working", "settled"],
  );
  const layout = getSubagentTabLayout([working, settled, terminal, attention]);
  assert.deepEqual(layout.visible.map(({ threadId }) => threadId), ["attention", "terminal", "working"]);
  assert.deepEqual(layout.collapsed.map(({ threadId }) => threadId), ["settled"]);
  assert.deepEqual(
    getSubagentTabLayout([settled], { revealedThreadIds: new Set(["settled"]) }).visible.map(({ threadId }) => threadId),
    ["settled"],
  );
});

test("caps body hydration to four threads", () => {
  const ids = ["one", "two", "three", "four", "five", "six"];
  assert.deepEqual(getNextSubagentHydrationBatch({
    loadedThreadIds: new Set(["one"]),
    loadingThreadIds: new Set(["two"]),
    threadIds: ids,
  }), ["three", "four", "five", "six"]);
});
