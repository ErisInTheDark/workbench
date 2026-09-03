/*
 * No production exports. Tests protect reasoning step order, newest live ownership, and exact disclosure omission. Keywords: reasoning, live, disclosure, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import {
  getCurrentThreadReasoningActivity,
  getThreadReasoningSteps,
  omitThreadReasoningStep,
} from "./thread-reasoning-display";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

function reasoning(summary: string[]): ReasoningItem {
  return { content: ["hidden raw reasoning"], id: "reasoning", summary, type: "reasoning" };
}

function turn(items: ThreadItem[]): Turn {
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id: "turn",
    items,
    itemsView: "full",
    startedAt: 1,
    status: "inProgress",
  };
}

test("reasoning sections preserve order and split each title from its description", () => {
  assert.deepEqual(getThreadReasoningSteps([reasoning([
    "## First title\n\nFirst description.",
    "**Second title**\nSecond description.",
    "  ",
  ])]), [
    {
      body: "First description.",
      itemId: "reasoning",
      markdown: "## First title\n\nFirst description.",
      sectionIndex: 0,
      source: "summary",
      title: "First title",
    },
    {
      body: "Second description.",
      itemId: "reasoning",
      markdown: "**Second title**\nSecond description.",
      sectionIndex: 1,
      source: "summary",
      title: "Second title",
    },
  ]);
});

test("live reasoning selects the newest section and omits only that exact step", () => {
  const item = reasoning(["First\nold detail", "Latest\nlive detail"]);
  const activity = getCurrentThreadReasoningActivity(turn([item]));
  assert.deepEqual(activity, {
    body: "live detail",
    hiddenStep: { itemId: "reasoning", sectionIndex: 1, source: "summary" },
    title: "Latest",
  });
  assert.deepEqual(omitThreadReasoningStep(item, activity?.hiddenStep), reasoning(["First\nold detail"]));
});

test("title-only reasoning becomes one bodyless step and exact omission removes the item", () => {
  const item = reasoning(["Reason carefully"]);
  const [step] = getThreadReasoningSteps([item]);
  assert.equal(step?.title, "Reason carefully");
  assert.equal(step?.body, null);
  assert.equal(omitThreadReasoningStep(item, {
    itemId: "reasoning",
    sectionIndex: 0,
    source: "summary",
  }), null);
});

test("pending steers do not replace the newest reasoning activity", () => {
  const pendingSteer: Extract<ThreadItem, { type: "userMessage" }> = {
    clientId: null,
    content: [{ text: "queued", text_elements: [], type: "text" }],
    id: "optimistic-user-message:steer:pending:one",
    type: "userMessage",
  };
  assert.equal(getCurrentThreadReasoningActivity(turn([
    reasoning(["Still thinking\nwith detail"]),
    pendingSteer,
  ]))?.title, "Still thinking");
});
