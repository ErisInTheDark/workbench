/*
 * Keywords: MCP, Git arc, diagnostics, routing, proposal failure.
 * Exports:
 * - No production exports; tests prove specialized wb MCP operations enter the existing dedicated renderers. Keywords: MCP, Git arc, title, subagent, rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import { createGitArcFailureFromError, createGitArcOperationRejected, describeGitArcFailure, formatGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import { GitArcRejectionError, gitArcRejectionIssue } from "workbench-shared/workbench/git/git-arc-rejections";
import { getWorkbenchMcpCommandRoute } from "../../../workbench/thread/thread-command-matchers";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientProvider from "../WorkbenchClientProvider";
import type { WorkbenchClientController } from "../workbench-client-context";
import WorkbenchContextMenuProvider from "../WorkbenchContextMenuProvider";
import ThreadGitArcPresentationContext, { type ThreadGitArcPresentation } from "./ThreadGitArcPresentationContext";
import ThreadWorkbenchCommandItem from "./ThreadWorkbenchCommandItem";

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

test("compact claim updates show actual changes rather than attempted or unchanged paths", () => {
  for (const tool of ["git_arc_claims", "git_plan_claims", "git_plan_start"]) {
    const action = tool === "git_arc_claims" ? "claims" : tool === "git_plan_claims" ? "plan" : "start";
    const output = `arc ${action} active\nref ${"a".repeat(40)}\nclaimed-count 40\nadded 1\nadded-evidence.ts\nremoved 1\nremoved-evidence.ts\nend arc`;
    const html = renderSpecialized(makeItem(tool, { inherit: true, addPaths: ["attempted-evidence.ts"] }, output));
    assert.match(html, /added-evidence\.ts/u);
    assert.match(html, /removed-evidence\.ts/u);
    assert.doesNotMatch(html, /attempted-evidence\.ts/u);
    assert.match(html, /40 claimed/u);
    const unchanged = renderSpecialized(makeItem(tool, { inherit: true, addPaths: ["attempted-evidence.ts"] },
      `arc ${action} active\nref ${"a".repeat(40)}\nclaimed-count 40\nunchanged\nend arc`));
    assert.doesNotMatch(unchanged, /attempted-evidence\.ts/u);
    assert.match(unchanged, /40 claimed/u);
  }
});

test("historical update inventories are folded away while explicit scope remains visible", () => {
  for (const action of ["claims", "plan", "scope"]) {
    const output = `arc ${action} active\nref ${"a".repeat(40)}\nclaimed 1\ninventory-evidence.ts\nadded 1\nadded-evidence.ts\nend arc`;
    const html = renderSpecialized(makeItem(action === "plan" ? "git_plan_claims" : `git_arc_${action}`, { inherit: true }, output));
    if (action === "scope") assert.match(html, /inventory-evidence\.ts/u);
    else {
      assert.doesNotMatch(html, /inventory-evidence\.ts/u);
      assert.match(html, /added-evidence\.ts/u);
    }
  }
});

test("typed runtime failures render paths and partial workspace outcomes without diagnostics", () => {
  const failure = {
    ...createGitArcFailureFromError("arcClaims", new GitArcRejectionError({ reason: "unclaimedRemoval", paths: ["unclaimed-evidence.ts"] }, "agent-only-detail --inherit")),
    workspace: { failedRootIds: ["failed-project"], completedRootIds: ["completed-project"], stage: "operation" as const },
  };
  const html = renderSpecialized(makeItem("git_arc_claims", { inherit: true }, formatGitArcFailureReceipt(failure), "failed"));
  assert.match(html, /unclaimed-evidence\.ts/u);
  assert.match(html, /failed-project/u);
  assert.match(html, /completed-project/u);
  assert.doesNotMatch(html, /agent-only-detail|--inherit/u);
});

test("SDK validation renders the typed reason rather than its diagnostic", () => {
  const rejection = { reason: "conflictingProposalTargets" as const };
  const issue = gitArcRejectionIssue(rejection, "agent-only-detail --amend --replace");
  const output = `MCP error -32602: Input validation error: Invalid arguments for tool git_arc_propose: ${JSON.stringify([issue])}`;
  const html = renderSpecialized(makeItem("git_arc_propose", { amend: true, replace: "other" }, output, "failed"));
  const expected = describeGitArcFailure(createGitArcFailureFromError("proposalCreate", new GitArcRejectionError(rejection))).message;
  const encoded = renderToStaticMarkup(createElement("span", null, expected)).slice(6, -7);
  assert.ok(html.includes(encoded));
  assert.doesNotMatch(html, /agent-only-detail|--amend|--replace/u);
});

function makeItem(
  tool: string,
  argumentsValue: McpItem["arguments"],
  output: string,
  status: McpItem["status"] = "completed",
  server: "wb" | "wbex" = "wbex",
): McpItem {
  return {
    appContext: null,
    arguments: argumentsValue,
    durationMs: 12,
    error: null,
    id: `mcp-${tool}`,
    pluginId: null,
    readOnlyHint: false,
    result: { _meta: null, content: [{ type: "text", text: output }], structuredContent: null },
    server,
    status,
    tool,
    type: "mcpToolCall",
  };
}

function createClient(store: WorkbenchThreadSidebarStore | null): WorkbenchClientController {
  return {
    controls: null,
    explorer: {} as WorkbenchClientController["explorer"],
    mounted: store ? {
      getThreadController: () => { throw new Error("Unexpected thread view during command rendering."); },
      controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
      dispose: () => undefined,
      threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
      threadSidebar: store,
      threadTextPresentation: {} as NonNullable<WorkbenchClientController["mounted"]>["threadTextPresentation"],
    } : null,
  };
}

function renderSpecialized(
  item: McpItem,
  presentation: ThreadGitArcPresentation | null = null,
  store: WorkbenchThreadSidebarStore | null = null,
) {
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
  assert.equal(route?.kind, "specialized");
  if (!route || route.kind !== "specialized") throw new Error("Expected specialized wb route.");
  return renderToStaticMarkup(createElement(
    WorkbenchClientProvider,
    {
      children: createElement(
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
      ),
      client: createClient(store),
    },
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
  const html = renderSpecialized(makeItem("git_arc_claims", { inherit: true, addPaths: ["src/a.ts"] }, ""));

  assert.match(html, /data-thread-git-arc-card="claims"/u);
});

test("multi-root Git MCP plans render root-qualified project paths", () => {
  const html = renderSpecialized(makeItem("git_plan_claims", {
    intentName: "workspace change",
    roots: [
      { adoptPaths: ["src/client.ts"], addPaths: [], rootId: "web" },
      { adoptPaths: [], addPaths: ["src/contract.ts"], rootId: "api" },
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
  const html = renderSpecialized(makeItem("git_plan_claims", {
    adoptPaths: ["src/controller.ts"],
    intentDescription: "",
    intentName: "Restore titles",
    addPaths: ["src/controller.ts"],
  }, `Adopted paths already join the plan scope.\nWorkbench arc failure: ${JSON.stringify(failure)}\n`, "failed"));

  assert.match(html, /data-thread-git-arc-card="plan"/u);
  assert.match(html, /Failed to adopt changes/u);
  assert.doesNotMatch(html, />Failed to plan</u);
  assert.match(html, />Failed to adopt</u);
  assert.match(html, /data-thread-git-arc-failure="adoptedPathOverlap"/u);
  assert.match(html, /Ordinary and adopted plan scopes overlap/u);
  assert.doesNotMatch(html, /Adopted paths already join|Workbench arc failure:/u);
});

test("Git failures hide raw diagnostics from both MCP error and result channels", () => {
  const diagnostic = 'MCP error -32602: [{"message":"agent-only-detail"}] Usage: wb git arc claims --inherit';
  for (const tool of ["git_arc_diff", "git_plan_claims", "git_arc_claims", "git_arc_propose", "git_arc_unrecognised"]) {
    for (const transport of ["error", "text", "receipt"]) {
      const output = transport === "receipt"
        ? formatGitArcFailureReceipt(createGitArcOperationRejected("unknown", diagnostic))
        : diagnostic;
      const item = makeItem(tool, {}, output, "failed");
      if (transport === "error") {
        item.error = { message: diagnostic };
        item.result = null;
      }
      const html = renderSpecialized(item);
      assert.match(html, /data-thread-git-arc-card=/u, `${tool}/${transport}`);
      assert.match(html, /data-thread-git-arc-failure=/u, `${tool}/${transport}`);
      assert.doesNotMatch(html, /agent-only-detail|Usage:|MCP error|-32602/u, `${tool}/${transport}`);
      assert.doesNotMatch(html, /data-thread-checkpoint-card=/u, `${tool}/${transport}`);
    }
  }
});

test("failed waits retain the Git failure boundary", () => {
  const html = renderSpecialized(makeItem("git_arc_wait", {}, "agent-only-detail", "failed"));
  assert.match(html, /data-thread-git-arc-failure=/u);
  assert.doesNotMatch(html, /agent-only-detail/u);
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
  const snapshot = {
      entries: [owner, blocker],
      error: null,
      freshness: "fresh" as const,
      projectId: "project",
      revision: 1,
  };
  const store = {
    getProjectSnapshot: (projectId: string) => projectId === "project" ? snapshot : null,
    getSnapshot: () => null,
    subscribe: () => () => undefined,
  } satisfies WorkbenchThreadSidebarStore;
  const presentation = {
    harness: "codex" as const,
    onOpenThread: () => undefined,
    projectId: "project",
  };
  const runningHtml = renderSpecialized(
    makeItem("git_arc_wait", { ref: "a".repeat(40) }, "", "inProgress"),
    presentation,
    store,
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
  const titleHtml = renderSpecialized(makeItem(
    "thread_title",
    { title: "Render wb MCP" },
    "Render wb MCP",
    "completed",
    "wb",
  ));
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
