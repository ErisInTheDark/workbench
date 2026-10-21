/* No production exports. Protect `wb stats tools` scoping (cwd project vs all projects), ordering, and figures shared with the stats view. */
import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import type { WorkbenchStatsReadRequest } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchToolStatsCommandController from "./WorkbenchToolStatsCommandController";

const row = (tool: string, calls: number, threads: number, specTokens: number | null, docsTokens = 0) => ({
  buckets: [calls], bucketThreads: [], calls, docsTokens, failed: 0, specTokens, threads, tool,
});
const section = {
  ...EMPTY_WORKBENCH_STATS_SECTIONS.tools,
  tools: {
    bucketStarts: [0], catalogue: { docsTokens: 40, specTokens: 400, tools: 3 }, threadCount: 10, threads: [],
    workbench: [row("shell", 900, 10, 200, 40), row("git_add", 0, 0, 70), row("toc", 9, 5, 60)],
  },
};

function controller() {
  const reads: Array<Omit<WorkbenchStatsReadRequest, "section">> = [];
  return {
    reads,
    controller: new WorkbenchToolStatsCommandController({
      resolveProject: async () => ({ id: "project-id", name: "workbench" }),
      read: async (request) => { reads.push(request); return section; },
    }),
  };
}

const tools = (text: string) => text.split("\n").filter((line) => /^\s+\d/u.test(line)).map((line) => line.trim().split(/\s+/u).at(-1));

test("tool stats read the cwd project by default, every project when asked, and rank lowest value first", async () => {
  const { controller: tool, reads } = controller();
  const text = await (await tool.execute({ cwd: "/repo" }, new AbortController().signal)).text();
  assert.deepEqual(reads[0], { projectIds: ["project-id"], range: "7d" });
  assert.match(text, /^7d · workbench · 909 wb tool calls in 10 threads$/mu);
  // The same waste formula the stats view shows: git_add unused by all, toc by half.
  assert.match(text, /Tool waste per thread ≈100 tokens/u);
  assert.deepEqual(tools(text), ["git_add", "toc", "shell"]);

  const everywhere = await (await tool.execute({ allProjects: true, cwd: "/repo", sort: "calls", descending: true }, new AbortController().signal)).text();
  assert.deepEqual(reads[1], { projectIds: null, range: "7d" });
  assert.deepEqual(tools(everywhere), ["shell", "toc", "git_add"]);
});

test("invalid arguments answer 400 without reading", async () => {
  const { controller: tool, reads } = controller();
  assert.equal((await tool.execute({ cwd: "/repo", sort: "vibes" }, new AbortController().signal)).status, 400);
  assert.equal(reads.length, 0);
});
