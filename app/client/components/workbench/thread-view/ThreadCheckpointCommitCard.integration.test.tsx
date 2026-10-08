/*
 * No production exports. Tests protect transcript proposal cards, observed proposal resolution and summaries, claim-release choice, and terminal thread-tail cleanup.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";
import ThreadCheckpointCommitController from "./ThreadCheckpointCommitController";
import { ThreadGitArcObservationProvider } from "./ThreadGitArcObservationContext";
import getFinishedThreadTailHiddenItemIds from "./thread-finished-tail";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";
import { ThreadTurnDetails } from "./thread-view-items";
import WorkbenchClientProvider from "../WorkbenchClientProvider";
import type { WorkbenchClientController } from "../workbench-client-context";
import WorkbenchContextMenuProvider from "../WorkbenchContextMenuProvider";

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
    delivery: null,
    questions: null,
    phase: "commentary",
    text: "Visible message.",
    type: "agentMessage",
  };
}

function renderUnavailableProposal(unavailableReasonCode?: "committed-outside-proposal") {
  const proposal: GitCheckpointProposal = {
    amendTargetMessage: null,
    amendTargetSha: null,
    baseCommit: "abcdef1",
    changes: [],
    committedSha: null,
    description: "",
    freshChanges: null,
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
    commitMode: proposal.mode,
    committing: false,
    description: "",
    freshCommitAvailable: false,
    includeNewer: false,
    onCommit: () => undefined,
    onCommitModeChange: () => undefined,
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

function hiddenTailIds(itemGroups: readonly (readonly ThreadItem[])[], hideReasoning = true) {
  return getFinishedThreadTailHiddenItemIds({ hideReasoning, itemGroups });
}

test("transcript proposals are collapsed git arc cards named by their proposal; failures keep agent detail out", () => {
  const client: WorkbenchClientController = {
    controls: null,
    explorer: {} as WorkbenchClientController["explorer"],
    mounted: null,
  };
  for (const transport of ["cli", "mcp"]) {
    for (const outcome of ["completed", "failed", "declined", "timedOut"] as const) {
      if (transport === "mcp" && (outcome === "declined" || outcome === "timedOut")) continue;
      const identified = outcome === "completed";
      const item = transport === "cli" ? proposalCommandItem() : proposalMcpItem();
      if (!identified) {
        item.status = "failed";
        if (item.type === "commandExecution") {
          item.status = outcome === "declined" ? "declined" : "failed";
          item.exitCode = outcome === "declined" ? null : outcome === "timedOut" ? 124 : 1;
          item.aggregatedOutput = "agent-only-detail";
        } else {
          item.error = { message: "agent-only-detail" };
          item.result = null;
        }
      }
      const html = renderToStaticMarkup(createElement(WorkbenchClientProvider, {
        client,
        children: createElement(WorkbenchContextMenuProvider, null, createElement(ThreadTurnDetails, {
          defaultOpenCompletedWork: true,
          projectRootPath: "C:/workspace",
          threadId: "thread-one",
          turn: {
            completedAt: null, durationMs: 5, error: null, id: "turn-one",
            items: [item], itemsView: "full", startedAt: null, status: "completed",
          },
        })),
      }));
      // Collapsed transcript proposals never mount (or read) their commit card.
      assert.doesNotMatch(html, /data-thread-checkpoint-card=/u, transport);
      assert.match(html, /data-thread-git-arc-card="propose"/u, transport);
      if (identified) {
        assert.match(html, /Clean finished thread tail/u, transport);
        assert.doesNotMatch(html, /data-thread-git-arc-failure=/u);
      } else {
        if (outcome !== "timedOut") assert.match(html, /data-thread-git-arc-failure=/u, transport);
        assert.doesNotMatch(html, /agent-only-detail/u, transport);
      }
    }
  }
});

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

test("proposal cards consume loaded validity from thread observation", () => {
  const proposal: GitCheckpointProposal = {
    amendTargetMessage: null,
    amendTargetSha: null,
    baseCommit: "abcdef1",
    changes: [],
    committedSha: null,
    description: "",
    freshChanges: null,
    includeNewerAvailable: false,
    mode: "commit",
    paths: ["src/one.ts"],
    proposalId: "proposal-observed",
    status: "unavailable",
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Observed proposal",
    unavailableReason: "Proposal is no longer valid.",
  };
  const html = renderToStaticMarkup(createElement(ThreadGitArcObservationProvider, {
    lifecycleProposals: null,
    observeProposal: () => () => {},
    proposals: {
      [proposal.proposalId]: { proposal, status: "loaded" },
    },
    children: createElement(ThreadCheckpointCommitController, {
      cwd: "C:/workspace",
      harness: "codex",
      intent: null,
      proposalId: proposal.proposalId,
      sourceItemId: "proposal-item",
      threadId: "thread-one",
    }),
  }));

  assert.match(html, /Proposal is no longer valid\./u);
  assert.doesNotMatch(html, /aria-busy="true"/u);
});

test("hydrating proposal cards show the observed summary instead of skeletons", () => {
  const render = (summary: boolean) => renderToStaticMarkup(createElement(ThreadGitArcObservationProvider, {
    lifecycleProposals: [{
      proposalId: "proposal-hydrating",
      status: "proposed",
      ...(summary ? {
        summary: {
          changes: [{ additions: 7, deletions: 3, kind: "update", path: "src/one.ts" }],
          committedSha: null,
          description: "Observed description",
          mode: "commit",
          title: "Observed title",
        },
      } : {}),
    }],
    observeProposal: () => () => {},
    proposals: { "proposal-hydrating": { status: "loading" } },
    children: createElement(ThreadCheckpointCommitController, {
      cwd: "C:/workspace",
      harness: "codex",
      intent: null,
      proposalId: "proposal-hydrating",
      sourceItemId: "proposal-item",
      threadId: "thread-one",
    }),
  }));

  const observed = render(true);
  assert.match(observed, /Observed title/u);
  assert.match(observed, /Observed description/u);
  assert.match(observed, /1 changed file/u);
  assert.match(observed, />\+7</u);
  assert.doesNotMatch(observed, /aria-busy="true"/u);
  // Without a Git-derived summary (startup cache, older daemon) the card still loads.
  assert.match(render(false), /aria-busy="true"/u);
});

test("content amend proposals expose an amend-default fresh commit choice", () => {
  const proposal: GitCheckpointProposal = {
    amendTargetMessage: {
      description: "Current description",
      title: "Current title",
    },
    amendTargetSha: "abcdef2",
    baseCommit: "abcdef1",
    changes: [{
      additions: 4,
      deletions: 2,
      diff: "diff --git a/src/old.ts b/src/old.ts\n",
      kind: { move_path: null, type: "update" },
      path: "src/old.ts",
    }, {
      additions: 1,
      deletions: 1,
      diff: "diff --git a/src/one.ts b/src/one.ts\n",
      kind: { move_path: null, type: "update" },
      path: "src/one.ts",
    }],
    committedSha: null,
    description: "Current description",
    freshChanges: [{
      additions: 1,
      deletions: 1,
      diff: "diff --git a/src/one.ts b/src/one.ts\n",
      kind: { move_path: null, type: "update" },
      path: "src/one.ts",
    }],
    includeNewerAvailable: false,
    mode: "amend",
    paths: ["src/one.ts"],
    proposalId: "proposal-amend",
    status: "proposed",
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Proposed title",
    unavailableReason: null,
  };
  const renderCard = (commitMode: "amend" | "commit", title = proposal.title, description = proposal.description) => renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    commitMode,
    committing: false,
    description,
    freshCommitAvailable: true,
    includeNewer: false,
    onCommit: () => undefined,
    onCommitModeChange: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: proposal.paths,
    sourceItemId: "proposal-item",
    state: { proposal, status: "loaded" },
    title,
  }));
  const amendHtml = renderCard("amend");
  assert.match(amendHtml, /aria-label="Commit mode"/u);
  assert.match(amendHtml, /role="radiogroup"/u);
  assert.match(amendHtml, /<button(?=[^>]*role="radio")(?=[^>]*aria-checked="true")(?=[^>]*aria-label="Amend")[^>]*>/u);
  assert.match(amendHtml, /<button(?=[^>]*role="radio")(?=[^>]*aria-checked="false")(?=[^>]*aria-label="Commit fresh")[^>]*>/u);
  assert.doesNotMatch(amendHtml, /<input/u);
  assert.match(amendHtml, /2 changed files/u);
  assert.match(amendHtml, />\+5</u);
  assert.match(amendHtml, />-3</u);
  assert.match(amendHtml, /aria-label="Commit title differs from current commit"/u);
  assert.doesNotMatch(amendHtml, /aria-label="Commit description differs from current commit"/u);

  const descriptionChangedHtml = renderCard("amend", "Current title", "Changed description");
  assert.doesNotMatch(descriptionChangedHtml, /aria-label="Commit title differs from current commit"/u);
  assert.match(descriptionChangedHtml, /aria-label="Commit description differs from current commit"/u);

  const freshHtml = renderCard("commit", "Fresh title", "Fresh description");
  assert.match(freshHtml, /1 changed file/u);
  assert.match(freshHtml, />\+1</u);
  assert.match(freshHtml, />-1</u);
  assert.doesNotMatch(freshHtml, />\+5</u);
  assert.doesNotMatch(freshHtml, /differs from current commit/u);
});

test("finished tails hide only terminal reasoning; transcript proposals never vanish", () => {
  assert.deepEqual(
    hiddenTailIds([[messageItem("visible"), proposalCommandItem(), reasoningItem()]]),
    new Set(["terminal-reasoning"]),
  );
  assert.deepEqual(hiddenTailIds([[messageItem("visible")], [reasoningItem(), proposalMcpItem()]]), new Set());
  assert.deepEqual(hiddenTailIds([[proposalCommandItem(), reasoningItem(), messageItem("later")]]), new Set());
  assert.deepEqual(hiddenTailIds([[proposalCommandItem(), reasoningItem()]], false), new Set());
});
