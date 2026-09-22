/* No production exports. Regression wards cover proposal intent, source-turn indexing, editable message ownership, and terminal hoisting. */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { WorkbenchGitArcLifecycleState } from "workbench-shared/workbench/thread/thread-state";
import getThreadGitArcProposalPresentation, {
  getHoistedThreadGitArc,
  proposalIntentOwnsMessage,
} from "./thread-git-arc-presentation";
import { formatGitArcTextReceipt } from "workbench-shared/workbench/git/git-arc-receipts";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

test("plain reword receipts preserve message-only intent without content amendment", () => {
  const { intents } = getThreadGitArcProposalPresentation({
    turns: [turn("reword", [commandItem("reword", 'wb git arc reword --proposal old-id --title "correct message"', formatGitArcTextReceipt({
      action: "propose", claimedPaths: [], intentName: null, ref: "a".repeat(40), proposalId: "new-id", version: 1,
    }))])],
  });
  assert.equal(intents.get("new-id")?.amend, false);
  assert.deepEqual(intents.get("new-id")?.paths, []);
  assert.equal(intents.get("new-id")?.title, "correct message");
});

function commandItem(id: string, command: string, aggregatedOutput: string | null): CommandItem {
  return {
    aggregatedOutput,
    command,
    commandActions: [],
    cwd: "C:/workspace",
    durationMs: 10,
    exitCode: 0,
    id,
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
}

function turn(id: string, items: ThreadItem[]): Turn {
  return {
    completedAt: null,
    durationMs: 10,
    error: null,
    id,
    items,
    itemsView: "full",
    startedAt: null,
    status: "completed",
  };
}

function gitArc({
  claimedPaths = [],
  proposals = [],
}: {
  claimedPaths?: string[];
  proposals?: WorkbenchGitArcLifecycleState["proposals"];
} = {}): WorkbenchGitArcLifecycleState {
  return {
    checkpointCommit: "a".repeat(40),
    claimedPaths,
    intentDescription: "",
    intentName: "test",
    phase: claimedPaths.length ? "active" : "resolved",
    proposals,
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function stashedGitArc(proposals: WorkbenchGitArcLifecycleState["proposals"] = []): WorkbenchGitArcLifecycleState {
  return {
    checkpointCommit: "a".repeat(40),
    claimedPaths: [],
    intentDescription: "",
    intentName: "test",
    phase: "stashed",
    proposals,
    stashedPaths: ["src/one.ts"],
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function proposal(proposalId: string, status: GitCheckpointProposal["status"]): GitCheckpointProposal {
  return {
    amendTargetMessage: null,
    amendTargetSha: null,
    baseCommit: "a".repeat(40),
    changes: [],
    committedSha: status === "committed" ? "b".repeat(40) : null,
    description: "",
    freshChanges: null,
    includeNewerAvailable: false,
    mode: "commit",
    paths: ["src/one.ts"],
    proposalId,
    status,
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Proposal",
    unavailableReason: status === "unavailable" ? "Proposal is no longer valid." : null,
  };
}

function observed(value: GitCheckpointProposal) {
  return { proposal: { proposal: value, status: "loaded" as const } };
}

test("terminal Git arc hoisting keeps only useful current work", () => {
  const currentTurn = turn("current", []);
  const oldProposalTurns = new Map([["proposal", "old"]]);
  const currentProposalTurns = new Map([["proposal", currentTurn.id]]);

  assert.equal(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc(),
    proposalObservations: {},
    proposalTurnIds: oldProposalTurns,
  }), null, "invalid or filtered proposals leave no card");
  assert.ok(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({ proposals: [{ proposalId: "proposal", status: "proposed" }] }),
    proposalObservations: { proposal: { status: "loading" } },
    proposalTurnIds: oldProposalTurns,
  }), "loading proposals hoist from durable lifecycle state");
  assert.equal(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({ proposals: [{ proposalId: "proposal", status: "proposed" }] }),
    proposalObservations: observed(proposal("proposal", "unavailable")),
    proposalTurnIds: oldProposalTurns,
  }), null, "loaded invalid proposals do not hoist");
  assert.ok(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({ proposals: [{ proposalId: "proposal", status: "proposed" }] }),
    proposalObservations: observed(proposal("proposal", "proposed")),
    proposalTurnIds: oldProposalTurns,
  }), "old pending proposals remain actionable");
  assert.equal(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({ proposals: [{ proposalId: "proposal", status: "committed" }] }),
    proposalObservations: observed(proposal("proposal", "committed")),
    proposalTurnIds: oldProposalTurns,
  }), null, "old accepted-only proposals stop hoisting");
  assert.ok(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({ proposals: [{ proposalId: "proposal", status: "committed" }] }),
    proposalObservations: observed(proposal("proposal", "committed")),
    proposalTurnIds: currentProposalTurns,
  }), "current accepted-only proposals remain visible");
  assert.deepEqual(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({
      claimedPaths: ["src/one.ts"],
      proposals: [{ proposalId: "proposal", status: "committed" }],
    }),
    proposalObservations: { proposal: { status: "loading" } },
    proposalTurnIds: oldProposalTurns,
  })?.proposals, [{ proposalId: "proposal", status: "committed" }], "live claims show durable proposal rows while hydration loads");
  assert.ok(getHoistedThreadGitArc({
    currentTurn,
    gitArc: gitArc({
      proposals: [
        { proposalId: "accepted", status: "committed" },
        { proposalId: "pending", status: "proposed" },
      ],
    }),
    proposalObservations: {
      accepted: { proposal: proposal("accepted", "committed"), status: "loaded" },
      pending: { proposal: proposal("pending", "proposed"), status: "loaded" },
    },
    proposalTurnIds: new Map([["accepted", "old"], ["pending", "old"]]),
  }), "any pending proposal keeps a mixed lifecycle visible");
  assert.equal(getHoistedThreadGitArc({
    currentTurn: { ...currentTurn, status: "inProgress" },
    gitArc: gitArc({
      claimedPaths: ["src/one.ts"],
      proposals: [{ proposalId: "proposal", status: "proposed" }],
    }),
    proposalObservations: observed(proposal("proposal", "proposed")),
    proposalTurnIds: currentProposalTurns,
  }), null, "an in-progress latest turn suppresses terminal presentation");
});

