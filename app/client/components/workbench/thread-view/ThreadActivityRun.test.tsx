/*
 * No production exports. Tests protect when an activity run is a card and when it unwraps into its one step.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import ThreadTestTurn from "./thread-view-test-render";

const reasoning = (id: string): ThreadItem => ({ type: "reasoning", id, summary: [`**${id} title**\n\n${id} body`], content: [] });
const command = (id: string): ThreadItem => ({
  aggregatedOutput: "", command: "pwd", commandActions: [], cwd: "C:/repo", durationMs: 1, exitCode: 0,
  id, pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed", type: "commandExecution",
});
const agentMessage = (id: string): ThreadItem => ({
  delivery: null, id, memoryCitation: null, phase: "commentary", questions: null, text: "next", type: "agentMessage",
});
const render = (items: ThreadItem[], status: Turn["status"]) => renderToStaticMarkup(createElement(ThreadTestTurn, {
  threadId: "thread",
  turn: { completedAt: status === "completed" ? 2 : null, durationMs: null, error: null, id: "turn", items, itemsView: "full", startedAt: 1, status },
}));
const cards = (html: string) => (html.match(/data-thread-activity-run="true"/gu) ?? []).length;

test("a settled run holding one step unwraps into that step, while longer runs stay cards", () => {
  const html = render([reasoning("lone"), agentMessage("message"), reasoning("first"), command("run")], "completed");
  assert.equal(cards(html), 1, "only the two-step run is a card");
  assert.match(html, /lone title/u, "the lone reasoning shows as its own step");
});

test("repeated failed edits of one file are one stitched step, so their settled run unwraps into it", () => {
  const failedEdit = (id: string): ThreadItem => ({
    arguments: { file_path: "C:/repo/a.ts", new_string: "b", old_string: "a" }, contentItems: null, durationMs: 1, id,
    namespace: "claude", status: "failed", success: false, tool: "Edit", type: "dynamicToolCall",
  });
  const html = render([failedEdit("one"), failedEdit("two"), failedEdit("three"), agentMessage("message")], "completed");
  assert.equal(cards(html), 0);
  assert.match(html, /×3/u);
});

test("a live run is a card even with one step, so its status row never jumps", () => {
  assert.equal(cards(render([reasoning("thinking")], "inProgress")), 1);
});
