/*
 * Exports:
 * - No production exports; Node tests protect live context-compaction marker activity and completion rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { ThreadTurnDetails } from "./thread-view-items";

function renderCompaction(itemTimeline: readonly WorkbenchThreadItemTimelineEntry[]) {
  return renderToStaticMarkup(createElement(ThreadTurnDetails, {
    itemTimeline,
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [{ id: "compaction-one", type: "contextCompaction" }],
      itemsView: "full",
      startedAt: 1,
      status: "inProgress",
    },
  }));
}

test("an in-progress turn stops animating a compaction as soon as that item completes", () => {
  const activeHtml = renderCompaction([{
    completedAt: null,
    firstSeenAt: 1,
    itemId: "compaction-one",
    lastSeenAt: 1,
    startedAt: 1,
  }]);
  assert.match(activeHtml, /Context compacting/u);
  assert.match(activeHtml, /thread-thinking-text/u);

  const completedHtml = renderCompaction([{
    aliases: ["compaction-one"],
    completedAt: 2,
    firstSeenAt: 1,
    itemId: "item-1",
    lastSeenAt: 2,
    startedAt: 1,
  }]);
  assert.match(completedHtml, /Context compacted/u);
  assert.doesNotMatch(completedHtml, /thread-thinking-text/u);
});