test("a stashed arc stays hoisted while its proposals are no longer actionable", () => {
  const currentTurn = turn("current", []);
  const oldProposalTurns = new Map([["proposal", "old"]]);

  assert.ok(getHoistedThreadGitArc({
    currentTurn,
    gitArc: stashedGitArc([{ proposalId: "proposal", status: "proposed" }]),
    proposalObservations: observed(proposal("proposal", "unavailable")),
    proposalTurnIds: oldProposalTurns,
  }), "stashed files stay recoverable while their proposal is invalid");
  assert.ok(getHoistedThreadGitArc({
    currentTurn,
    gitArc: stashedGitArc([{ proposalId: "proposal", status: "committed" }]),
    proposalObservations: observed(proposal("proposal", "committed")),
    proposalTurnIds: oldProposalTurns,
  }), "stashed files stay recoverable after their proposal is accepted");
  assert.equal(getHoistedThreadGitArc({
    currentTurn: { ...currentTurn, status: "inProgress" },
    gitArc: stashedGitArc([{ proposalId: "proposal", status: "proposed" }]),
    proposalObservations: {},
    proposalTurnIds: oldProposalTurns,
  }), null, "an in-progress latest turn still suppresses stashed presentation");
});

test("visible proposal intents associate title and description with the proposal receipt", () => {
  const { intents } = getThreadGitArcProposalPresentation({
    projectRootPath: "C:/workspace",
    turns: [turn("turn-one", [
      commandItem("ordinary", "pnpm typecheck", null),
      commandItem(
        "proposal",
        "wb git arc propose --amend --title \"Preview hoisted proposal\" --description \"Show both fields immediately.\" --fresh-title \"Commit correction separately\" --fresh-description \"Keep prior history unchanged.\" -- src/one.ts",
        "Workbench arc proposal: proposal-one\n",
      ),
    ])],
  });

  assert.deepEqual(intents.get("proposal-one"), {
    amend: true,
    description: "Show both fields immediately.",
    freshDescription: "Keep prior history unchanged.",
    freshTitle: "Commit correction separately",
    paths: ["src/one.ts"],
    title: "Preview hoisted proposal",
  });
  assert.equal(intents.size, 1);
});

