/*
 * Exports:
 * - No production exports; Node tests protect successful and in-progress task-status row wording, icons, and colors. Keywords: thread, task, status, completed, blocked, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadStatusCommandItem from "./ThreadStatusCommandItem";

test("task status rows use completed and blocked lifecycle visuals", () => {
  const completed = renderToStaticMarkup(createElement(ThreadStatusCommandItem, {
    outcome: "completed",
    status: "completed",
  }));
  assert.match(completed, /Task completed/u);
  assert.match(completed, /text-emerald-600 dark:text-emerald-300/u);
  assert.match(completed, /m9 12 2 2 4-4/u);

  const blocked = renderToStaticMarkup(createElement(ThreadStatusCommandItem, {
    outcome: "completed",
    status: "blocked",
  }));
  assert.match(blocked, /Task blocked/u);
  assert.match(blocked, /text-amber-600 dark:text-amber-300/u);
  assert.match(blocked, /M9\.09 9a3 3 0 0 1 5\.83 1c0 2-3 3-3 3/u);
});

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
