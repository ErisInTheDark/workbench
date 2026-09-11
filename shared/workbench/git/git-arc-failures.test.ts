/*
 * Exports: none. Protect failure facts and independent recovery obligations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createGitArcFailureFromError, createGitArcOperationRejected, describeGitArcFailure, formatGitArcFailureText, formatGitArcFailureReceipt, parseGitArcFailureEnvelope, parseGitArcFailureReceipt, type GitArcFailure } from "./git-arc-failures";
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
    headMovement: "same", planRef: ref, snapshotPaths: ["one.ts"], comparison: null, version: 1,
  };
  assert.deepEqual(parseGitArcFailureReceipt(formatGitArcFailureReceipt(failure)), failure);
  const recovery = describeGitArcFailure(failure).agentRecovery!;
  assert.match(recovery, /git_arc_wait/u);
  assert.doesNotMatch(recovery, /git_arc_diff|git_plan_claims|git_plan_start/u);
});

test("drift comparison survives receipts and large envelopes without leaking into human presentation", () => {
  const comparison = Array.from({ length: 30 }, (_, index) => ({
    additions: index + 1, deletions: index, binary: index === 0,
    kind: "update" as const,
    path: `src/${"long-path/".repeat(30)}file-${index}\tline\nbreak.ts`,
  }));
  const failure: GitArcFailure = {
    action: "arcStart", code: "planDrift", commits: [], conflicts: [], dirtyPaths: [],
    headMovement: "same", planRef: ref, snapshotPaths: ["one.ts"], version: 1,
    comparison,
  };
  const receipt = formatGitArcFailureReceipt(failure);
  assert.deepEqual(parseGitArcFailureReceipt(receipt), failure);
  const output = formatGitArcFailureText(failure);
  assert.ok(output.length > 8_000);
  assert.deepEqual(parseGitArcFailureEnvelope({ error: output, gitArcFailure: failure })?.gitArcFailure, failure);
  for (const text of [receipt, output]) assert.match(text, /total \+465 -435 \(900 changed lines\)/u);
  const presentation = describeGitArcFailure(failure);
  assert.ok(!`${presentation.message} ${presentation.userHint}`.includes("long-path"));
});

test("existing drift receipts remain readable without comparison facts", () => {
  const failure = {
    action: "arcStart", code: "planDrift", commits: [], conflicts: [], dirtyPaths: [],
    headMovement: "same", planRef: ref, snapshotPaths: ["one.ts"], version: 1,
  };
  const historical = `arc failure arcStart planDrift
conflicts 0
plan-ref ${ref}
head same
snapshot 1
one.ts
dirty 0
commits 0
end failure`;
  const expected = { ...failure, comparison: null };
  assert.deepEqual(parseGitArcFailureReceipt(historical), expected);
  assert.deepEqual(parseGitArcFailureReceipt(`Workbench arc failure: ${JSON.stringify(failure)}`), expected);
});

test("historical failures remain readable and truncated facts reject", () => {
  const failure: GitArcFailure = { action: "arcContinue", code: "acceptedProposals", claimedPaths: [], proposals: [{ proposalId: "accepted", commitSha: ref }], version: 1 };
  assert.deepEqual(parseGitArcFailureReceipt(`Workbench arc failure: ${JSON.stringify(failure)}`), failure);
  assert.equal(parseGitArcFailureReceipt(formatGitArcFailureReceipt(failure).split("\nend failure")[0]!), null);
});
