/*
 * Exports:
 * - No production exports; tests prove specialized wb MCP operations enter the existing dedicated renderers. Keywords: MCP, Git arc, title, subagent, rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import { getWorkbenchMcpCommandRoute } from "../../../lib/workbench/thread/thread-command-matchers";
import ThreadWorkbenchCommandItem from "./ThreadWorkbenchCommandItem";

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function makeItem(tool: string, argumentsValue: McpItem["arguments"], output: string, status: McpItem["status"] = "completed"): McpItem {
  return {
    appContext: null,
    arguments: argumentsValue,
    durationMs: 12,
    error: null,
    id: `mcp-${tool}`,
    pluginId: null,
    readOnlyHint: false,
    result: { _meta: null, content: [{ type: "text", text: output }], structuredContent: null },
    server: "wb",
    status,
    tool,
    type: "mcpToolCall",
  };
}

function renderSpecialized(item: McpItem) {
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  assert.equal(route?.kind, "specialized");
  if (!route || route.kind !== "specialized") throw new Error("Expected specialized wb route.");
  return renderToStaticMarkup(createElement(ThreadWorkbenchCommandItem, {
    item,
    relatedThreadsById: {},
    renderRecallRecord: () => null,
    route,
    subagents: [],
    threadCwdPath: "C:/workspace",
    threadId: "thread-one",
  }));
}

test("Git MCP operations use the existing Git arc card instead of a simple label", () => {
  const html = renderSpecialized(makeItem("git_arc_plan_add", { paths: ["src/a.ts"] }, ""));

  assert.match(html, /data-thread-git-arc-card="planAdd"/u);
});

test("multi-root Git MCP plans render root-qualified project paths", () => {
  const html = renderSpecialized(makeItem("git_arc_plan", {
    intentName: "workspace change",
    roots: [
      { adoptPaths: ["src/client.ts"], paths: [], rootId: "web" },
      { adoptPaths: [], paths: ["src/contract.ts"], rootId: "api" },
    ],
  }, ""));

  assert.match(html, /api:src\/contract\.ts/u);
  assert.match(html, /web:src\/client\.ts/u);
});

test("historical overlap failures keep exact duplicate paths in adoption-only presentation", () => {
  const failure = {
    action: "plan",
    code: "adoptedPathOverlap",
    overlaps: [{ adoptedPath: "src/controller.ts", ordinaryPath: "src/controller.ts" }],
    version: 1,
  } as const;
  const html = renderSpecialized(makeItem("git_arc_plan", {
    adoptPaths: ["src/controller.ts"],
    intentDescription: "",
    intentName: "Restore titles",
    paths: ["src/controller.ts"],
  }, `Adopted paths already join the plan scope.\nWorkbench arc failure: ${JSON.stringify(failure)}\n`, "failed"));

  assert.match(html, /data-thread-git-arc-card="plan"/u);
  assert.match(html, /Failed to adopt changes/u);
  assert.doesNotMatch(html, />Failed to plan</u);
  assert.match(html, />Failed to adopt</u);
  assert.match(html, /data-thread-git-arc-failure="adoptedPathOverlap"/u);
  assert.match(html, /Ordinary and adopted plan scopes overlap/u);
  assert.doesNotMatch(html, /Adopted paths already join|Workbench arc failure:/u);
});

test("title and subagent MCP operations use their dedicated renderers", () => {
  const titleHtml = renderSpecialized(makeItem("thread_title", { title: "Render wb MCP" }, "Render wb MCP"));
  const subagentHtml = renderSpecialized(makeItem("subagent_create", {
    message: "inspect renderer ownership",
    name: "Lumi",
    profileId: "profile-one",
    title: "Inspect renderers",
  }, "child-thread"));

  assert.match(titleHtml, /data-role="thread-title-command"/u);
  assert.match(titleHtml, /Render wb MCP/u);
  assert.match(subagentHtml, /Lumi/u);
});

test("parent-directed MCP messages use the existing subagent message renderer", () => {
  const html = renderSpecialized(makeItem("subagent_message", {
    message: "parent-facing progress",
    parent: true,
  }, ""));

  assert.match(html, /parent/u);
});
