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
