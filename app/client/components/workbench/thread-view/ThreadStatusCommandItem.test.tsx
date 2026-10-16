/*
 * Exports:
 * - No production exports; protect task-status failure details and live blocked status tone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadStatusCommandItem from "./ThreadStatusCommandItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

test("failed task status updates expose the rejection reason instead of success", () => {
  for (const status of ["completed", "blocked"] as const) {
    const output = renderToStaticMarkup(createElement(ThreadStatusCommandItem, {
      outcome: "failed", status, failureText: "Unsettled child mimi must be settled first.",
    }));
    assert.match(output, /Unsettled child mimi must be settled first\./);
    assert.doesNotMatch(output, /Task completed|Task blocked/);
  }
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
