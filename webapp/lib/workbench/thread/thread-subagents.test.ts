/*
 * Exports:
 * - No production exports; Node tests cover durable parent/child identity, metadata-first labels, and stable colors. Keywords: thread, subagent, metadata, label, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentSummary } from "../../types.ts";
import {
  getSubagentSummary,
  getSubagentHarness,
  getSubagentThreadIds,
  filterSubagentsByParentThreadId,
  filterSubagentThreadSummaries,
  getThreadAgentAccentColor,
  getThreadAgentLabelParts,
  getThreadAgentTabLabel,
} from "./thread-subagents.ts";

const subagent: WorkbenchSubagentSummary = {
  createdAt: 1,
  cwd: "C:/workspace",
  harness: "codex",
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

test("prefers the durable subagent name while preserving the agent role", () => {
  const thread = { agentNickname: "native nickname", agentRole: "reviewer" };
  assert.deepEqual(getThreadAgentLabelParts(thread, subagent), {
    nickname: "Mimi",
    role: "reviewer",
    text: "Mimi (reviewer)",
  });
  assert.equal(getThreadAgentTabLabel(thread, subagent), "Mimi (reviewer)");
  assert.equal(
    getThreadAgentAccentColor(thread, "child", subagent),
    getThreadAgentAccentColor(null, "different fallback", subagent),
  );
});
