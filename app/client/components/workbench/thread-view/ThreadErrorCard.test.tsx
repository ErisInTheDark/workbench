/*
 * No production exports. Regression wards protect thread-error presentation from the lifecycle that owns it. Keywords: thread, thread error, provider failure, card.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import ThreadErrorCard from "./ThreadErrorCard";

const turnId = WorkbenchTurnIdSchema.parse("turn");

test("a provider-failed thread renders its thread error as plain text", () => {
  const html = renderToStaticMarkup(createElement(ThreadErrorCard, {
    lifecycle: { kind: "needsAttention", reason: "providerFailed", settled: false, turnId, error: "provider failed <before> recovery" },
  }));

  assert.match(html, /data-thread-error-card="true"/u);
  assert.match(html, /provider failed &lt;before&gt; recovery/u);
});

test("any other lifecycle shows no thread error", () => {
  for (const lifecycle of [
    null,
    { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    { kind: "needsAttention", reason: "interrupted", settled: false, turnId },
    { kind: "working", reason: "acceptedIntent", agent: { agentStatus: "working", turnId }, settled: false },
  ] satisfies (WorkbenchThreadLifecycle | null)[]) {
    assert.equal(renderToStaticMarkup(createElement(ThreadErrorCard, { lifecycle })), "");
  }
});
