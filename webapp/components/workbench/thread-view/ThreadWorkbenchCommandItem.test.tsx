/*
 * Exports:
 * - No production exports; tests prove specialized wb MCP operations enter the existing dedicated renderers. Keywords: MCP, Git arc, title, subagent, rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchThreadSidebarStore } from "../../../lib/types";
import { getWorkbenchMcpCommandRoute } from "../../../lib/workbench/thread/thread-command-matchers";
import type { WorkbenchThreadSidebarEntry } from "../../../lib/workbench/thread/thread-state";
import WorkbenchContextMenuProvider from "../WorkbenchContextMenuProvider";
import ThreadGitArcPresentationContext, { type ThreadGitArcPresentation } from "./ThreadGitArcPresentationContext";
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

function renderSpecialized(item: McpItem, presentation: ThreadGitArcPresentation | null = null) {
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  assert.equal(route?.kind, "specialized");
  if (!route || route.kind !== "specialized") throw new Error("Expected specialized wb route.");
  return renderToStaticMarkup(createElement(
    WorkbenchContextMenuProvider,
    null,
    createElement(
      ThreadGitArcPresentationContext.Provider,
      { value: presentation },
      createElement(ThreadWorkbenchCommandItem, {
        item,
        relatedThreadsById: {},
        renderRecallRecord: () => null,
        route,
        subagents: [],
        threadCwdPath: "C:/workspace",
        threadId: "thread-one",
      }),
    ),
  ));
}

function threadEntry(
  threadId: string,
  gitArc: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["gitArc"] = null,
  gitArcPlan: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["gitArcPlan"] = null,
): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> {
  return {
    activityAt: 10,
    entryKind: "thread",
    gitArc,
    gitArcPlan,
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: threadId,
  };
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

test("Git arc waits use live intersections while running and the start card after completion", () => {
  const owner = threadEntry("thread-one", null, {
    checkpointCommit: "a".repeat(40),
    intentDescription: "",
    intentName: "wait plan",
    scopePaths: ["src/feature"],
    updatedAt: "2026-08-28T00:00:00.000Z",
  });
  const blocker = threadEntry("blocking thread", {
    checkpointCommit: "b".repeat(40),
    claimedPaths: ["src/feature/card.tsx"],
    intentDescription: "",
    intentName: "blocking work",
    phase: "active",
    proposals: [],
    updatedAt: "2026-08-28T00:00:00.000Z",
  });
  const store = {
    getSnapshot: () => ({
      entries: [owner, blocker],
      error: null,
      freshness: "fresh" as const,
      projectId: "project",
      revision: 1,
    }),
    subscribe: () => () => undefined,
  } satisfies WorkbenchThreadSidebarStore;
  const presentation = {
    harness: "codex" as const,
    onOpenThread: () => undefined,
    projectId: "project",
    threadSidebarStore: store,
  };
  const runningHtml = renderSpecialized(
    makeItem("git_arc_wait", { ref: "a".repeat(40) }, "", "inProgress"),
    presentation,
  );

  assert.match(runningHtml, /data-thread-git-arc-intersection-card="wait"/u);
  assert.match(runningHtml, /blocking%20thread/u);

  const completedHtml = renderSpecialized(makeItem("git_arc_wait", { ref: "a".repeat(40) }, [
    "Waited for claims and started Git arc",
    `Workbench arc receipt: ${JSON.stringify({
      action: "start",
      claimedPaths: ["src/feature"],
      intentName: "wait plan",
      ref: "c".repeat(40),
      version: 1,
    })}`,
  ].join("\n")));

  assert.match(completedHtml, /data-thread-git-arc-card="start"/u);
  assert.match(completedHtml, /data-thread-git-arc-duration="waited"/u);
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
