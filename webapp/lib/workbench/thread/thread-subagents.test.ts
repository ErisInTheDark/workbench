/*
 * Exports:
 * - No production exports; Node tests cover durable child IDs, metadata-first labels, and stable colors. Keywords: thread, subagent, metadata, label, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchSubagentSummary } from "../../types.ts";
import {
  getSubagentSummary,
  getSubagentHarness,
  getSubagentThreadIds,
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
