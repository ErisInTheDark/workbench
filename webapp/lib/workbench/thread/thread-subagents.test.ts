/*
 * Exports:
 * - No production exports; Node tests cover durable parent/child identity, metadata-first labels, and stable colors. Keywords: thread, subagent, metadata, label, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentSummary } from "../../types.ts";
import {
  getNextSubagentHydrationBatch,
  getSubagentPollingBatch,
  getSubagentSummary,
  getSubagentHarness,
  getSubagentThreadIds,
  filterSubagentsByParentThreadId,
  filterSubagentThreadSummaries,
  mergeWorkbenchSubagentSummaries,
  reconcileWorkbenchSubagentPage,
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

test("orders activity deterministically and folds stale non-active children", () => {
  const now = 60 * 60_000;
  const active = { ...subagent, activityStatus: "active" as const, lastActivityAt: 1, threadId: "active" };
  const recentInactive = { ...subagent, lastActivityAt: now - 30 * 60_000, threadId: "recent" };
  const staleInactive = { ...subagent, lastActivityAt: now - 30 * 60_000 - 1, threadId: "stale" };
  const staleUnknown = { ...staleInactive, activityStatus: "unknown" as const, threadId: "unknown" };
  assert.deepEqual(
    sortWorkbenchSubagents([recentInactive, staleInactive, active, staleUnknown]).map(({ threadId }) => threadId),
    ["active", "unknown", "recent", "stale"],
  );
  const layout = getSubagentTabLayout([recentInactive, staleInactive, active, staleUnknown], { now });
  assert.deepEqual(layout.visible.map(({ threadId }) => threadId), ["active", "recent"]);
  assert.deepEqual(layout.collapsed.map(({ threadId }) => threadId), ["unknown", "stale"]);
  assert.deepEqual(
    getSubagentTabLayout([staleInactive], { now, revealedThreadIds: new Set(["stale"]) }).visible.map(({ threadId }) => threadId),
    ["stale"],
  );
  const pinnedLayout = getSubagentTabLayout(
    [recentInactive, staleInactive, active, staleUnknown],
    { now, pinnedThreadIds: ["stale", "active"] },
  );
  assert.deepEqual(pinnedLayout.visible.map(({ threadId }) => threadId), ["stale", "active", "recent"]);
  assert.deepEqual(pinnedLayout.collapsed.map(({ threadId }) => threadId), ["unknown"]);
});

test("caps hydration and rotates polling through fair four-thread batches", () => {
  const ids = ["one", "two", "three", "four", "five", "six"];
  assert.deepEqual(getNextSubagentHydrationBatch({
    loadedThreadIds: new Set(["one"]),
    loadingThreadIds: new Set(["two"]),
    threadIds: ids,
  }), ["three", "four", "five", "six"]);
  const first = getSubagentPollingBatch(ids, 0);
  assert.deepEqual(first, { nextCursor: 4, threadIds: ["one", "two", "three", "four"] });
  assert.deepEqual(getSubagentPollingBatch(ids, first.nextCursor), {
    nextCursor: 2,
    threadIds: ["five", "six", "one", "two"],
  });
});
