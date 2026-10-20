/*
 * No production exports. Tests protect the Git arc card model: how each call presents (card, preview card or run step),
 * what it keeps in view while closed, which cards open by themselves, and what its body lists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatGitArcEditText, parseGitArcEditText } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { GitArcCommandAction, GitArcCommandIntent } from "../../../workbench/thread/thread-command-matchers";
import { buildGitArcCard } from "./thread-git-arc-card";

type CardInput = Parameters<typeof buildGitArcCard>[0];

function intent(action: GitArcCommandAction, values: Partial<GitArcCommandIntent> = {}): GitArcCommandIntent {
  return { action, intentName: "disclosure defaults", paths: [], ref: null, ...values };
}

function receipt(action: GitArcReceipt["action"], values: Partial<GitArcReceipt> = {}): GitArcReceipt {
  return { action, claimedPaths: [], intentName: "disclosure defaults", ref: "a".repeat(40), version: 1, ...values };
}

function card(action: GitArcCommandAction, values: Partial<CardInput> = {}) {
  return buildGitArcCard({
    asRunStep: false, currentPlan: null, editResult: null, failureReason: null, intent: intent(action), interruptedBySteer: false,
    name: null, outcome: "completed", receipt: null, statusFacts: undefined, statusOutput: undefined, typedFailure: null, ...values,
  });
}

test("arc reads and plans are steps inside a run; lifecycle changes stay cards there", () => {
  for (const action of ["claims", "compare", "continue", "diff", "plan"] as const) {
    assert.equal(card(action, { asRunStep: true }).style, "step", action);
  }
  for (const action of ["propose", "stack", "start", "release"] as const) {
    assert.notEqual(card(action, { asRunStep: true }).style, "step", action);
  }
});

test("only unknown actions and conflicts open by themselves", () => {
  assert.equal(card("unknown").defaultOpen, true);
  for (const action of ["compare", "plan", "release", "start", "status", "unstash"] as const) {
    assert.equal(card(action).defaultOpen, false, action);
  }
  const conflicted = card("unstash", { receipt: receipt("unstash", { claimedPaths: ["src/c.ts"], conflictedPaths: ["src/c.ts"], fullScope: true }) });
  assert.equal(conflicted.defaultOpen, true);
  assert.deepEqual(conflicted.conflictedPaths, ["src/c.ts"]);
});

test("status reads keep every relevant count on the line, whatever the agent asked to expand", () => {
  const status = card("status", { statusFacts: { cleanClaims: 8, dirtyClaims: ["src/dirty.ts"], unclaimedDirt: ["src/a.ts", "src/b.ts"] } });
  assert.equal(status.preview, null);
  assert.deepEqual(status.statusCounts?.map(({ count, label }) => [label, count]), [["dirty", 1], ["clean", 8], ["unclaimed dirt", 2]]);
});

test("a release counts what it actually let go and lists exactly those paths", () => {
  const released = card("release", { receipt: receipt("release", { removedClaims: ["src/one.ts", "src/two.ts", "src/three.ts"] }) });
  assert.equal(released.releasedCount, 3);
  assert.equal(released.subject, null);
  assert.deepEqual(released.pathGroups.flatMap(group => group.paths), ["src/one.ts", "src/two.ts", "src/three.ts"]);
  // A transfer names its subagent instead of counting.
  assert.equal(card("release", { intent: intent("release", { paths: ["src/a.ts"], toSubagent: "mira" }) }).releasedCount, null);
});

test("plain cards preview nothing while closed; preview cards keep their first file list in view", () => {
  assert.equal(card("plan", { receipt: receipt("plan", { fullScope: true, plannedPaths: ["src/one.ts"] }) }).preview, null);
  const restored = card("restore", { intent: intent("restore", { paths: ["src/one.ts", "src/two.ts", "src/three.ts"] }) });
  assert.equal(restored.preview?.kind, "claims");
  assert.deepEqual(restored.preview?.kind === "claims" ? restored.preview.paths : [], ["src/one.ts", "src/two.ts", "src/three.ts"]);
});

test("a claims update shows what changed rather than the whole inventory again", () => {
  const updated = card("claims", { receipt: receipt("claims", { additionalClaims: ["src/new.ts"], claimedPaths: ["src/old.ts", "src/new.ts"] }) });
  assert.deepEqual(updated.pathGroups.flatMap(group => group.paths), ["src/new.ts"]);
});

test("edit sessions preview their files from the CLI output", () => {
  const output = formatGitArcEditText({
    additionalClaims: [], additions: 3, blockedDirtyPaths: [], blockedPendingPaths: [], collisions: [], conflictedPaths: [],
    deletions: 1, diffs: [], fileCount: 1, files: [{ additions: 3, binary: false, deletions: 1, ignored: false, lines: [1], movedFrom: "src/old.ts", path: "src/new.ts" }],
    ignoredFileCount: 0, page: 1, pageCount: 1, phase: "applied", releasedClaims: [], session: "abc12345", skippedFileCount: 0, warnings: [],
  });
  const edit = card("edit", { editResult: parseGitArcEditText(output), intent: intent("edit", { editStep: "apply" }) });
  assert.equal(edit.subject, "edit session abc12345");
  assert.equal(edit.preview?.kind, "files");
});

test("failures and interruptions read in their own tense", () => {
  assert.equal(card("propose", { outcome: "failed", failureReason: "nope" }).state, "failed");
  assert.equal(card("propose", { outcome: "failed", interruptedBySteer: true }).state, "interrupted");
  assert.equal(card("propose", { outcome: "failed", interruptedBySteer: true }).failure, null);
});
