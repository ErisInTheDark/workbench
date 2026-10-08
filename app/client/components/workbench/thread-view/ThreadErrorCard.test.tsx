/*
 * No production exports. Regression wards protect current system-error presentation without reviving stale turn failures. Keywords: thread, system error, turn error, card.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import ThreadErrorCard from "./ThreadErrorCard";

function turn(id: string, message: string | null): Turn {
  return {
    completedAt: 2,
    durationMs: 1,
    error: message
      ? { additionalDetails: null, codexErrorInfo: null, misalignment: null, message }
      : null,
    id,
    items: [],
    itemsView: "full",
    startedAt: 1,
    status: message ? "failed" : "completed",
  };
}

test("current system errors render the provider turn message as plain text", () => {
  const html = renderToStaticMarkup(createElement(ThreadErrorCard, {
    status: "systemError",
    lastTurn: turn("failed", "provider failed <before> recovery"),
  }));

  assert.match(html, /data-thread-error-card="true"/u);
  assert.match(html, /provider failed &lt;before&gt; recovery/u);
});

test("older turn failures do not leave a stale current-error card", () => {
  const html = renderToStaticMarkup(createElement(ThreadErrorCard, {
    status: "systemError",
    lastTurn: [turn("failed", "old failure"), turn("recovered", null)].at(-1)!,
  }));

  assert.equal(html, "");
});
