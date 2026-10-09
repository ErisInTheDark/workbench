/* No production exports. Protect tool table ordering (free tools trail in either direction) and the per-thread tool waste estimate. */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchStatsTools } from "./workbench-stats-tools-contract.ts";
import { statsToolValueRows, summariseStatsTools } from "./workbench-stats-tool-value.ts";

const row = (tool: string, calls: number, threads: number, specTokens: number | null, docsTokens = 0) => ({
  buckets: [calls], bucketThreads: [], calls, docsTokens, failed: 0, specTokens, threads, tool,
});
const tools: WorkbenchStatsTools = {
  bucketStarts: [0],
  catalogue: { docsTokens: 40, specTokens: 400, tools: 4 },
  threadCount: 10,
  threads: [],
  workbench: [
    row("shell", 900, 10, 200, 40),
    row("git_add", 0, 0, 70),
    row("subagent_queue", 0, 0, 170),
    row("toc", 9, 5, 60),
    row("retired_tool", 3, 1, null),
  ],
};
const order = (key: "tool" | "calls" | "cost" | "value", descending: boolean) =>
  statsToolValueRows(tools, { key, descending }).map(({ tool }) => tool);

test("value ordering puts the costliest unused tools first and tools with no prompt cost last in both directions", () => {
  assert.deepEqual(order("value", false), ["subagent_queue", "git_add", "toc", "shell", "retired_tool"]);
  assert.deepEqual(order("value", true), ["shell", "toc", "subagent_queue", "git_add", "retired_tool"]);
  assert.deepEqual(order("calls", true).slice(0, 2), ["shell", "toc"]);
  assert.deepEqual(order("tool", false)[0], "git_add");
});

test("waste per thread charges each served tool by the share of active threads that never called it", () => {
  const summary = summariseStatsTools(tools);
  assert.equal(summary.idle, 2);
  // shell used by every thread; toc by half; the idle two by none. The retired tool carries no cost.
  assert.equal(summary.wastePerThread, 0 + 70 + 170 + 60 * 0.5);
  assert.equal(summariseStatsTools({ ...tools, threadCount: 0 }).wastePerThread, null);
});
