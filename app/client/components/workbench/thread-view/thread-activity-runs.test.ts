/*
 * No production exports. Regression wards protect what joins an activity run, what breaks one, and how its steps group.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";

import { buildActivityRuns, getActivitySegmentItems } from "./thread-activity-runs";
import { buildRenderableBlocks, getRenderableBlockItems, type CommandItem, type ThreadRenderableBlock } from "./thread-render-blocks";

function command(id: string, text = "pwd"): CommandItem {
  return { id, type: "commandExecution", command: text, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: 0, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed" };
}
function mcp(id: string, tool: string, args: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"]): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: args, status: "completed", result: null,
    error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}
function reasoning(id: string): ThreadItem {
  return { type: "reasoning", id, summary: [id], content: [] };
}
function edit(id: string, path: string): ThreadItem {
  return { id, type: "dynamicToolCall", namespace: "claude", tool: "Edit", arguments: { file_path: path },
    status: "completed", success: true, contentItems: null, durationMs: 1 };
}

/** OpenCode code mode: an `execute` wrapper whose wb calls are recorded as their own items in its call group. */
function codeWrapper(id: string, group: string, status: "completed" | "failed" = "completed"): ThreadItem {
  return { id, type: "dynamicToolCall", namespace: "opencode", tool: "execute", arguments: { code: "await tools.wb.shell({ command: 'pwd' })" },
    status, success: status === "completed", contentItems: null, durationMs: 1, toolCallGroupId: group };
}
function codeCall(id: string, group: string): ThreadItem {
  return {
    ...mcp(id, "shell", { command: "pwd", workdir: "C:/repo" }),
    result: { _meta: null, content: [], structuredContent: { cwd: "C:/repo", exitCode: 0, shell: "pwsh", stderr: "", stdout: "" } },
    toolCallGroupId: group,
  };
}

/** Runs as `run:[segment kinds and ids]`, other blocks as their kind and ids. */
function shape(items: ThreadItem[], context: Parameters<typeof buildActivityRuns>[1] = {}) {
  return buildActivityRuns(buildRenderableBlocks(items), context).map((block: ThreadRenderableBlock) => block.kind === "activityRun"
    ? ["run", block.segments.map(segment => [segment.kind, getActivitySegmentItems(segment).map(item => item.id)])]
    : [block.kind, getRenderableBlockItems(block).map(item => item.id)]);
}

test("code-mode wrappers stay inside the run: hidden behind their calls, or one code step when shown or failed", () => {
  const steps = [
    reasoning("think"), codeWrapper("wrap-a", "a"), codeCall("call-a", "a"),
    reasoning("again"), codeWrapper("wrap-b", "b"), codeCall("call-b", "b"),
  ];
  assert.deepEqual(shape(steps), [["run", [
    ["reasoning", ["think"]], ["commands", ["call-a"]], ["reasoning", ["again"]], ["commands", ["call-b"]],
  ]]]);
  assert.deepEqual(shape(steps.slice(0, 3), { codeDetails: true }), [["run", [
    ["reasoning", ["think"]], ["code", ["wrap-a"]], ["commands", ["call-a"]],
  ]]]);
  assert.deepEqual(shape([command("before"), codeWrapper("failed", "lost", "failed"), command("after")]), [["run", [
    ["commands", ["before"]], ["code", ["failed"]], ["commands", ["after"]],
  ]]]);
});

test("reasoning, plain commands, file edits and native reads share one run; adjacent commands share one group", () => {
  assert.deepEqual(shape([
    reasoning("think"), command("one"), command("two"), reasoning("again"),
    edit("edit-a", "a.ts"), edit("edit-b", "b.ts"), command("three"),
    { id: "native-read", type: "dynamicToolCall", namespace: "claude", tool: "Read", arguments: { file_path: "c.ts" },
      status: "completed", success: true, contentItems: null, durationMs: 1 },
  ]), [["run", [
    ["reasoning", ["think"]],
    ["commands", ["one", "two"]],
    ["reasoning", ["again"]],
    ["files", ["edit-a", "edit-b"]],
    ["commands", ["three", "native-read"]],
  ]]]);
});

