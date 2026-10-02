/*
 * Exports:
 * - No production exports; Node tests protect context-compaction activity, outcome, and duration rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ContextCompactionStatus } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { ThreadTurnDetails } from "./thread-view-items";

function renderCompaction(
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[],
  options: { status?: ContextCompactionStatus; turnStatus?: Turn["status"] } = {},
) {
  return renderToStaticMarkup(createElement(ThreadTurnDetails, {
    itemTimeline,
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [{ id: "compaction-one", type: "contextCompaction", ...(options.status ? { status: options.status } : {}) }],
      itemsView: "full",
      startedAt: 1,
      status: options.turnStatus ?? "inProgress",
    },
  }));
}

const running = { completedAt: null, firstSeenAt: 1_000, itemId: "compaction-one", lastSeenAt: 1_000, startedAt: 1_000 };
const finished = { ...running, completedAt: 13_000, lastSeenAt: 13_000 };

test("a status-less compaction label changes from active to completed with its timeline entry", () => {
  assert.match(renderCompaction([running]), /Context compacting/u);
  assert.match(renderCompaction([{ ...finished, aliases: ["compaction-one"], itemId: "item-1" }]), /Context compacted/u);
});

test("Workbench status decides compaction activity independently of its turn", () => {
  // Manual compaction runs inside an already finished turn.
  assert.match(renderCompaction([running], { status: "inProgress", turnStatus: "completed" }), /Context compacting/u);
  // Auto-compaction finishes while its turn keeps running, and shows how long it took.
  const completed = renderCompaction([finished], { status: "completed", turnStatus: "inProgress" });
  assert.match(completed, /Context compacted 12s/u);
  assert.doesNotMatch(completed, /compacting/u);
  assert.match(renderCompaction([finished], { status: "failed" }), /Context compaction failed/u);
});
