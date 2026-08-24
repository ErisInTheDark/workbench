/*
 * Exports:
 * - No production exports; Node tests protect checkpoint compare reuse, immediate proposal cards, summary actions, and clean diff rendering. Keywords: checkpoint, compare, proposal, card, file changes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement, Fragment, isValidElement, type KeyboardEvent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseUnifiedDiff } from "../../../lib/workbench/thread/thread-file-diff";
import { getGitArcMatcherAction, getThreadCommandDisplay } from "../../../lib/workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";
import ThreadCheckpointCommitItem from "./ThreadCheckpointCommitItem";
import ThreadCheckpointCompareItem from "./ThreadCheckpointCompareItem";
import ThreadCodeDisplay from "./ThreadCodeDisplay";
import ThreadGitArcItem from "./ThreadGitArcItem";
import ThreadGitArcLifecycleCard from "./ThreadGitArcLifecycleCard";
import ThreadGitArcPresentationContext, { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";
import ThreadPlanConflictCard from "./ThreadPlanConflictCard";
import { ThreadTurnDetails } from "./thread-view-items";
import WorkbenchContextMenuContext from "../WorkbenchContextMenuContext";

interface EditableElementProps {
  ariaLabel?: string;
  children?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function findEditableProps(node: ReactNode): EditableElementProps[] {
  if (Array.isArray(node)) {
    return node.flatMap(findEditableProps);
  }
  if (!isValidElement<EditableElementProps>(node)) {
    return [];
  }

  const descendants = findEditableProps(node.props.children);
  return node.props.ariaLabel?.startsWith("Commit ")
    ? [node.props, ...descendants]
    : descendants;
}

function proposedCheckpointState(status: "proposed" | "superseded" | "unavailable" = "proposed") {
  return {
    proposal: {
      amendTargetSha: null,
      baseCommit: "a".repeat(40),
      changes: [],
      committedSha: null,
      description: "Commit description",
      includeNewerAvailable: false,
      mode: "commit" as const,
      paths: ["src/one.ts"],
      proposalId: "proposal-one",
      status,
      supersededByProposalId: null,
      supersededBySha: null,
      title: "Commit title",
      unavailableReason: status === "unavailable" ? "Unavailable." : null,
    },
    status: "loaded" as const,
  };
}

test("checkpoint compare uses established file-change rows without empty disclosures", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCompareItem, {
    changes: [
      { additions: 4, deletions: 2, path: "src/edited.ts", status: "U" },
      { additions: 3, deletions: 0, path: "src/created.ts", status: "A" },
      { additions: 0, deletions: 5, path: "src/deleted.ts", status: "D" },
    ],
    projectRootPath: "C:/workspace",
  }));

  assert.match(html, />Edited</u);
  assert.match(html, />Created</u);
  assert.match(html, />Deleted</u);
  assert.match(html, /src\/edited\.ts/u);
  assert.match(html, />\+4</u);
  assert.match(html, />-2</u);
  assert.doesNotMatch(html, /<button/u);
  assert.doesNotMatch(html, /No diff captured/u);
});

test("terminal arc presentation hoists one proposal controller and leaves a transcript pointer", () => {
  const shared = {
    commandOutcome: "completed" as const,
    cwd: "C:/workspace",
    intent: null,
    proposalId: "def81282-proposal-one",
    sourceItemId: "proposal-item",
    threadId: "thread-one",
  };
  const html = renderToStaticMarkup(createElement(ThreadGitArcPresentationContext.Provider, {
    value: {
      harness: "opencode",
      hoistedProposalId: "def81282-proposal-one",
      proposalIntents: new Map([["def81282-proposal-one", {
        amend: false,
        description: "Keep its message visible before enrichment.",
        paths: ["src/one.ts"],
        title: "Harden arc ownership workflow",
      }]]),
    },
    children: createElement(Fragment, null,
      createElement(ThreadCheckpointCommitItem, shared),
      createElement(ThreadCheckpointCommitItem, { ...shared, hoisted: true, sourceItemId: "lifecycle-proposal" }),
    ),
  }));
  assert.equal((html.match(/>Commit</gu) ?? []).length, 1);
  assert.match(html, /data-thread-git-arc-card="propose"/u);
  assert.match(html, />Proposed</u);
  assert.match(html, /Harden arc ownership workflow/u);
  assert.match(html, /Keep its message visible before enrichment\./u);
  assert.match(html, /def81282/u);
  assert.doesNotMatch(html, /\[proposed a commit\]/u);
  assert.match(html, /id="thread-checkpoint-proposal-def81282-proposal-one"/u);
  assert.equal((html.match(/data-thread-checkpoint-card="true"/gu) ?? []).length, 1);
});

test("terminal arc release action distinguishes clean claims from dirty work", () => {
  assert.equal(getGitArcClaimReleaseAction(0), "unclaim");
  assert.equal(getGitArcClaimReleaseAction(1), "restore");
});

test("terminal proposals and claim resolution share one lifecycle card", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcLifecycleCard, {
    claim: {
      checkpointCommit: "a".repeat(40),
      claimedPaths: ["src/one.ts", "src/two.ts"],
      intentDescription: "Keep the lifecycle visible.",
      intentName: "Harden arc lifecycle",
      proposalIds: ["proposal-one", "proposal-two"],
      reloadScopes: ["orchestrator-logic", "mcp"],
      proposals: [
        { proposalId: "proposal-one", status: "proposed" },
        { proposalId: "proposal-two", status: "committed" },
        { proposalId: "proposal-unavailable", status: "unavailable" },
        { proposalId: "proposal-rescinded", status: "rescinded" },
        { proposalId: "proposal-superseded", status: "superseded" },
      ],
      updatedAt: "2026-08-19T00:00:00.000Z",
    },
    cwd: "C:/workspace",
    harness: "codex",
    onReleased: async () => undefined,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    threadLifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  }));

  assert.equal((html.match(/data-thread-git-arc-lifecycle-card="true"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-thread-checkpoint-card="true"/gu) ?? []).length, 2);
  assert.equal((html.match(/data-thread-git-arc-proposal-separator="true"/gu) ?? []).length, 1);
  assert.match(html, /data-thread-checkpoint-card-embedded="true"/u);
  assert.match(html, /data-thread-git-arc-resolution="true"/u);
  assert.match(html, /data-thread-git-arc-resolution-separator="true"/u);
  assert.match(html, /2 claimed files/u);
  assert.match(html, /data-thread-reload-scopes="true"/u);
  assert.match(html, /data-thread-reload-scope="orchestrator-logic"[\s\S]*data-thread-reload-scope="mcp"/u);
  assert.match(html, /Checking claimed files/u);
  assert.doesNotMatch(html, /Harden arc lifecycle/u);
});

test("completed lifecycle cards hide reload scopes without hiding proposals or claim resolution", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcLifecycleCard, {
    claim: {
      checkpointCommit: "a".repeat(40), claimedPaths: ["src/one.ts"], intentDescription: "", intentName: "Completed arc",
      phase: "active", proposals: [{ proposalId: "proposal-one", status: "proposed" }], reloadScopes: ["mcp"],
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
    cwd: "C:/workspace", harness: "codex", onReleased: async () => undefined, projectRootPath: "C:/workspace",
    threadId: "thread-one", threadLifecycle: { kind: "completed", reason: "userCompleted", settled: false },
  }));
  assert.match(html, /data-thread-checkpoint-card="true"/u);
  assert.match(html, /data-thread-git-arc-resolution="true"/u);
  assert.match(html, /1 claimed file/u);
  assert.doesNotMatch(html, /data-thread-reload-scopes/u);
});

test("resolved arc cards keep committed proposals hoisted without live claim controls", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcLifecycleCard, {
    claim: {
      checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "Resolved arc",
      phase: "resolved", proposalIds: ["committed-one", "unavailable-one", "rescinded-one", "superseded-one"],
      proposals: [
        { proposalId: "committed-one", status: "committed" },
        { proposalId: "unavailable-one", status: "unavailable" },
        { proposalId: "rescinded-one", status: "rescinded" },
        { proposalId: "superseded-one", status: "superseded" },
      ],
      updatedAt: "2026-08-20T00:00:00.000Z",
    } as never,
    cwd: "C:/workspace", harness: "codex", onReleased: async () => undefined, projectRootPath: "C:/workspace", threadId: "thread-one",
    threadLifecycle: { kind: "completed", reason: "userCompleted", settled: false },
  }));
  assert.equal((html.match(/data-thread-checkpoint-card="true"/gu) ?? []).length, 1);
  assert.match(html, /committed-one/u);
  assert.doesNotMatch(html, /unavailable-one/u);
  assert.doesNotMatch(html, /rescinded-one|superseded-one/u);
  assert.doesNotMatch(html, /data-thread-git-arc-resolution/u);
  assert.doesNotMatch(html, />Resolved</u);
  assert.doesNotMatch(html, /Restore &amp; unclaim|Unclaim files/u);
});

test("claims-only lifecycle cards do not masquerade as start receipts", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcLifecycleCard, {
    claim: {
      checkpointCommit: "a".repeat(40), claimedPaths: ["api:src/contract.ts"], intentDescription: "", intentName: "Workspace arc",
      phase: "active", proposalIds: [], proposals: [], updatedAt: "2026-08-24T00:00:00.000Z",
    } as never,
    cwd: "C:/workspace/api", harness: "codex", onReleased: async () => undefined,
    projectRootPath: "C:/workspace/api", threadId: "thread-one",
    threadLifecycle: { kind: "completed", reason: "userCompleted", settled: false },
  }));
  assert.match(html, /1 claimed file/u);
  assert.match(html, /data-thread-git-arc-resolution="true"/u);
  assert.doesNotMatch(html, /data-thread-git-arc-card="start"|Workspace arc|>Started</u);
});

test("resolved lifecycle state without proposals or claims renders no terminal card", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcLifecycleCard, {
    claim: {
      checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "Finished arc",
      phase: "resolved", proposalIds: [], proposals: [], updatedAt: "2026-08-24T00:00:00.000Z",
    } as never,
    cwd: "C:/workspace", harness: "codex", onReleased: async () => undefined,
    projectRootPath: "C:/workspace", threadId: "thread-one",
    threadLifecycle: { kind: "completed", reason: "userCompleted", settled: false },
  }));
  assert.equal(html, "");
});

test("ThreadView keeps lifecycle cards terminal while showing plan conflicts during active turns", async () => {
  const source = await readFile(new URL("./ThreadView.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("activeGitArcSelection.gitArc"), true);
  assert.equal(source.includes("activeGitArcSelectionRef"), true);
  assert.equal(source.includes("areDeeplyEqual(activeGitArcSelectionRef.current, next)"), true);
  assert.equal(source.includes('currentTurn?.status !== "inProgress"'), true);
  assert.match(source, /\{activeThread && !isDraftThreadView \? \(\s*<ThreadPlanConflictCard/u);
  assert.doesNotMatch(source, /activeThread && !isDraftThreadView && currentTurn\?\.status[^\n]+\n\s*<ThreadPlanConflictCard/u);
  assert.equal(source.includes("terminalFileClaim") || source.includes("activeSidebarEntry.fileClaim"), false);
  assert.equal(source.includes("proposalIntents: visibleGitArcProposalIntents"), true);
});

test("planned conflict card renders collapsed shared thread rows without tooltips or dividers", () => {
  const owner = {
    activityAt: 10,
    entryKind: "thread" as const,
    gitArcPlan: {
      checkpointCommit: "a".repeat(40), intentDescription: "", intentName: "plan",
      scopePaths: ["src/feature"], updatedAt: "2026-08-21T00:00:00.000Z",
    },
    identity: { harness: "codex" as const, threadId: "owner" },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false as const },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    title: "Owner",
  };
  const claimant = {
    ...owner,
    gitArc: {
      checkpointCommit: "b".repeat(40), claimedPaths: ["src/feature/card.tsx"], intentDescription: "", intentName: "claim",
      phase: "active" as const, proposals: [], updatedAt: "2026-08-21T00:00:00.000Z",
    },
    gitArcPlan: null,
    identity: { harness: "opencode" as const, threadId: "claimant" },
    title: "Claiming thread",
  };
  const snapshot = { entries: [owner, claimant], error: null, freshness: "fresh" as const, projectId: "project", revision: 1 };
  const html = renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined } },
    createElement(ThreadPlanConflictCard, {
      harness: "codex",
      onOpenThread: () => undefined,
      projectId: "project",
      store: { getSnapshot: () => snapshot, subscribe: () => () => undefined },
      threadId: "owner",
    }),
  ));
  assert.match(html, /data-thread-plan-conflict-card="true"/u);
  assert.match(html, /Claiming thread/u);
});

test("claim collision failures reuse live compact thread rows and label failed paths directly", () => {
  const claimant = {
    activityAt: 10,
    entryKind: "thread" as const,
    gitArc: {
      checkpointCommit: "b".repeat(40), claimedPaths: ["src/feature/card.tsx"], intentDescription: "", intentName: "claim",
      phase: "active" as const, proposals: [], updatedAt: "2026-08-21T00:00:00.000Z",
    },
    gitArcPlan: null,
    identity: { harness: "opencode" as const, threadId: "claimant" },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false as const },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    title: "Claiming thread",
  };
  const snapshot = { entries: [claimant], error: null, freshness: "fresh" as const, projectId: "project", revision: 1 };
  const failure = {
    action: "arcAdd",
    code: "siblingClaimCollision",
    conflicts: [{
      overlaps: [{ claimedPath: "src/feature/card.tsx", requestedPath: "src/feature/card.tsx" }],
      owner: {
        checkpointCommit: "b".repeat(40), harness: "opencode", intentName: "claim", lifecycle: "completed",
        threadId: "claimant", title: "Claiming thread",
      },
    }],
    version: 1,
  } as const;
  const html = renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined } },
    createElement(ThreadGitArcPresentationContext.Provider, {
      value: {
        harness: "codex",
        onOpenThread: () => undefined,
        projectId: "project",
        threadSidebarStore: { getSnapshot: () => snapshot, subscribe: () => () => undefined },
      },
      children: createElement(ThreadGitArcItem, {
        commandIntent: { action: "add", intentName: null, paths: ["src/feature/card.tsx"], ref: null },
        durationMs: 10,
        failureReason: `Workbench arc failure: ${JSON.stringify(failure)}`,
        outcome: "failed",
        projectId: "project",
        receipt: null,
      }),
    }),
  ));
  assert.match(html, />Failed to claim</u);
  assert.match(html, /data-thread-git-arc-failure-panel="true"/u);
  assert.match(html, /data-thread-git-arc-failure-facts="true"/u);
  assert.match(html, /data-thread-git-arc-conflict-list="true"/u);
  assert.match(html, /Claiming thread/u);
  assert.doesNotMatch(html, /claims src\/feature\/card\.tsx through requested path/u);
});

test("arc start collision failures derive failed claim rows from the typed failure", () => {
  const failure = {
    action: "arcStart",
    code: "siblingClaimCollision",
    conflicts: [{
      overlaps: [{ claimedPath: "src/feature", requestedPath: "src/feature/card.tsx" }],
      owner: {
        checkpointCommit: "b".repeat(40), harness: "opencode", intentName: "claim", lifecycle: "working",
        threadId: "claimant", title: "Claiming thread",
      },
    }],
    version: 1,
  } as const;
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "start", intentName: null, paths: [], ref: "a".repeat(40) },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(failure)}`,
    outcome: "failed",
    projectId: "project",
    receipt: null,
  }));
  assert.match(html, />Failed to claim</u);
  assert.match(html, /card\.tsx/u);
  assert.doesNotMatch(html, /claims src\/feature through requested path/u);
});

test("missing arc refs render one concise message without a hint", () => {
  const failure = { action: "arcStart", code: "missingArcRef", ref: "deadbeef", version: 1 } as const;
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "start", intentName: null, paths: [], ref: "deadbeef" },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(failure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(html, /There is no git arc by the <code[^>]*>deadbeef<\/code> ref\./u);
  assert.match(html, /data-thread-inline-code="true"/u);
  assert.doesNotMatch(html, /Git arc operation rejected|data-thread-git-arc-failure-hint/u);
});

test("dirty plan failures put changed-file meaning on danger path rows", () => {
  const failure = { action: "plan", code: "dirtyPaths", paths: ["webapp/.git-arc-failure-demo.txt"], version: 1 } as const;
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "plan", intentName: "Show dirty paths", paths: [...failure.paths], ref: null },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(failure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(html, /Failed to plan changed file/u);
  assert.match(html, /data-thread-git-arc-path-tone="danger"/u);
  assert.match(html, /Cannot plan against unclaimed workspace dirt\./u);
  assert.match(html, /data-thread-git-arc-failure-panel="true"/u);
  assert.match(html, /data-thread-git-arc-failure-hint="true"/u);
  assert.doesNotMatch(html, /Selected paths contain workspace changes/u);
});

test("ignored path failures mirror dirty rows with only a simple message and hint", () => {
  const ignoredPath = "generated/output.ts";
  const planFailure = { action: "plan", code: "ignoredPaths", paths: [ignoredPath], version: 1 } as const;
  const planHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: {
      action: "plan",
      adoptPaths: [ignoredPath],
      intentName: "Reject ignored plan",
      paths: ["src/ordinary.ts", ignoredPath],
      ref: null,
    },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(planFailure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(planHtml, /Failed to plan ignored file/u);
  assert.match(planHtml, /generated\/output\.ts/u);
  assert.match(planHtml, /data-thread-git-arc-path-tone="danger"/u);
  assert.match(planHtml, /Git ignores the selected file\./u);
  assert.match(planHtml, /Remove the ignore rule or choose a file Git tracks\./u);
  assert.doesNotMatch(planHtml, /src\/ordinary\.ts|Failed to adopt|data-thread-git-arc-failure-facts/u);

  const claimFailure = { action: "arcAdd", code: "ignoredPaths", paths: [ignoredPath], version: 1 } as const;
  const claimHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "add", intentName: null, paths: [ignoredPath], ref: null },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(claimFailure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(claimHtml, /Failed to claim ignored file/u);
  assert.match(claimHtml, /generated\/output\.ts/u);
  assert.match(claimHtml, /data-thread-git-arc-path-tone="danger"/u);
  assert.doesNotMatch(claimHtml, /data-thread-git-arc-failure-facts/u);

  const moveFailure = { ...claimFailure, action: "arcMove" } as const;
  const moveHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: {
      action: "mv",
      intentName: null,
      move: { kind: "operands", operands: ["src/input.ts", ignoredPath] },
      paths: ["src/input.ts", ignoredPath],
      ref: null,
    },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(moveFailure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(moveHtml, /Failed to claim ignored file/u);
  assert.match(moveHtml, /generated\/output\.ts/u);
  assert.doesNotMatch(moveHtml, /src\/input\.ts|data-thread-git-arc-move/u);
});

test("plan drift failures put drift meaning on claim rows and keep commands out of the user hint", () => {
  const failure = {
    action: "arcStart",
    code: "planDrift",
    commits: [],
    conflicts: [],
    dirtyPaths: ["webapp/.git-arc-failure-demo.txt"],
    headMovement: "same",
    planRef: "b".repeat(40),
    snapshotPaths: ["webapp/.git-arc-failure-demo.txt"],
    version: 1,
  } as const;
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "start", intentName: null, paths: [], ref: failure.planRef },
    durationMs: 10,
    failureReason: `Workbench arc failure: ${JSON.stringify(failure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(html, /Failed to claim drifted file/u);
  assert.match(html, /data-thread-git-arc-path-tone="danger"/u);
  assert.match(html, /The plan baseline changed\./u);
  assert.match(html, /data-thread-git-arc-failure-hint="true"/u);
  assert.doesNotMatch(html, /Dirty unclaimed|mcp__wb__|wb git arc/u);
});

test("accepted proposal failures keep the failed continuation title and render commit facts outside recovery copy", () => {
  const failure = {
    action: "arcContinue",
    claimedPaths: [],
    code: "acceptedProposals",
    proposals: [{
      commitSha: "29c0dd7f52498b2fd740514c5d5e482605371807",
      proposalId: "80d73f22-2adc-4bd3-83e0-affa363743eb",
      title: "fix accepted arc work",
    }, {
      commitSha: "c".repeat(40),
      proposalId: "historical-proposal-without-title",
    }],
    version: 1,
  } as const;
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "continue", intentName: null, paths: [], ref: "a".repeat(40) },
    durationMs: 597,
    failureReason: `Workbench arc failure: ${JSON.stringify(failure)}`,
    outcome: "failed",
    receipt: null,
  }));
  assert.match(html, />Failed to continue</u);
  assert.match(html, /This Git arc is already resolved and owns no live claims\./u);
  assert.match(html, /data-thread-git-arc-accepted-proposals="true"/u);
  assert.match(html, /fix accepted arc work/u);
  assert.match(html, /29c0dd7f/u);
  assert.match(html, /Accepted commit/u);
  assert.match(html, /cccccccc/u);
  assert.match(html, /data-thread-inline-code="true"/u);
  assert.doesNotMatch(html, /80d73f22-2adc-4bd3-83e0-affa363743eb|historical-proposal-without-title|mcp__wb__|wb git arc/u);
});

test("committed proposal failures render commit facts without agent recovery", () => {
  const proposalId = "9cd56341-dcaa-45e8-9087-eba31189cb90";
  const commitSha = "31bc36632553ac151dc3c3f9585625442f2d2208";
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: [],
    sourceItemId: "committed-proposal-failure",
    state: {
      error: "agent-only formatted failure",
      failure: {
        action: "proposalCreate",
        code: "proposalAlreadyCommitted",
        commitSha,
        proposalId,
        proposalTitle: "fix stale Git arc state",
        version: 1,
      },
      retryable: false,
      status: "error",
    },
    title: "fix stale Git arc state and explicit ref rejection",
  }));

  assert.match(html, /data-thread-git-arc-failure="proposalAlreadyCommitted"/u);
  assert.match(html, /fix stale Git arc state/u);
  assert.match(html, /31bc3663/u);
  assert.match(html, /data-thread-inline-code="true"/u);
  assert.doesNotMatch(html, new RegExp(`${proposalId}|mcp__wb__|wb git arc`, "u"));
});

test("timed-out plans use timeout labels without inventing a Git failure", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "plan", intentName: "strengthen test quality guidance", paths: ["workbench-agents-prompt.md"], ref: null },
    durationMs: 11_000,
    failureReason: "The command timed out before returning a Git response.",
    outcome: "timedOut",
    receipt: null,
  }));
  assert.match(html, /Timed out planning/u);
  assert.match(html, /strengthen test quality guidance/u);
  assert.match(html, /data-thread-git-arc-path-tone="danger"/u);
  assert.doesNotMatch(html, /data-thread-git-arc-failure=/u);
});

test("in-progress checkpoint commit commands render an immediate standalone card", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: null,
        command: "wb git arc propose -m \"Immediate proposal\" -- src/one.ts src/two.ts",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: null,
        exitCode: null,
        id: "proposal-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "inProgress",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "inProgress",
    },
  }));

  assert.match(html, /data-thread-checkpoint-card="true"/u);
  assert.match(html, /Immediate proposal/u);
  assert.match(html, /2 changed files/u);
  assert.doesNotMatch(html, /Loading commit proposal/u);
  assert.doesNotMatch(html, /Creating checkpoint commit proposal/u);
});

test("PowerShell-wrapped proposals render the standalone card from command text", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 4_000,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: "Workbench arc proposal: proposal-one\n",
        command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "wb git arc propose -m \"Group thread context menu controls\" -m \"Preserve Chiri's lifecycle status.\""`,
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 4_000,
        exitCode: 0,
        id: "proposal-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "completed",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));

  assert.match(html, /data-thread-checkpoint-card="true"/u);
  assert.match(html, /Group thread context menu controls/u);
  assert.match(html, /Preserve Chiri&#x27;s lifecycle status\./u);
  assert.doesNotMatch(html, /Working dir:|pwsh\.exe/u);
});

test("matched proposal invocations keep their card when intent enrichment fails", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: null,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: null,
        command: "wb git arc propose --unexpected",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: null,
        exitCode: null,
        id: "proposal-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "inProgress",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "inProgress",
    },
  }));

  assert.match(html, /data-thread-checkpoint-card="true"/u);
  assert.doesNotMatch(html, /Creating arc commit proposal/u);
});

test("superseded proposal cards preserve their terminal history", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/one.ts"],
    sourceItemId: "proposal-command",
    state: proposedCheckpointState("superseded"),
    title: "Old proposal",
  }));

  assert.match(html, />Superseded</u);
  assert.doesNotMatch(html, />Commit<\/span>/u);
});

test("arc lifecycle commands render compact receipt-backed cards", () => {
  const ref = "a".repeat(40);
  const display = getThreadCommandDisplay({
    command: `wb git arc plan -m "Polish arc UI" -- src/one.ts src/two.ts`,
    commandActions: [],
    cwd: "C:/workspace",
    projectRootPath: "C:/workspace",
  });
  assert.equal(display.claimedBy, "git-arc.plan");
  assert.equal(getGitArcMatcherAction(display.claimedBy), "plan");
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 4_000,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: `Created Git plan ${ref}\nWorkbench arc receipt: {"action":"plan","claimedPaths":["src/one.ts","src/two.ts"],"intentName":"Polish arc UI","ref":"${ref}","selectedPaths":["src/one.ts","src/two.ts"],"version":1}\n`,
        command: `wb git arc plan -m "Polish arc UI" -- src/one.ts src/two.ts`,
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 4_000,
        exitCode: 0,
        id: "plan-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "completed",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));

  assert.match(html, /data-thread-git-arc-card="plan"/u);
  assert.match(html, /<details[^>]*open=""/u);
  assert.match(html, /Planned/u);
  assert.match(html, /Polish arc UI/u);
  assert.match(html, /aaaaaaaa/u);
  assert.match(html, /src\/one\.ts/u);
  assert.doesNotMatch(html, /Created Git plan [a-f0-9]{40}/u);
});

test("arc lifecycle cards stay outside adjacent generic command groups", () => {
  const ref = "a".repeat(40);
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 5_000,
      error: null,
      id: "turn-one",
      items: [
        {
          aggregatedOutput: `Restored 1 selected path from Git arc ${ref}\nWorkbench arc receipt: {"action":"restore","claimedPaths":["src/one.ts","src/two.ts"],"intentName":"Polish arc UI","ref":"${ref}","selectedPaths":["src/one.ts"],"version":1}\n`,
          command: `wb git arc restore --ref ${ref} -- src/one.ts`,
          commandActions: [],
          cwd: "C:/workspace",
          durationMs: 4_000,
          exitCode: 0,
          id: "restore-command",
          pluginId: null,
          processId: null,
          scriptPath: null,
          source: "agent",
          status: "completed",
          type: "commandExecution",
        },
        {
          aggregatedOutput: "False\n",
          command: "Test-Path -LiteralPath 'src/one.ts'",
          commandActions: [],
          cwd: "C:/workspace",
          durationMs: 1_000,
          exitCode: 0,
          id: "check-command",
          pluginId: null,
          processId: null,
          scriptPath: null,
          source: "agent",
          status: "completed",
          type: "commandExecution",
        },
      ],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));

  assert.match(html, /data-thread-git-arc-card="restore"/u);
  assert.match(html, />Restored</u);
  assert.match(html, /src\/one\.ts/u);
  assert.doesNotMatch(html, /Restored a git checkpoint, checked 1 path/u);
});

test("arc cards close compare details by default and nest claims for other open actions", () => {
  const previousRef = "a".repeat(40);
  const currentRef = "b".repeat(40);
  const receipt = {
    action: "add" as const,
    claimedPaths: ["src/existing.ts", "src/new.ts"],
    intentName: "Polish arc UI",
    ref: currentRef,
    selectedPaths: ["src/new.ts"],
    version: 1 as const,
  };
  const addHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "add", intentName: null, paths: ["src/new.ts"], ref: null },
    durationMs: 4_000,
    outcome: "completed",
    receipt,
  }));

  const selectedPathIndex = addHtml.indexOf("src/new.ts");
  const nestedClaimsIndex = addHtml.indexOf("2 claimed files");
  assert(selectedPathIndex >= 0);
  assert(nestedClaimsIndex > selectedPathIndex);
  assert.equal(addHtml.match(/open=""/gu)?.length, 1);
  assert.match(addHtml, />Claimed</u);
  assert.doesNotMatch(addHtml, />Claimed files</u);
  assert.match(addHtml, /Polish arc UI/u);

  const compareHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "compare", intentName: null, paths: [], ref: null },
    durationMs: 5_000,
    operationDetails: createElement("span", { "data-main-change": true }, "Changed file evidence"),
    outcome: "completed",
    receipt: { ...receipt, action: "compare" as const, selectedPaths: undefined },
  }));
  assert.doesNotMatch(compareHtml, /open=""/u);
  assert.doesNotMatch(compareHtml, /Changed file evidence|2 claimed files/u);

  const diffHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "diff", intentName: null, paths: [], ref: null },
    durationMs: 5_000,
    operationDetails: createElement("span", { "data-diff-artifact": true }, "Lazy diff evidence"),
    outcome: "completed",
    receipt: { ...receipt, action: "diff" as const, selectedPaths: undefined },
  }));
  assert.doesNotMatch(diffHtml, /open=""|Lazy diff evidence/u);
});

test("nested plan cards label planned changes without claiming them", () => {
  const planHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "plan", intentName: "Polish cards", paths: ["src/one.ts"], ref: null },
    durationMs: 10,
    outcome: "completed",
    receipt: null,
  }));
  assert.match(planHtml, />Planned</u);
  assert.doesNotMatch(planHtml, />Claimed</u);

  const removeHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "planRemove", intentName: null, paths: ["src/one.ts"], ref: null },
    durationMs: 10,
    outcome: "completed",
    receipt: null,
  }));
  assert.match(removeHtml, />Reduced</u);
  assert.match(removeHtml, /Removed from plan/u);
  assert.doesNotMatch(removeHtml, />Claimed</u);
});

test("completed plan cards render reload scopes separately from file paths", () => {
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: {
      action: "plan",
      intentName: "Reload safely",
      paths: ["src/one.ts"],
      ref: null,
      reloadScopes: ["orchestrator-logic", "mcp"],
    },
    durationMs: 10,
    outcome: "completed",
    receipt: null,
  }));
  assert.match(html, /data-thread-reload-scopes="true"/u);
  assert.match(html, /Runtime reload scopes/u);
  assert.match(html, /data-thread-reload-scope="orchestrator-logic"/u);
  assert.match(html, /data-thread-reload-scope="mcp"/u);
  assert.equal((html.match(/src\/one\.ts/gu) ?? []).length, 1);
});

test("nested adoption plan cards render parent scope as a folder and adopted children as files", () => {
  const parentPath = "webapp/components/workbench/thread-view";
  const adoptedPath = `${parentPath}/ThreadGitArcItem.tsx`;
  const html = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: {
      action: "plan",
      adoptPaths: [adoptedPath],
      intentName: "Nested adoption",
      paths: [parentPath],
      ref: null,
    },
    durationMs: 10,
    outcome: "completed",
    projectFilePaths: [adoptedPath, `${parentPath}/ThreadClaimedFileList.tsx`],
    projectId: "project",
    receipt: null,
  }));

  assert.equal(html.match(/data-project-folder-path="true"/gu)?.length, 1);
  assert.match(html, /thread-view\//u);
  assert.match(html, /ThreadGitArcItem\.tsx/u);
  assert.match(html, /data-project-file-relative-path="webapp\/components\/workbench\/thread-view\/ThreadGitArcItem\.tsx"/u);
});

test("arc move cards distinguish previewed mappings from applied mappings", () => {
  const ref = "c".repeat(40);
  const move = {
    confirm: false,
    kind: "regex" as const,
    pattern: String.raw`^src/(?!tests/)(.+\.test\.tsx?)$`,
    replacement: "src/tests/$1",
    roots: ["src"],
  };
  const mappings = [{
    destination: "src/tests/widgets/widget.test.tsx",
    source: "src/widgets/widget.test.tsx",
  }];
  const previewHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "mv", intentName: null, move, paths: ["src"], ref: null },
    durationMs: 320,
    outcome: "completed",
    receipt: {
      action: "mv",
      additionalClaims: ["src/widgets/widget.test.tsx", "src/tests/widgets/widget.test.tsx"],
      claimedPaths: ["src/existing.ts"],
      intentName: "Move tests",
      mappings,
      matchedPathCount: 3,
      mode: "preview",
      ref,
      remainingMatchCount: 2,
      version: 1,
    },
  }));

  assert.match(previewHtml, /Previewed 1 move/u);
  assert.match(previewHtml, /src\/widgets\/widget\.test\.tsx/u);
  assert.match(previewHtml, /tests\/widgets\/widget\.test\.tsx/u);
  assert.doesNotMatch(previewHtml, /Would move|Batch|matching paths|Would additionally claim/u);

  const appliedHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "mv", intentName: null, move: { ...move, confirm: true }, paths: ["src"], ref: null },
    durationMs: 410,
    outcome: "completed",
    receipt: {
      action: "mv",
      additionalClaims: ["src/widgets/widget.test.tsx", "src/tests/widgets/widget.test.tsx"],
      claimedPaths: ["src/existing.ts", "src/tests/widgets/widget.test.tsx", "src/widgets/widget.test.tsx"],
      intentName: "Move tests",
      mappings,
      matchedPathCount: 3,
      mode: "applied",
      ref,
      remainingMatchCount: 2,
      version: 1,
    },
  }));

  assert.match(appliedHtml, /Moved 1 path/u);
  assert.match(appliedHtml, /3 claimed files/u);
  assert.doesNotMatch(appliedHtml, />Moved<|Batch|matching paths|Additionally claimed/u);
});

test("failed regex and explicit arc move cards use distinct truthful labels", () => {
  const previewFailure = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: {
      action: "mv",
      intentName: null,
      move: { confirm: false, kind: "regex", pattern: "[", replacement: "tests/$1", roots: ["src"] },
      paths: ["src"],
      ref: null,
    },
    durationMs: 5,
    failureReason: "The regex is invalid.",
    outcome: "failed",
    receipt: null,
  }));
  assert.match(previewFailure, /Failed to preview moves/u);
  assert.doesNotMatch(previewFailure, /Failed to move/u);

  const appliedFailure = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: {
      action: "mv",
      intentName: null,
      move: { kind: "operands", operands: ["src/one.ts", "tests/one.ts"] },
      paths: ["src/one.ts", "tests/one.ts"],
      ref: null,
    },
    durationMs: 5,
    failureReason: "The destination already exists.",
    outcome: "failed",
    receipt: null,
  }));
  assert.match(appliedFailure, /Failed to move/u);
  assert.match(appliedFailure, /src\/one\.ts/u);
  assert.match(appliedFailure, /tests\/one\.ts/u);
  assert.doesNotMatch(appliedFailure, /Attempted to restore/u);
});

test("arc cards omit empty filler and describe failed claims precisely", () => {
  const ref = "a".repeat(40);
  const startHtml = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 5_000,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: `Workbench arc comparison\nWorkbench arc receipt: {"action":"start","claimedPaths":["src/one.ts"],"intentName":"Polish arc UI","ref":"${ref}","version":1}\n`,
        command: `wb git arc start --ref ${ref}`,
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 5_000,
        exitCode: 0,
        id: "start-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "completed",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));
  assert.doesNotMatch(startHtml, /No changed files captured|Claimed files will appear/u);
  assert.match(startHtml, /1 claimed file/u);

  const failedAddHtml = renderToStaticMarkup(createElement(ThreadGitArcItem, {
    commandIntent: { action: "add", intentName: null, paths: ["src/new.ts"], ref: null },
    durationMs: 5_000,
    failureReason: "The selected path is dirty.",
    outcome: "failed",
    receipt: null,
  }));
  assert.match(failedAddHtml, /Failed to claim/u);
  assert.match(failedAddHtml, /data-thread-git-arc-failure="operationRejected"/u);
  assert.match(failedAddHtml, /The selected path is dirty\./u);
});

test("pending checkpoint proposal cards render command intent without a loading replacement", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/one.ts", "src/two.ts"],
    projectRootPath: "C:/workspace",
    sourceItemId: "proposal-command",
    state: { status: "pending" },
    title: "Immediate proposal",
  }));

  assert.match(html, /Immediate proposal/u);
  assert.match(html, /2 changed files/u);
  assert.match(html, /<button[^>]*disabled=""/u);
  assert.match(html, />Commit<\/span>/u);
  assert.doesNotMatch(html, /Loading commit proposal/u);
});

test("failed task status commands keep the generic matched-command failure renderer", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 1_000,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput: "status update rejected",
        command: "wb thread status --status completed",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 10,
        exitCode: 1,
        id: "status-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "failed",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));

  assert.match(html, /status update rejected/u);
  assert.doesNotMatch(html, /data-role="thread-status-command"/u);
});

test("task status keeps proposal and final output outside closed Worked content", () => {
  const html = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 1_000,
      error: null,
      id: "turn-one",
      items: [
        {
          aggregatedOutput: null,
          command: "pnpm typecheck",
          commandActions: [],
          cwd: "C:/workspace",
          durationMs: 800,
          exitCode: 0,
          id: "work-command",
          pluginId: null,
          processId: null,
          scriptPath: null,
          source: "agent",
          status: "completed",
          type: "commandExecution",
        },
        {
          aggregatedOutput: null,
          command: "wb thread status --status completed",
          commandActions: [],
          cwd: "C:/workspace",
          durationMs: 10,
          exitCode: 0,
          id: "status-command",
          pluginId: null,
          processId: null,
          scriptPath: null,
          source: "agent",
          status: "completed",
          type: "commandExecution",
        },
        {
          aggregatedOutput: "Workbench arc proposal: proposal-one\n",
          command: "wb git arc propose -m \"Immediate proposal\" -- src/one.ts",
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
        },
        {
          id: "final-message",
          memoryCitation: null,
          phase: "final_answer",
          text: "All done.",
          type: "agentMessage",
        },
      ],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));

  assert.match(html, /data-role="thread-status-command"/u);
  assert.match(html, /Immediate proposal/u);
  assert.match(html, /All done\./u);
  assert.match(html, />Worked</u);
  assert.doesNotMatch(html, /<details[^>]*open=""[^>]*>[^]*Worked/u);
});

test("compacted, flattened, and hidden-final turns share the task-status terminal boundary", () => {
  const turn = {
    completedAt: null,
    durationMs: 1_000,
    error: null,
    id: "turn-one",
    items: [
      {
        aggregatedOutput: null,
        command: "Write-Output older-work",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 300,
        exitCode: 0,
        id: "older-work",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent" as const,
        status: "completed" as const,
        type: "commandExecution" as const,
      },
      { id: "compaction-one", type: "contextCompaction" as const },
      {
        aggregatedOutput: null,
        command: "Write-Output current-work",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 300,
        exitCode: 0,
        id: "current-work",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent" as const,
        status: "completed" as const,
        type: "commandExecution" as const,
      },
      { id: "compaction-two", type: "contextCompaction" as const },
      {
        aggregatedOutput: null,
        command: "wb thread status --status completed",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 10,
        exitCode: 0,
        id: "status-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent" as const,
        status: "completed" as const,
        type: "commandExecution" as const,
      },
      {
        aggregatedOutput: "Workbench arc proposal: proposal-one\n",
        command: "wb git arc propose -m \"Immediate proposal\" -- src/one.ts",
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 10,
        exitCode: 0,
        id: "proposal-command",
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent" as const,
        status: "completed" as const,
        type: "commandExecution" as const,
      },
      {
        id: "final-message",
        memoryCitation: null,
        phase: "final_answer" as const,
        text: "All done.",
        type: "agentMessage" as const,
      },
    ],
    itemsView: "full" as const,
    startedAt: null,
    status: "completed" as const,
  };
  const sharedProps = {
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn,
  };

  const compacted = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    ...sharedProps,
    hideFinalAgentMessage: true,
  }));
  assert.match(compacted, /data-role="thread-status-command"/u);
  assert.match(compacted, /Immediate proposal/u);
  assert.doesNotMatch(compacted, /older-work|current-work|All done\./u);

  const flattened = renderToStaticMarkup(createElement(ThreadTurnDetails, {
    ...sharedProps,
    flattenCompletedWork: true,
  }));
  const workIndex = flattened.indexOf("current-work");
  const statusIndex = flattened.indexOf('data-role="thread-status-command"');
  const proposalIndex = flattened.indexOf("Immediate proposal");
  const finalIndex = flattened.indexOf("All done.");
  assert(workIndex >= 0);
  assert(statusIndex > workIndex);
  assert(proposalIndex > statusIndex);
  assert(finalIndex > proposalIndex);
});

test("pending arc-wide proposal cards show an honest summary before enrichment", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: [],
    projectRootPath: "C:/workspace",
    sourceItemId: "proposal-command",
    state: { status: "pending" },
    title: "Immediate proposal",
  }));

  assert.match(html, /Immediate proposal/u);
  assert.match(html, /Arc changes/u);
  assert.match(html, /Arc changes/u);
  assert.doesNotMatch(html, /claimed changes will appear here/u);
  assert.doesNotMatch(html, /0 changed files|Loading commit proposal/u);
});

test("checkpoint proposal editables commit on Ctrl+Enter only while available", () => {
  let commits = 0;
  let prevented = 0;
  const renderCard = (status: "proposed" | "unavailable") => ThreadCheckpointCommitCard({
    committing: false,
    description: "Commit description",
    includeNewer: false,
    onCommit: () => { commits += 1; },
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/one.ts"],
    sourceItemId: "proposal-command",
    state: proposedCheckpointState(status),
    title: "Commit title",
  });
  const createShortcutEvent = (ctrlKey: boolean) => ({
    altKey: false,
    ctrlKey,
    key: "Enter",
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => { prevented += 1; },
    shiftKey: false,
  }) as unknown as KeyboardEvent<HTMLDivElement>;

  const proposedEditables = findEditableProps(renderCard("proposed"));
  assert.deepEqual(proposedEditables.map((props) => props.ariaLabel), ["Commit title", "Commit description"]);
  proposedEditables.forEach((props) => props.onKeyDown?.(createShortcutEvent(true)));
  assert.equal(commits, 2);
  assert.equal(prevented, 2);

  proposedEditables[0]?.onKeyDown?.(createShortcutEvent(false));
  findEditableProps(renderCard("unavailable"))[0]?.onKeyDown?.(createShortcutEvent(true));
  assert.equal(commits, 2);
  assert.equal(prevented, 2);
});

test("loaded checkpoint proposal cards keep actions in the summary and clean expanded diffs", () => {
  const html = renderToStaticMarkup(createElement(ThreadCheckpointCommitCard, {
    committing: false,
    description: "Keep selected-path behavior explicit.",
    includeNewer: false,
    onCommit: () => undefined,
    onDescriptionChange: () => undefined,
    onIncludeNewerChange: () => undefined,
    onRetry: () => undefined,
    onTitleChange: () => undefined,
    paths: ["src/edited.ts", "src/created.ts"],
    projectRootPath: "C:/workspace",
    sourceItemId: "proposal-command",
    state: {
      proposal: {
        amendTargetSha: null,
        baseCommit: "a".repeat(40),
        changes: [
          {
            additions: 2,
            deletions: 1,
            diff: "diff --git a/src/edited.ts b/src/edited.ts\n--- a/src/edited.ts\n+++ b/src/edited.ts\n@@ -1 +1,2 @@\n-old\n+new\n+newer\n",
            kind: { move_path: null, type: "update" },
            path: "src/edited.ts",
          },
          {
            additions: 1,
            deletions: 0,
            diff: "diff --git a/src/created.ts b/src/created.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/created.ts\n@@ -0,0 +1 @@\n+created\n",
            kind: { type: "add" },
            path: "src/created.ts",
          },
        ],
        committedSha: null,
        description: "Keep selected-path behavior explicit.",
        includeNewerAvailable: true,
        mode: "commit",
        paths: ["src/edited.ts", "src/created.ts"],
        proposalId: "proposal-one",
        status: "proposed",
        supersededByProposalId: null,
        supersededBySha: null,
        title: "Polish checkpoints",
        unavailableReason: null,
      },
      status: "loaded",
    },
    title: "Polish checkpoints",
  }));

  const titleIndex = html.indexOf("Polish checkpoints");
  const descriptionIndex = html.indexOf("Keep selected-path behavior explicit.");
  const changesIndex = html.indexOf("data-thread-checkpoint-card-changes");
  const actionsIndex = html.indexOf("data-thread-checkpoint-card-actions");
  assert(titleIndex >= 0);
  assert(descriptionIndex > titleIndex);
  assert(changesIndex > descriptionIndex);
  assert(actionsIndex > changesIndex);
  assert.match(html, /2 changed files/u);
  assert.match(html, />\+3</u);
  assert.match(html, />-1</u);
  assert.match(html, /Include newer changes/u);
  assert.match(html, /type="checkbox"/u);
  assert.match(html, />Commit</u);
});

test("preview diffs hide Git plumbing headers", () => {
  const html = renderToStaticMarkup(createElement(ThreadCodeDisplay, {
    diff: parseUnifiedDiff("diff --git a/src/edited.ts b/src/edited.ts\nindex 1111111..2222222 100644\n--- a/src/edited.ts\n+++ b/src/edited.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    preview: true,
    variant: "diff",
  }));

  assert.doesNotMatch(html, /diff --git/u);
  assert.doesNotMatch(html, /index 1111111\.\.2222222/u);
  assert.doesNotMatch(html, /--- a\/src/u);
  assert.doesNotMatch(html, /\+\+\+ b\/src/u);
});
