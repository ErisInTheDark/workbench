/*
 * Exports:
 * - No production exports; Node tests protect in-progress task-status row wording. Keywords: thread, task, status, completed, blocked, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadStatusCommandItem from "./ThreadStatusCommandItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

test("in-progress task status rows use intent wording without failure states", () => {
  const completing = renderToStaticMarkup(createElement(ThreadStatusCommandItem, {
    outcome: "inProgress",
    status: "completed",
  }));
  const blocking = renderToStaticMarkup(createElement(ThreadStatusCommandItem, {
    outcome: "inProgress",
    status: "blocked",
  }));

  assert.match(completing, /Completing task/u);
  assert.match(blocking, /Blocking task/u);
  assert.doesNotMatch(`${completing}${blocking}`, /Failed|Timed out|Declined/u);
});

test("blocked task status rows follow the live Git arc presentation phase", () => {
  const renderBlocked = (hasActiveGitArc: boolean) => renderToStaticMarkup(createElement(
    ThreadGitArcPresentationContext.Provider,
    { value: { harness: "codex", hasActiveGitArc } },
    createElement(ThreadStatusCommandItem, { outcome: "completed", status: "blocked" }),
  ));
  const inactive = renderBlocked(false);
  const active = renderBlocked(true);

  assert.match(inactive, /data-thread-status-tone="needs-attention"/u);
  assert.match(active, /data-thread-status-tone="needs-attention-active"/u);
});
