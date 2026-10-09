/*
 * No production exports. Tests protect canonical thread links, project naming, and one colour per model across panels.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";

import { parseWorkbenchRouteFromPath } from "workbench-shared/workbench/navigation/workbench-route";
import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import type { WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { renderWithStats, testStatsScope } from "../stats-test-store";
import WorkbenchStatsBreakdowns from "./WorkbenchStatsBreakdowns.tsx";

const share = { threadCount: 1, unpricedTokens: 0 };
const usage: WorkbenchStatsSectionData<"usage"> = {
  ...EMPTY_WORKBENCH_STATS_SECTIONS.usage,
  models: [
    { ...share, costUsd: 3, inferredModelTokens: 0, model: "gpt-6-sol", provider: "codex", tokens: 60 },
    { ...share, costUsd: 1, inferredModelTokens: 0, model: "claude-opus-5-5", provider: "claude", tokens: 40 },
  ],
  topThreads: [{
    costUsd: 4, daemonId: null, harness: null, models: ["claude-opus-5-5", "gpt-6-sol"], projectId: "project/path", providers: ["claude", "codex"],
    modelShares: [
      { costUsd: 3, model: "gpt-6-sol", provider: "codex", tokens: 60, unpricedTokens: 0 },
      { costUsd: 1, model: "claude-opus-5-5", provider: "claude", tokens: 40, unpricedTokens: 0 },
    ],
    sharePercent: 75, threadId: "thread-id", title: "Expensive thread", tokens: 100, unpricedTokens: 0,
  }],
  usageFilters: { models: ["gpt-6-sol", "claude-opus-5-5"], providers: ["claude", "codex"] },
};

const render = () => renderWithStats(createElement(WorkbenchStatsBreakdowns), { overview: usage, usage }, {
  scope: testStatsScope({ names: new Map([["project/path", "Sparkle project"]]) }),
});

test("top threads link through the canonical thread route and name their project", () => {
  const html = render();
  const href = /href="([^"]+)"/u.exec(html)?.[1];
  assert.ok(href);
  const route = parseWorkbenchRouteFromPath(href);
  assert.equal(route.view, "thread");
  assert.equal(route.threadOwnerProjectId, "project/path");
  assert.match(html, /Expensive thread/u);
  assert.match(html, /Sparkle project/u);
});

test("a model keeps its colour in both the model bars and the thread segments", () => {
  const html = render();
  const hues = [...html.matchAll(/--model-hue:(\d+)/gu)].map(([, hue]) => hue);
  // One bar in the Models panel plus one segment in the thread bar, per model.
  assert.equal(new Set(hues).size, 2);
  for (const hue of new Set(hues)) assert.equal(hues.filter((value) => value === hue).length, 2);
});
