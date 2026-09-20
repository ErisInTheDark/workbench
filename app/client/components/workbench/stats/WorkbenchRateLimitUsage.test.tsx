/*
 * No production exports. Tests protect real nullable rate-window rendering and identity labels. Keywords: stats, rate limits, test.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchRateLimitUsage from "./WorkbenchRateLimitUsage.tsx";

test("the current snapshot does not resurrect an older secondary rate-limit series", () => {
  const stats = {
    rateLimits: [{
      harness: "codex",
      limitId: "codex",
      limitName: null,
      samples: [
        {
          observedAt: Date.UTC(2026, 8, 4),
          primary: { durationMinutes: 10_080, resetsAt: null, usedPercent: 40 },
          secondary: { durationMinutes: 300, resetsAt: null, usedPercent: 12 },
        },
        {
          observedAt: Date.UTC(2026, 8, 5),
          primary: { durationMinutes: 10_080, resetsAt: null, usedPercent: 45 },
          secondary: null,
          tertiary: { durationMinutes: 43_200, resetsAt: null, usedPercent: 20 },
        },
      ],
    }],
  } satisfies Pick<WorkbenchStatsResponse, "rateLimits">;
  const html = renderToStaticMarkup(createElement(WorkbenchRateLimitUsage, { stats }));
  assert.match(html, />Codex</u);
  assert.match(html, /Weekly/u);
  assert.doesNotMatch(html, /Secondary/u);
  assert.match(html, /Monthly/u);
  assert.doesNotMatch(html, /Codex · codex/iu);
});
