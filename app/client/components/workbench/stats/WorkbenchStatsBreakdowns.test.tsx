/*
 * No production exports. Tests protect canonical thread links, project naming, and one colour per model across panels.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { parseWorkbenchRouteFromPath } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchStatsBreakdowns from "./WorkbenchStatsBreakdowns.tsx";

const share = { threadCount: 1, unpricedTokens: 0 };
const stats = {
  models: [
    { ...share, costUsd: 3, inferredModelTokens: 0, model: "gpt-6-sol", provider: "codex", tokens: 60 },
    { ...share, costUsd: 1, inferredModelTokens: 0, model: "claude-opus-5-5", provider: "claude", tokens: 40 },
  ],
  projects: [], providers: [],
  topThreads: [{
    costUsd: 4, models: ["claude-opus-5-5", "gpt-6-sol"], projectId: "project/path", providers: ["claude", "codex"],
    modelShares: [
      { costUsd: 3, model: "gpt-6-sol", provider: "codex", tokens: 60, unpricedTokens: 0 },
      { costUsd: 1, model: "claude-opus-5-5", provider: "claude", tokens: 40, unpricedTokens: 0 },
    ],
    sharePercent: 75, threadId: "thread-id", title: "Expensive thread", tokens: 100, unpricedTokens: 0,
  }],
} as unknown as WorkbenchStatsResponse;

const render = () => renderToStaticMarkup(createElement(WorkbenchStatsBreakdowns, {
  metric: "cost", model: null, provider: null, showProjects: true, stats,
  modelHues: new Map([["gpt-6-sol", 111], ["claude-opus-5-5", 222]]),
  onModelChange: () => undefined, onNavigateThread: () => undefined, onProviderChange: () => undefined,
  projectName: (projectId: string) => projectId === "project/path" ? "Sparkle project" : projectId,
}));

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
  // One bar in the Models panel plus one segment in the thread bar.
  assert.equal(html.match(/--model-hue:111/gu)?.length, 2);
  assert.equal(html.match(/--model-hue:222/gu)?.length, 2);
});
