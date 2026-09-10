/*
 * Exports: none. Node tests cover durable identity, labels, and stable hues.
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
  getThreadAgentAccentHue,
  getThreadAgentLabelParts,
  getThreadAgentTabLabel,
  getSubagentTabLayout,
  sortWorkbenchSubagents,
} from "./thread-subagents.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "parent": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"),
  },
};

const subagent: WorkbenchSubagentSummary = {
  activityStatus: "inactive",
  createdAt: 1,
  cwd: "C:/workspace",
  directSubagentIndex: 0,
  harness: "codex",
  lastActivityAt: 1,
  name: "Mimi",
  parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"],
  profileId: "profile",
  profileName: "Lily INFINITE",
  projectId: fixtureIdentityValues.ProjectId["project"],
  threadId: fixtureIdentityValues.WorkbenchThreadId["child"],
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
  const reusedName = { ...subagent, lifecycle: { kind: "completed" as const, reason: "userCompleted" as const, settled: true }, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("older-child") };
  const targets = [
    { kind: "id" as const, value: "child" },
    { kind: "id" as const, value: "unknown-child" },
    { kind: "name" as const, value: "MIMI" },
    { kind: "name" as const, value: "Missing" },
  ];

  assert.deepEqual(resolveWorkbenchSubagentCommandTargets([subagent], targets), [
    { fallbackName: null, subagent, targetKey: "id:child", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") },
    { fallbackName: null, subagent: null, targetKey: "id:unknown-child", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unknown-child") },
    { fallbackName: "MIMI", subagent, targetKey: "name:mimi", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") },
    { fallbackName: "Missing", subagent: null, targetKey: "name:missing", threadId: null },
  ]);
  assert.deepEqual(resolveWorkbenchSubagentCommandTargets([subagent, reusedName], [targets[2]!]), [
    { fallbackName: "MIMI", subagent: null, targetKey: "name:mimi", threadId: null },
  ]);
  assert.equal(getWorkbenchSubagentCommandTargetKey({ kind: "id", value: "Case-Sensitive" }), "id:Case-Sensitive");
});

test("filters durable summaries to direct children without changing their order", () => {
  const earlierChild = { ...subagent, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("earlier-child") };
  const siblingChild = { ...subagent, parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("other-parent"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("sibling-child") };
  const laterChild = { ...subagent, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("later-child") };

  assert.deepEqual(
    filterSubagentsByParentThreadId([earlierChild, siblingChild, laterChild], "parent"),
    [earlierChild, laterChild],
  );
});

test("merges active-project root summaries by durable child identity", () => {
  const earlier = { ...subagent, createdAt: 1, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("earlier") };
  const olderDuplicate = { ...subagent, createdAt: 2, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("duplicate"), title: "Older", updatedAt: 2 };
  const newerDuplicate = { ...olderDuplicate, title: "Newer", updatedAt: 3 };
  const later = { ...subagent, createdAt: 4, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("later") };

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
  const firstPageSubagent = { ...subagent, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("first-page") };
  const olderSubagent = { ...subagent, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("older-page") };
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
    getThreadAgentAccentHue(subagent),
    getThreadAgentAccentHue({ directSubagentIndex: 0, parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"] }),
  );
});

test("orders lifecycle deterministically and folds only settled children", () => {
  const working = { ...subagent, lifecycle: { agent: { agentStatus: "working" as const }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const }, lastActivityAt: 1, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("working") };
  const attention = { ...subagent, lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const }, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("attention") };
  const terminal = { ...subagent, lifecycle: { kind: "completed" as const, reason: "userCompleted" as const, settled: false }, pinned: true, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("terminal") };
  const settled = { ...terminal, lifecycle: { ...terminal.lifecycle, settled: true }, pinned: false, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("settled") };
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
