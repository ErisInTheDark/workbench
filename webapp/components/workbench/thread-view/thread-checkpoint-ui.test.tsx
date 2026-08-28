/* No production exports. Tests protect destructive claim-release choice and terminal thread-tail cleanup semantics. */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import getFinishedThreadTailHiddenItemIds from "./thread-finished-tail";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";

function proposalCommandItem(): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    aggregatedOutput: "Workbench arc proposal: proposal-one\n",
    command: "wb git arc propose --title \"Clean finished thread tail\" -- src/one.ts",
    commandActions: [],
    cwd: "C:/workspace",
    durationMs: 10,
    exitCode: 0,
    id: "proposal-command",
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
}

function proposalMcpItem(): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return {
    appContext: null,
    arguments: { paths: ["src/one.ts"], title: "Clean finished thread tail" },
    durationMs: 10,
    error: null,
    id: "proposal-mcp",
    pluginId: null,
    readOnlyHint: false,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Workbench arc proposal: proposal-one\n" }],
      structuredContent: null,
    },
    server: "wb",
    status: "completed",
    tool: "git_arc_propose",
    type: "mcpToolCall",
  };
}

function reasoningItem(): Extract<ThreadItem, { type: "reasoning" }> {
  return {
    content: [],
    id: "terminal-reasoning",
    summary: ["Sending empty final message"],
    type: "reasoning",
  };
}

function messageItem(id: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return {
    id,
    memoryCitation: null,
    phase: "commentary",
    text: "Visible message.",
    type: "agentMessage",
  };
}

function hiddenTailIds(
  itemGroups: readonly (readonly ThreadItem[])[],
  {
    hideReasoning = true,
    hoistedProposalIds = new Set(["proposal-one"]),
  }: {
    hideReasoning?: boolean;
    hoistedProposalIds?: ReadonlySet<string>;
  } = {},
) {
  return getFinishedThreadTailHiddenItemIds({
    hideReasoning,
    hoistedProposalIds,
    itemGroups,
    projectRootPath: "C:/workspace",
  });
}

test("claim release restores dirty work and only unclaims clean work", () => {
  assert.equal(getGitArcClaimReleaseAction(0), "unclaim");
  assert.equal(getGitArcClaimReleaseAction(1), "restore");
});

test("finished tails hide terminal reasoning and hoisted proposals from shell and MCP routes", () => {
  assert.deepEqual(
    hiddenTailIds([[messageItem("visible"), proposalCommandItem(), reasoningItem()]]),
    new Set(["proposal-command", "terminal-reasoning"]),
  );
  assert.deepEqual(
    hiddenTailIds([[messageItem("visible")], [reasoningItem(), proposalMcpItem()]]),
    new Set(["proposal-mcp", "terminal-reasoning"]),
  );
});

test("finished-tail cleanup stops at visible work and preserves ineligible terminal items", () => {
  assert.deepEqual(
    hiddenTailIds([[proposalCommandItem(), reasoningItem(), messageItem("later")]]),
    new Set(),
  );
  assert.deepEqual(
    hiddenTailIds([[proposalCommandItem(), reasoningItem()]], { hideReasoning: false }),
    new Set(),
  );
  assert.deepEqual(
    hiddenTailIds([[proposalCommandItem(), reasoningItem()]], { hoistedProposalIds: new Set() }),
    new Set(["terminal-reasoning"]),
  );
});
