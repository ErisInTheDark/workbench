/* No production exports. Tests protect proposal resolution, destructive claim-release choice, and terminal thread-tail cleanup semantics. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";
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

function renderUnavailableProposal(unavailableReasonCode?: "committed-outside-proposal") {
  const proposal: GitCheckpointProposal = {
    amendTargetSha: null,
    baseCommit: "abcdef1",
    changes: [],
    committedSha: null,
    description: "",
    includeNewerAvailable: false,
    mode: "commit",
    paths: ["src/one.ts"],
    proposalId: "proposal-one",
    status: "unavailable",
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Proposal",
    unavailableReason: "Unavailable",
    ...(unavailableReasonCode ? { unavailableReasonCode } : {}),
  };
  return renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: proposal.paths,
    sourceItemId: "proposal-item",
    state: { proposal, status: "loaded" },
    title: proposal.title,
  }));
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
  assert.equal(getGitArcClaimReleaseAction(1, false), "unclaim");
  assert.equal(getGitArcClaimReleaseAction(0, true), "restore");
});

test("proposals committed through another path render as resolved rather than failed", () => {
  assert.match(
    renderUnavailableProposal("committed-outside-proposal"),
    /data-thread-checkpoint-committed-outside-proposal="true"/u,
  );
  assert.doesNotMatch(
    renderUnavailableProposal(),
    /data-thread-checkpoint-committed-outside-proposal/u,
  );
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
