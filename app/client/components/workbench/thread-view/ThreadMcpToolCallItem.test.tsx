/*
 * Exports:
 * - No production exports; tests protect generic MCP routing, hidden questionnaire calls, wb MCP details, shell presentation, and mixed command grouping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { getWorkbenchMcpCommandRoute } from "../../../workbench/thread/thread-command-matchers";
import { ThreadTurnDetails } from "./thread-view-items";
import ThreadMcpToolCallItem from "./ThreadMcpToolCallItem";
import { getThreadTerminalEntries } from "./thread-live-activity";

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function renderOpenedMcp(props: Parameters<typeof ThreadMcpToolCallItem>[0]) {
  return renderToStaticMarkup(cloneElement(ThreadMcpToolCallItem(props), { open: true }));
}

function makeItem(overrides: Partial<McpItem> = {}): McpItem {
  return {
    appContext: null,
    arguments: { paths: [] },
    durationMs: 12,
    error: null,
    id: "mcp-one",
    pluginId: null,
    readOnlyHint: true,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Workbench arc comparison" }],
      structuredContent: null,
    },
    server: "wb",
    status: "completed",
    tool: "git_add",
    type: "mcpToolCall",
    ...overrides,
  };
}

test("unknown MCP calls keep the generic summary with the shared detail surface", () => {
  const html = renderOpenedMcp({
    item: makeItem({
      error: { message: "Unknown tool failed." },
      result: null,
      server: "external",
      status: "failed",
      tool: "future_tool",
    }),
    route: null,
  });

  assert.match(html, /external/u);
  assert.match(html, /future_tool/u);
  assert.match(html, /await tools\.mcp__external__future_tool\(/u);
});

test("failed simple wb MCP calls expose their invocation and error", () => {
  const item = makeItem({
    error: { message: "File selection failed." },
    result: null,
    server: "wbex",
    status: "failed",
  });
  const html = renderOpenedMcp({
    item,
    route: getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool }),
  });

  assert.match(html, /await tools\.mcp__wbex__git_add\(/u);
  assert.match(html, /File selection failed\./u);
});

test("Workbench questionnaire MCP calls stay out of thread command history", () => {
  const item = makeItem({
    arguments: {
      questions: [{
        header: "smoke test",
        id: "smoke_test",
        options: [],
        question: "What should lily receive?",
      }],
    },
    durationMs: null,
    result: null,
    status: "inProgress",
    tool: "request_user_input",
  });
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [item],
      itemsView: "full",
      startedAt: 1,
      status: "inProgress",
    },
  }));

  assert.doesNotMatch(html, /Waiting for user input/u);
  assert.doesNotMatch(html, /mcp__wb__request_user_input/u);
});

test("typed ripgrep calls render the shared query and project path presentation", () => {
  const item = makeItem({
    arguments: { args: ["-n", "needle|thread", "app/client/components/workbench.tsx"] },
    tool: "rg",
  });
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    context: {
      cwd: "C:/git/web/workbench",
      projectRootPath: "C:/git/web/workbench",
    },
    server: item.server,
    tool: item.tool,
  });
  const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, {
    item,
    projectFilePaths: ["app/client/components/workbench.tsx"],
    projectId: "project-one",
    route,
  }));

  assert.match(html, /Search for/u);
  assert.match(html, /data-thread-pattern-token="literal"[^>]*>needle</u);
  assert.match(html, /data-thread-pattern-token="literal"[^>]*>thread</u);
  assert.match(html, /workbench\.tsx/u);
  assert.match(html, /data-thread-command-pattern="regex"/u);
  assert.match(html, /data-thread-pattern-token="operator"[^>]*>\|</u);
  assert.match(html, /class="[^"]*overflow-hidden[^"]*text-ellipsis[^"]*whitespace-nowrap/u);
  assert.match(html, /title="needle\|thread"/u);
  assert.doesNotMatch(html, /&quot;needle/u);
});

test("fixed-string ripgrep calls keep pattern punctuation literal", () => {
  const item = makeItem({
    arguments: { args: ["-F", "needle|thread", "webapp"] },
    tool: "rg",
  });
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, { item, route }));

  assert.match(html, /data-thread-command-pattern="literal"/u);
  assert.match(html, /data-thread-pattern-token="literal"[^>]*>needle\|thread</u);
  assert.doesNotMatch(html, /data-thread-pattern-token="operator"/u);
});

test("ripgrep regex escapes dim only the escape marker", () => {
  const item = makeItem({
    arguments: { args: ["needle\\.", "webapp"] },
    tool: "rg",
  });
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, { item, route }));

  assert.match(
    html,
    /data-thread-pattern-token="escape"[^>]*>\\<\/span><span[^>]*data-thread-pattern-token="literal"[^>]*>\.<\/span>/u,
  );
});

test("ripgrep alternation punctuation stays dim across escaped character boundaries", () => {
  const item = makeItem({
    arguments: { args: ["new ReloadableNode|children: \\[|provides:|requires:", "webapp"] },
    tool: "rg",
  });
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, { item, route }));
  const dimAlternations = html.match(/class="text-fg\/muted" data-thread-pattern-token="operator">\|<\/span>/gu) ?? [];

  assert.equal(dimAlternations.length, 3);
  assert.match(html, /\[font-variant-ligatures:none\]/u);
});

test("running, failed and completed MCP calls start closed without suppressing their summaries", () => {
  for (const status of ["inProgress", "failed", "completed"] as const) {
    const item = makeItem({ status, tool: "future_tool" });
    const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, { item, route: null }));
    assert.doesNotMatch(html, /<details[^>]*\bopen=/u);
    assert.match(html, /future_tool/u);
  }
});

test("wb shell calls render through the ordinary command execution surface", () => {
  const item = makeItem({
    arguments: { command: "Get-ChildItem src", workdir: "C:/workspace" },
    readOnlyHint: false,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Exit code: 5\nOutput:\npartial\ndenied\n" }],
      structuredContent: {
        cwd: "C:/workspace",
        exitCode: 5,
        shell: "pwsh",
        stderr: "denied\n",
        stdout: "partial\n",
      },
    },
    tool: "shell",
  });
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 12,
      error: null,
      id: "turn-one",
      items: [item],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));

  assert.match(html, /Failed/u);
  assert.match(html, /title="src"/u);
  const terminal = getThreadTerminalEntries([item], { cwd: "C:/workspace" });
  assert.equal(terminal[0]?.command, "Get-ChildItem src");
  assert.match(terminal[0]?.output ?? "", /partial\s*denied/u);
  assert.doesNotMatch(html, /mcp__wb__shell/u);
});

test("adjacent wb rg and shell calls share a command summary while retaining separate terminal entries", () => {
  const rgItem = makeItem({
    arguments: { args: ["needle", "webapp"] },
    id: "rg-one",
    result: {
      _meta: null,
      content: [{ type: "text", text: "webapp/file.ts:1:needle" }],
      structuredContent: null,
    },
    tool: "rg",
  });
  const shellItem = makeItem({
    arguments: { command: "Get-ChildItem src", workdir: "C:/workspace" },
    id: "shell-one",
    readOnlyHint: false,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Exit code: 0\nOutput:\nfile.ts\n" }],
      structuredContent: {
        cwd: "C:/workspace",
        exitCode: 0,
        stderr: "",
        stdout: "file.ts\n",
      },
    },
    tool: "shell",
  });
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 12,
      error: null,
      id: "turn-one",
      items: [rgItem, shellItem],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));
  const visibleText = html.replace(/<[^>]+>/gu, "");

  assert.match(visibleText, /Searched 1 file, listed files/u);
  assert.equal(getThreadTerminalEntries([rgItem, shellItem], { cwd: "C:/workspace" }).length, 2);
});
