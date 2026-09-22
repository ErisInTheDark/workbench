/*
 * No production exports. Tests protect context compaction availability across provider and Workbench lifecycle state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadPayload } from "workbench-shared/types";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import ThreadContextStatus from "./ThreadContextStatus";

const thread: ThreadPayload = {
  agentNickname: null,
  agentPath: null,
  agentRole: null,
  createdAt: 1,
  cwd: "C:/project",
  harness: "codex",
  id: WorkbenchThreadIdSchema.parse("thread"),
  isDraft: false,
  model: null,
  name: "Thread",
  path: null,
  preview: "",
  reasoningEffort: null,
  serviceTier: null,
  source: "codex",
  status: "active",
  tokenUsage: null,
  turnHistory: [],
  turns: [],
  updatedAt: 1,
};

function render(lifecycle?: WorkbenchThreadLifecycle, snoozed = false) {
  return renderToStaticMarkup(createElement(ThreadContextStatus, {
    lifecycle,
    onCompactThread: async () => thread,
    snoozed,
    thread,
  }));
}

test("interrupted Workbench state overrides stale active provider status for context compaction", () => {
  const stopped = render({
    kind: "stopped",
    reason: "providerInterrupted",
    settled: false,
    turnId: WorkbenchTurnIdSchema.parse("turn"),
  });
  assert.doesNotMatch(stopped, /disabled=""/u);
  assert.match(stopped, /aria-label="Compact thread context"/u);

  const working = render({
    agent: { agentStatus: "working" },
    kind: "working",
    reason: "acceptedIntent",
    settled: false,
  }, true);
  assert.match(working, /disabled=""/u);
  assert.match(working, /aria-label="Compact is unavailable while the thread is active"/u);

  const pendingInput: WorkbenchThreadLifecycle = {
    kind: "needsAttention",
    reason: "pendingInput",
    requestKey: "questionnaire",
    settled: false,
  };
  const snoozed = render(pendingInput, true);
  assert.doesNotMatch(snoozed, /disabled=""/u);
  assert.match(snoozed, /aria-label="Compact thread context"/u);

  const live = render(pendingInput);
  assert.match(live, /disabled=""/u);

  assert.match(render(), /disabled=""/u);
});
