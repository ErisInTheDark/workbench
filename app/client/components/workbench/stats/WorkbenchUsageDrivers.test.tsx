/*
 * No production exports. Tests protect canonical thread links in usage drivers. Keywords: stats, threads, routing, test.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchUsageDrivers from "./WorkbenchUsageDrivers.tsx";

test("top usage threads link through the canonical thread route", () => {
  const stats = {
    models: [],
    topThreads: [{
      costUsd: 1,
      models: ["gpt-5.6-sol"],
      projectId: "project/path",
      providers: ["codex"],
      sharePercent: 75,
      threadId: "thread-id",
      title: "Expensive thread",
      tokens: 100,
    }],
  } satisfies Pick<WorkbenchStatsResponse, "models" | "topThreads">;
  const html = renderToStaticMarkup(createElement(WorkbenchUsageDrivers, {
    global: true,
    onNavigateThread: () => undefined,
    projectNamesById: new Map([["project/path", "Sparkle project"]]),
    stats,
  }));
  assert.match(html, /href="\/project\/path\/@\/thread\/thread-id"/u);
  assert.match(html, /Expensive thread/u);
  assert.match(html, /Sparkle project/u);
  assert.doesNotMatch(html, />project\/path</u);
});
