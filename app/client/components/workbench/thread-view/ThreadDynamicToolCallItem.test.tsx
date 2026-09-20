/*
 * Exports:
 * - No production exports; tests protect user-owned dynamic-tool disclosure state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";

type DynamicItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

test("unfinished native arguments show streamed targets but failed settlement cannot retain a generation preview", () => {
  const item: DynamicItem = { type: "dynamicToolCall", id: "native", namespace: "opencode", tool: "patch",
    arguments: "", contentItems: null, durationMs: null, status: "inProgress", success: null,
    patchPreview: [{ path: "src/early-target.ts", kind: { type: "update", move_path: null }, additions: 2 }],
  };
  const before = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item }));
  assert.match(before, /early-target\.ts/u);
  const failed = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item: { ...item, status: "failed", success: false } }));
  assert.doesNotMatch(failed, /early-target\.ts/u);
});

test("a failed dynamic tool keeps its summary visible without opening its details", () => {
  const item: DynamicItem = {
    arguments: { retryCount: 3 },
    contentItems: [{ type: "inputText", text: "completed" }],
    durationMs: 9,
    id: "dynamic-one",
    namespace: "functions",
    status: "completed",
    success: false,
    tool: "custom_tool",
    type: "dynamicToolCall",
  };
  const html = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item }));

  assert.match(html, /custom_tool/u);
  assert.doesNotMatch(html, /<details[^>]*\bopen=/u);
});

test("an unanswered questionnaire starts open", () => {
  const item: DynamicItem = {
    arguments: {
      id: "questionnaire",
      questions: [{
        allowOther: false,
        header: "Choice",
        id: "choice",
        isSecret: false,
        options: [],
        question: "Continue?",
      }],
      submitLabel: "Submit",
      summary: "",
      title: "Continue?",
    },
    contentItems: null,
    durationMs: null,
    id: "questionnaire-request",
    namespace: null,
    status: "inProgress",
    success: null,
    tool: "workbench_request_user_input",
    type: "dynamicToolCall",
  };
  const html = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item }));

  assert.match(html, /<details[^>]*\bopen=/u);
});
