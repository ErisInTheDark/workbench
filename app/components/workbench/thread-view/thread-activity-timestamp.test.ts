/* No production exports. Tests protect sidebar-owned visible thread activity timestamps. */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadPayload, ThreadSummary } from "workbench-shared/types";
import resolveThreadActivityTimestampMs from "./thread-activity-timestamp.ts";

function summary(id: string, updatedAt: number): ThreadSummary {
  return {
    agentNickname: null,
    agentRole: null,
    createdAt: 1,
    cwd: "C:/repo",
    forkedFromId: null,
    harness: "codex",
    id,
    name: id,
    path: null,
    preview: id,
    source: "appServer",
    status: "idle",
    updatedAt,
  };
}

function payload(id: string, updatedAt: number): ThreadPayload {
  return {
    ...summary(id, updatedAt),
    agentPath: null,
    isDraft: false,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    tokenUsage: null,
    turnHistory: [],
    turns: [],
  };
}

test("a hydrated read cannot replace matching sidebar activity with its newer access timestamp", () => {
  assert.equal(resolveThreadActivityTimestampMs(payload("thread", 200), summary("thread", 10)), 10_000);
});

test("a genuine sidebar activity update advances the visible timestamp", () => {
  const thread = payload("thread", 200);
  assert.equal(resolveThreadActivityTimestampMs(thread, summary("thread", 300)), 300_000);
});

test("missing or mismatched activity projections cannot lend another thread their timestamp", () => {
  const thread = payload("thread", 200);
  assert.equal(resolveThreadActivityTimestampMs(thread), 200_000);
  assert.equal(resolveThreadActivityTimestampMs(thread, summary("other", 300)), 200_000);
});
