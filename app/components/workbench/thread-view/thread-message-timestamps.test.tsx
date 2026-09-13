/*
 * Keywords: timestamps, user messages, steers, questionnaire, provenance.
 * No production exports. Tests protect event-time selection across transcript render paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type { WorkbenchProjectedInteractionItem } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { ThreadTranscriptItemsDetails, ThreadTurnDetails } from "./thread-view-items";

const user = (id: string): Extract<ThreadItem, { type: "userMessage" }> => ({
  clientId: null, content: [{ text: id, text_elements: [], type: "text" }], id, type: "userMessage",
});
const timing = (itemId: string, firstSeenAt: number, completedAt: number | null = null): WorkbenchThreadItemTimelineEntry => ({
  completedAt, firstSeenAt, itemId, lastSeenAt: completedAt, startedAt: null,
});
const timestamps = (html: string) => [...html.matchAll(/<time\b[^>]*dateTime="([^"]+)"/gu)].map((match) => match[1]);
const iso = (ms: number) => new Date(ms).toISOString();

for (const status of ["inProgress", "completed"] as const) {
  test(`merged steers use only the final event time in ${status} turns`, () => {
    const steerA = withWorkbenchInputState(user("steer-a"), { kind: "steer", status: "sent" });
    const steerB = withWorkbenchInputState(user("steer-b"), { kind: "steer", status: "sent" });
    const turn: Turn = {
      completedAt: status === "completed" ? 90 : null, durationMs: null, error: null,
      id: "turn", items: [user("initial"), steerA, steerB], itemsView: "full", startedAt: 1, status,
    };
    const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
      flattenCompletedWork: true, threadId: "thread", turn,
      itemTimeline: [timing("initial", 2_000), timing("steer-a", 8_000, 9_000), timing("steer-b", 12_000, 13_000)],
    }));
    assert.deepEqual(timestamps(html), [iso(2_000), iso(12_000)]);
  });
}

test("only the initial message falls back to turn start when item timing is missing", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    threadId: "thread",
    turn: {
      completedAt: null, durationMs: null, error: null, id: "turn",
      items: [user("initial"), user("later")], itemsView: "full", startedAt: 1, status: "inProgress",
    },
  }));
  assert.deepEqual(timestamps(html), [iso(1_000)]);
});

test("a later transcript segment cannot borrow the initial message timestamp", () => {
  const html = renderToStaticMarkup(createElement(ThreadTranscriptItemsDetails, {
    items: [user("later")], initialUserItemId: "initial",
    threadId: "thread", turnId: "turn", turnCompletedAt: 10, turnStartedAt: 1, turnStatus: "completed",
  }));
  assert.deepEqual(timestamps(html), []);
});

test("relational questionnaire answers use resolution rather than request time", () => {
  const item: WorkbenchProjectedInteractionItem = {
    errorText: null, id: "question", requestKey: "request", resolvedAt: 8_000,
    request: {
      id: "request", questions: [{ id: "choice", question: "Which?", header: "", options: [], allowOther: false, isSecret: false }],
      title: "Which?", summary: "", submitLabel: "",
    },
    response: { answers: { choice: { answers: ["answer"] } } }, state: "answered", type: "questionnaire",
  };
  const html = renderToStaticMarkup(createElement(ThreadTranscriptItemsDetails, {
    items: [item], itemTimeline: [timing(item.id, 1_000, 9_000)],
    threadId: "thread", turnId: "turn", turnCompletedAt: 10, turnStartedAt: 1, turnStatus: "completed",
  }));
  assert.ok(timestamps(html).length > 0);
  assert.ok(timestamps(html).every((value) => value === iso(item.resolvedAt)));
});

test("native questionnaire answers use completion time and unanswered requests stay unstamped", () => {
  const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
    arguments: { questions: [{ id: "choice", question: "Which?", options: [] }] },
    contentItems: [{ type: "inputText", text: JSON.stringify({ answers: { choice: { answers: ["answer"] } } }) }],
    durationMs: null, id: "native-question", namespace: "opencode", status: "completed",
    success: true, tool: "question", type: "dynamicToolCall",
  };
  const render = (question: typeof item) => renderToStaticMarkup(createElement(ThreadTranscriptItemsDetails, {
    items: [question], itemTimeline: [timing(item.id, 1_000, 8_000)],
    threadId: "thread", turnId: "turn", turnCompletedAt: 10, turnStartedAt: 1, turnStatus: "completed",
  }));
  assert.ok(timestamps(render(item)).length > 0);
  assert.ok(timestamps(render(item)).every((value) => value === iso(8_000)));
  // Failed tools with captured responses start expanded rather than in the answer preview.
  assert.ok(timestamps(render({ ...item, status: "failed" })).includes(iso(8_000)));
  assert.deepEqual(timestamps(render({ ...item, contentItems: null, status: "inProgress" })), []);
});

test("invalid item timing is not presented as a real timestamp", () => {
  const html = renderToStaticMarkup(createElement(ThreadTranscriptItemsDetails, {
    items: [user("invalid")], itemTimeline: [timing("invalid", NaN)],
    threadId: "thread", turnId: "turn", turnCompletedAt: 10, turnStartedAt: 1, turnStatus: "completed",
  }));
  assert.deepEqual(timestamps(html), []);
});
