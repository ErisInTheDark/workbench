/*
 * Keywords: git, failures, recovery, transcript, escaping.
 * Exports: none. Protect failure facts and independent recovery obligations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createGitArcFailureFromError, createGitArcOperationRejected, describeGitArcFailure, formatGitArcFailureText, formatGitArcFailureReceipt, parseGitArcFailureReceipt, type GitArcFailure } from "./git-arc-failures";
import { GitArcRejectionError } from "./git-arc-rejections";

const ref = "a".repeat(40);
test("typed rejection receipts preserve escaped facts and keep diagnostics agent-only", () => {
  const failure = {
    ...createGitArcFailureFromError("arcClaims", new GitArcRejectionError({
      reason: "unclaimedRemoval", paths: ["line\nbreak.ts", "tab\tpath.ts"],
    }, "agent-only-detail --inherit")),
    workspace: { failedRootIds: ["web"], completedRootIds: ["api"], stage: "operation" as const },
  };
  assert.deepEqual(parseGitArcFailureReceipt(formatGitArcFailureReceipt(failure)), failure);
  assert.doesNotMatch(describeGitArcFailure(failure).message, /agent-only-detail|--inherit/u);
  assert.match(formatGitArcFailureText(failure), /agent-only-detail/u);
});
const conflict = {
  owner: { checkpointCommit: ref, harness: "codex", intentName: "fix\ncounts", lifecycle: "active", threadId: "thread", title: "a title" },
  overlaps: [{ claimedPath: "line\nbreak.ts", requestedPath: "line\nbreak.ts" }],
};

test("unclassified diagnostics remain agent evidence, not human presentation", () => {
  const diagnostic = 'MCP error -32602: [{"message":"agent-only-detail"}] Usage: wb git arc claims --inherit';
  const failure = createGitArcOperationRejected("arcClaims", diagnostic);
  const presentation = describeGitArcFailure(failure);
  assert.ok(presentation.message);
  assert.ok(!`${presentation.message} ${presentation.userHint ?? ""}`.includes("agent-only-detail"));
  assert.ok(formatGitArcFailureText(failure).includes(diagnostic));
  assert.deepEqual(parseGitArcFailureReceipt(formatGitArcFailureReceipt(failure)), failure);
});

test("plain failures preserve collision facts without a duplicate JSON envelope", () => {
  const failure: GitArcFailure = { action: "arcStart", code: "siblingClaimCollision", conflicts: [conflict], version: 1 };
  const output = formatGitArcFailureReceipt(failure);
  assert.ok(output.startsWith("arc failure "));
  assert.deepEqual(parseGitArcFailureReceipt(output), failure);
  assert.match(describeGitArcFailure(failure).agentRecovery!, /git_arc_wait/u);
  const activeRecovery = describeGitArcFailure({ ...failure, action: "arcClaims" }).agentRecovery!;
  assert.match(activeRecovery, /git_plan_claims/u);
});

test("mixed drift and collision receipts defer baseline recovery until claims clear", () => {
  const failure: GitArcFailure = {
    action: "arcStart", code: "planDrift", commits: [], conflicts: [conflict], dirtyPaths: [],
    headMovement: "same", planRef: ref, snapshotPaths: ["one.ts"], version: 1,
  };
  assert.deepEqual(parseGitArcFailureReceipt(formatGitArcFailureReceipt(failure)), failure);
  const recovery = describeGitArcFailure(failure).agentRecovery!;
  assert.match(recovery, /git_arc_wait/u);
  assert.doesNotMatch(recovery, /git_arc_diff|git_plan_claims|git_plan_start/u);
  const uncontestedRecovery = describeGitArcFailure({ ...failure, conflicts: [] }).agentRecovery!;
  assert.match(uncontestedRecovery, /git_plan_start/u);
  assert.doesNotMatch(uncontestedRecovery, /git_arc_start/u);
});

test("historical failures remain readable and truncated facts reject", () => {
  const failure: GitArcFailure = { action: "arcContinue", code: "acceptedProposals", claimedPaths: [], proposals: [{ proposalId: "accepted", commitSha: ref }], version: 1 };
  assert.deepEqual(parseGitArcFailureReceipt(`Workbench arc failure: ${JSON.stringify(failure)}`), failure);
  assert.equal(parseGitArcFailureReceipt(formatGitArcFailureReceipt(failure).split("\nend failure")[0]!), null);
});
