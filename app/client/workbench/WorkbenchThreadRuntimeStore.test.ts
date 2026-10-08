/*
 * Exports:
 * - no exports: semantic tests for stable route-owned thread runtime publication.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadPayload, WorkbenchThreadRuntimeSnapshot } from "workbench-shared/types";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadRuntimeStore from "./WorkbenchThreadRuntimeStore";

function thread(id: string): Extract<ThreadPayload, { isDraft: false }> {
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    createdAt: 1,
    cwd: "C:/project",
    harness: "codex",
    id: WorkbenchThreadIdSchema.parse(id),
    isDraft: false,
    model: "model",
    name: id,
    nextPageCursor: null,
    path: null,
    preview: id,
    reasoningEffort: null,
    serviceTier: null,
    source: "workbench",
    status: "idle",
    tokenUsage: null,
    turnHistory: [],
    turns: [],
    updatedAt: 1,
  };
}

function snapshot(currentThread = thread("selected")): WorkbenchThreadRuntimeSnapshot {
  return {
    currentThread,
    currentThreadId: currentThread.id,
    subagents: [],
    threadDocuments: {
      documentsByKey: {},
      keysByThreadId: {},
      selectedThreadKey: "",
    },
    threads: [],
    threadsError: "",
  };
}

test("thread runtime publishes meaningful background state without replacing route selection", () => {
  const initial = snapshot();
  const runtime = WorkbenchThreadRuntimeStore(initial);
  let notifications = 0;
  runtime.subscribe(() => { notifications += 1; });

  runtime.accept({ ...initial });
  assert.equal(runtime.getSnapshot(), initial);
  assert.equal(notifications, 0);

  const backgroundDocuments = {
    documentsByKey: { "codex:background": thread("background") },
    keysByThreadId: { background: "codex:background" },
    selectedThreadKey: "codex:selected",
  };
  runtime.accept({
    ...initial,
    threadDocuments: backgroundDocuments,
  });

  assert.equal(runtime.getSnapshot().currentThread?.id, "selected");
  assert.equal(runtime.getSnapshot().threadDocuments, backgroundDocuments);
  assert.equal(notifications, 1);
});

test("an equivalent selected thread retains the complete runtime snapshot", () => {
  const initial = snapshot();
  const runtime = WorkbenchThreadRuntimeStore(initial);
  let notifications = 0;
  runtime.subscribe(() => { notifications += 1; });

  runtime.accept({ ...initial, currentThread: structuredClone(initial.currentThread) });

  assert.equal(runtime.getSnapshot(), initial);
  assert.equal(notifications, 0);
});