test("conversation and lifecycle rows break runs and keep their own blocks", () => {
  const boundaries: Array<[ThreadItem, string]> = [
    [{ type: "agentMessage", id: "boundary", text: "reply", phase: "commentary", memoryCitation: null, delivery: null, questions: null }, "agentCommentarySequence"],
    [command("boundary", 'wb git arc propose --title "Keep this visible"'), "commandSequence"],
    [command("boundary", "wb git arc scope"), "commandSequence"],
    [command("boundary", "wb git arc wait"), "commandSequence"],
    [command("boundary", 'wb task set --title "new title"'), "commandSequence"],
    [command("boundary", "wb task completed"), "commandSequence"],
    [command("boundary", "wb todo --required -- fix it"), "commandSequence"],
    [command("boundary", "wb subagent create --profile luna --name luna --title task --message hello"), "commandSequence"],
    [command("boundary", "wb task blocked"), "commandSequence"],
    [mcp("boundary", "task_set", { title: "new" }), "item"],
    [mcp("boundary", "task_completed", {}), "item"],
    [mcp("boundary", "task_blocked", {}), "item"],
    [mcp("boundary", "git_arc_propose", { title: "Keep this visible" }), "item"],
    [mcp("boundary", "git_arc_status", {}), "item"],
    [mcp("boundary", "todo", { text: "Fix it — later" }), "item"],
    [mcp("boundary", "feedback", { category: "bug", channel: "wb", report: "r", title: "t" }), "item"],
  ];
  for (const [boundary, kind] of boundaries) {
    assert.deepEqual(shape([command("before"), boundary, command("after")]), [
      ["run", [["commands", ["before"]]]],
      [kind, ["boundary"]],
      ["run", [["commands", ["after"]]]],
    ], JSON.stringify(boundary));
  }
});

test("arc reads, plans, vis, recall and queue checks are steps inside the surrounding command group, while proposals stay cards", () => {
  const steps = [
    command("before"),
    command("compare-cli", "wb git arc compare"), mcp("diff-mcp", "git_arc_diff", {}), mcp("claims-mcp", "git_arc_claims", { inherit: true, addPaths: ["a.ts"] }),
    command("plan-cli", "wb git plan claims -m intent -- a.ts"), mcp("plan-mcp", "git_plan_claims", { intentName: "intent", addPaths: ["a.ts"] }),
    command("continue-cli", "wb git arc continue"),
    command("vis-cli", "wb vis start mockups/a.tsx"),
    command("recall-cli", "wb thread recall"), mcp("recall-mcp", "thread_recall", {}),
    command("queue-cli", "wb subagent queue machine"), mcp("queue-mcp", "subagent_queue", { queue: "machine" }),
    command("after"),
  ];
  assert.deepEqual(shape(steps), [["run", [["commands", steps.map(step => step.id)]]]]);
  assert.deepEqual(shape([command("before"), mcp("propose", "git_arc_propose", { title: "Keep this visible" }), command("after")]).map(([kind]) => kind),
    ["run", "item", "run"]);
});

test("sleeps join runs as their own untinted steps, splitting the command group around them", () => {
  assert.deepEqual(shape([command("before"), command("nap", "Start-Sleep -Seconds 120"), command("after")]), [
    ["run", [["commands", ["before"]], ["sleep", ["nap"]], ["commands", ["after"]]]],
  ]);
});

test("reasoning with nothing to show adds no step, and a run of only that renders nothing", () => {
  const blank = (id: string): ThreadItem => ({ type: "reasoning", id, summary: [""], content: [] });
  assert.deepEqual(shape([blank("hidden")]), []);
  assert.deepEqual(shape([blank("hidden"), command("one")]), [["run", [["commands", ["one"]]]]]);
});

test("matcher-named vis checks group like other commands while unnamed dedicated rows stand alone", () => {
  assert.deepEqual(shape([command("before"), command("shot", "wb vis screenshot mockups/a.tsx"), command("after")]), [
    ["run", [["commands", ["before", "shot", "after"]]]],
  ]);
});

function screenshotSteer(id: string, url: string): ThreadItem {
  return { id, type: "userMessage", clientId: null, content: [
    { type: "text", text: createAgentScreenshotSteerText(), text_elements: [] },
    { type: "image", url },
  ] };
}

test("CLI and MCP Browse calls join runs, and their screenshot steers fold into the step that took them", () => {
  const cli = command("cli", 'wb browse run --session lab --command "open http://localhost:3002" --command screenshot');
  const tool = { ...mcp("tool", "browse_run", { commands: ["snapshot --compact"], session: "lab" }) };
  assert.deepEqual(shape([command("before"), cli, tool, command("after")]), [
    ["run", [["commands", ["before", "cli", "tool", "after"]]]],
  ]);

  const shown = new Set(["/asset/shot.png"]);
  const items = [cli, screenshotSteer("shot", "/asset/shot.png"), command("after")];
  const folded = buildActivityRuns(buildRenderableBlocks(items), { browseScreenshotUrls: shown });
  assert.deepEqual(folded.map(block => [block.kind, getRenderableBlockItems(block).map(item => item.id)]), [
    ["activityRun", ["cli", "after"]],
  ]);

  const unrelated = buildActivityRuns(buildRenderableBlocks([cli, screenshotSteer("vis", "/asset/vis.png"), command("after")]), { browseScreenshotUrls: shown });
  assert.deepEqual(unrelated.map(block => block.kind), ["activityRun", "item", "activityRun"]);
});

test("hidden calls leave no step and agent-only patch recovery context is never shown", () => {
  assert.deepEqual(shape([
    command("one"), mcp("hidden", "request_user_input", {}), command("two"),
    { id: "recovery", type: "functionCallOutput", namespace: "workbench", name: "patch_recovery", output: "context" },
  ]), [["run", [["commands", ["one", "two"]]]]]);
});
