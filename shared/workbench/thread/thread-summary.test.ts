/*
 * Exports:
 * - No production exports; tests protect forward-compatible facts and stable empty summaries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createThreadSummary, ThreadSummarySchema } from "./thread-summary";

const row = {
  activityAt: 12_000, entryKind: "thread", title: "summary",
  identity: { harness: "codex", threadId: "00000001-0000-4000-8000-000000000000" },
  lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  metadata: { archived: false, pinned: false, snoozed: false },
} as const;

test("known summary facts parse while unknown newer facts are dropped", () => {
  const parsed = ThreadSummarySchema.parse({ row, facts: { addressedFeedbackCount: 3, requiredTodoCount: 2, goalSet: true } });
  assert.deepEqual(parsed.facts, { addressedFeedbackCount: 3, requiredTodoCount: 2 });
});

test("idle facts read as absent, so a thread with nothing live has the same summary as before", () => {
  const idle = createThreadSummary(row as never, { addressedFeedbackCount: 0, compacting: false, requiredTodoCount: 0 });
  assert.deepEqual(idle.facts, {});
  assert.equal("compacting" in createThreadSummary({ ...row, compacting: true } as never, {}).row, false,
    "a legacy row flag never leaks into the summary row");
});
