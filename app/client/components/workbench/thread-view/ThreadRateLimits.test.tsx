/*
 * No exports. Tests protect three-window account quota rendering and untouched-window resets.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import ThreadRateLimits from "./ThreadRateLimits.tsx";

test("renders rolling, weekly, and monthly quota windows together", () => {
  const html = renderToStaticMarkup(createElement(ThreadRateLimits, {
    harness: "opencode",
    rateLimits: {
      credits: null,
      individualLimit: null,
      limitId: "opencode-go",
      limitName: "OpenCode Go",
      planType: "go",
      primary: { resetsAt: null, usedPercent: 12, windowDurationMins: 300 },
      rateLimitReachedType: null,
      secondary: { resetsAt: null, usedPercent: 34, windowDurationMins: 10_080 },
      spendControlReached: null,
      tertiary: { resetsAt: null, usedPercent: 56, windowDurationMins: 43_200 },
    },
  }));
  assert.match(html, /5h/u);
  assert.match(html, /Weekly/u);
  assert.match(html, /Monthly/u);
});

test("an untouched window shows its full allowance without a reset", () => {
  const window = (usedPercent: number) => ({ resetsAt: Date.UTC(2026, 9, 25) / 1_000, usedPercent, windowDurationMins: 10_080 });
  const render = (usedPercent: number) => renderToStaticMarkup(createElement(ThreadRateLimits, {
    harness: "codex",
    rateLimits: {
      credits: null, individualLimit: null, limitId: "codex", limitName: null, planType: "pro",
      primary: window(usedPercent), rateLimitReachedType: null, secondary: null, spendControlReached: null, tertiary: null,
    },
  }));
  const untouched = render(0);
  assert.match(untouched, /100%/u);
  assert.doesNotMatch(untouched, /Oct/u);
  assert.match(render(20), /Oct/u);
});
