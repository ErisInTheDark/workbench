/*
 * Exports:
 * - No production exports; Node tests protect blocked task-status tone from live Git arc state. Keywords: thread, task, status, blocked, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadStatusCommandItem from "./ThreadStatusCommandItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

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