test("later loaded transcript entries replace an earlier intent and source turn for the same proposal", () => {
  const { intents, proposalTurnIds } = getThreadGitArcProposalPresentation({
    turns: [
      turn("turn-one", [commandItem(
        "proposal-one",
        "wb git arc propose --title \"Earlier title\"",
        "Workbench arc proposal: shared-proposal\n",
      )]),
      turn("turn-two", [commandItem(
        "proposal-two",
        "wb git arc propose --title \"Later title\" --description \"Latest visible description\"",
        "Workbench arc proposal: shared-proposal\n",
      )]),
    ],
  });

  assert.equal(intents.get("shared-proposal")?.title, "Later title");
  assert.equal(intents.get("shared-proposal")?.description, "Latest visible description");
  assert.equal(proposalTurnIds.get("shared-proposal"), "turn-two");
});

test("visible proposal intents resolve a preceding literal PowerShell here-string", () => {
  const description = "- preserve proposal claims\n- retry the same Commit action";
  const command = String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "$description = @'
${description}
'@
wb git arc propose --replace proposal-one --title \"keep proposal recovery ordinary\" --description $description"`;
  const { intents } = getThreadGitArcProposalPresentation({
    projectRootPath: "C:/workspace",
    turns: [turn("turn-one", [commandItem(
      "proposal",
      command,
      "Workbench arc proposal: proposal-one\n",
    )])],
  });

  assert.deepEqual(intents.get("proposal-one"), {
    amend: false,
    description,
    paths: [],
    title: "keep proposal recovery ordinary",
  });
});

test("only proposal intent with an explicit title owns the editable message", () => {
  assert.equal(proposalIntentOwnsMessage({
    amend: true,
    description: "Ignored without a replacement title",
    paths: [],
    title: "",
  }), false);
  assert.equal(proposalIntentOwnsMessage({
    amend: true,
    description: "",
    paths: [],
    title: "Replacement title",
  }), true);
  assert.equal(proposalIntentOwnsMessage({
    amend: false,
    description: "",
    paths: [],
    title: "New commit title",
  }), true);
});

test("MCP amend proposal intents preserve both user-selectable messages", () => {
  const item: Extract<ThreadItem, { type: "mcpToolCall" }> = {
    appContext: null,
    arguments: {
      amend: true,
      description: "Rewrite the accepted message.",
      freshDescription: "Keep accepted history intact.",
      freshTitle: "Add the correction",
      paths: ["src/one.ts"],
      title: "Amend the correction",
    },
    durationMs: 10,
    error: null,
    id: "proposal-mcp",
    pluginId: null,
    readOnlyHint: false,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Workbench arc proposal: proposal-mcp\n" }],
      structuredContent: null,
    },
    server: "wb",
    status: "completed",
    tool: "git_arc_propose",
    type: "mcpToolCall",
  };
  const { intents } = getThreadGitArcProposalPresentation({ turns: [turn("turn-one", [item])] });
  assert.deepEqual(intents.get("proposal-mcp"), {
    amend: true,
    description: "Rewrite the accepted message.",
    freshDescription: "Keep accepted history intact.",
    freshTitle: "Add the correction",
    paths: ["src/one.ts"],
    title: "Amend the correction",
  });
});
