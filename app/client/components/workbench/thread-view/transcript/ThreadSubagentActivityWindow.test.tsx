/*
 * No production exports. Tests protect the subagent wait preview rendering through the transcript's one renderer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { RelatedThread } from "../../../../workbench/thread/ThreadStore";
import ThreadTestTurn from "../thread-view-test-render";

const command = (id: string, text: string): Extract<ThreadItem, { type: "commandExecution" }> => ({
  aggregatedOutput: null, command: text, commandActions: [], cwd: "C:/project", durationMs: null, exitCode: null,
  id, pluginId: null, processId: null, scriptPath: null, source: "agent", status: "inProgress", type: "commandExecution",
});
const turn = (id: string, items: ThreadItem[]): Turn => ({
  completedAt: null, durationMs: null, error: null, id, items, itemsView: "full", startedAt: 1, status: "inProgress",
});

test("a watched child's work previews as the same activity runs the main transcript shows", () => {
  const childId = WorkbenchThreadIdSchema.parse("child");
  const child: RelatedThread = {
    agentNickname: "child", agentPath: null, agentRole: null, cwd: "C:/project", harness: "codex", id: childId, isDraft: false,
    model: null, name: null, reasoningEffort: null, serviceTier: null, status: "active", tokenUsage: null,
    turns: [turn("child-turn", [
      { content: [], id: "child-reasoning", summary: ["Looking around"], type: "reasoning" },
      command("child-list", "Get-ChildItem src"),
    ])],
  };
  const html = renderToStaticMarkup(createElement(ThreadTestTurn, {
    relatedThreadsById: { [childId]: child },
    threadId: "parent",
    turn: turn("parent-turn", [command("wait", "wb subagent wait --id child")]),
  }));
  assert.match(html, /data-thread-activity-run="true"/u);
});

test("a child's relative paths resolve against the child's working directory, not the parent's", () => {
  const childId = WorkbenchThreadIdSchema.parse("child");
  const child: RelatedThread = {
    agentNickname: "child", agentPath: null, agentRole: null, cwd: "C:/project/packages/child", harness: "codex", id: childId,
    isDraft: false, model: null, name: null, reasoningEffort: null, serviceTier: null, status: "active", tokenUsage: null,
    turns: [turn("child-turn", [
      {
        appContext: null, arguments: { args: ["needle", "notes.md"] }, durationMs: 12, error: null, id: "child-search",
        pluginId: null, readOnlyHint: true, result: { _meta: null, content: [], structuredContent: null }, server: "wb",
        status: "completed", tool: "rg", type: "mcpToolCall",
      },
      { delivery: null, id: "child-answer", memoryCitation: null, phase: "final_answer", questions: null, text: "done", type: "agentMessage" },
    ])],
  };
  const html = renderToStaticMarkup(createElement(ThreadTestTurn, {
    projectRootPath: "C:/project",
    relatedThreadsById: { [childId]: child },
    threadCwdPath: "C:/project",
    threadId: "parent",
    turn: turn("parent-turn", [command("wait", "wb subagent wait --id child")]),
  }));
  assert.match(html, /title="packages\/child\/notes\.md"/u);
});
