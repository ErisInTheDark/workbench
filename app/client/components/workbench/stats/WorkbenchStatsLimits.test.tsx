/*
 * No production exports. Tests protect that only the newest limit snapshot decides which windows are shown, and that gauges show what is left.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsLimits from "./WorkbenchStatsLimits.tsx";

test("the current snapshot does not resurrect an older secondary limit window", () => {
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
          tertiary: null,
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
  const html = renderToStaticMarkup(createElement(WorkbenchStatsLimits, { now: Date.UTC(2026, 8, 5), stats }));
  assert.match(html, />Codex</u);
  assert.match(html, /Weekly/u);
  assert.match(html, /Monthly/u);
  assert.doesNotMatch(html, />5h</u);
});

test("gauges report what is left of each window, not what was used", () => {
  const stats = {
    rateLimits: [{
      harness: "codex", limitId: "codex", limitName: null,
      samples: [{ observedAt: 0, primary: { durationMinutes: 300, resetsAt: null, usedPercent: 30 }, secondary: null, tertiary: null }],
    }],
  } satisfies Pick<WorkbenchStatsResponse, "rateLimits">;
  const html = renderToStaticMarkup(createElement(WorkbenchStatsLimits, { now: 0, stats }));
  assert.match(html, /aria-valuenow="70"/u);
});
