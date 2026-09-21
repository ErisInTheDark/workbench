/*
 * Exports:
 * - No production exports; tests protect user-owned dynamic-tool disclosure state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";
import { ThreadFileChangeList } from "./ThreadFileChangeItem";

type DynamicItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

test("a completed native edit has one disclosure rather than a second copy of its operation", () => {
  const item: DynamicItem = {
    type: "dynamicToolCall", id: "edit", namespace: "opencode", tool: "edit",
    arguments: { path: "src/a.ts", oldString: "old", newString: "new" },
    status: "completed", success: true, durationMs: 15,
    contentItems: [{ type: "inputText", text: "edited successfully" }],
    metadata: { files: [{ file: "src/a.ts", status: "modified",
      patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" }] },
  };
  const html = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item }));
  assert.equal((html.match(/<details\b/g) ?? []).length, 1);
});

test("multi-file failure retains one complete raw evidence disclosure alongside every file", () => {
  const item: DynamicItem = {
    type: "dynamicToolCall", id: "patch", namespace: "opencode", tool: "patch",
    arguments: { patchText: "original patch input" }, status: "failed", success: false, durationMs: 1500,
    contentItems: [{ type: "inputText", text: "first file changed, second file denied" }],
    metadata: { files: ["src/a.ts", "src/b.ts"].map(file => ({ file, status: "modified", patch: "+new" })) },
  };
  const view = ThreadDynamicToolCallItem({ item }) as ReactElement<ComponentProps<typeof ThreadFileChangeList>>;
  const html = renderToStaticMarkup(view);
  assert.equal((html.match(/<details\b/g) ?? []).length, 2);
  const evidence = view.props.changes.flatMap(change => change.details ? [change.details] : []);
  assert.equal(evidence.length, 1);
  const expanded = renderToStaticMarkup(createElement("div", null, ...evidence));
  assert.match(expanded, /original patch input/);
  assert.match(expanded, /first file changed, second file denied/);
  assert.ok(view.props.changes.every(change => change.danger));
});

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
