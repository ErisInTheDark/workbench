/*
 * Exports:
 * - No production exports; Node tests protect in-progress task-status row wording. Keywords: thread, task, status, completed, blocked, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadStatusCommandItem from "./ThreadStatusCommandItem";

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
