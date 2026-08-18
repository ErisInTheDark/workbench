/*
 * Exports:
 * - No production exports; tests cover checkpoint request and proposal contract boundaries. Keywords: git, checkpoint, Zod, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GitCheckpointProposalSchema,
  GitCheckpointRequestSchema,
} from "./checkpoint-contracts.ts";

test("plan and arc requests encode claimed-path defaults and successor refs", () => {
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "plan",
    cwd: "C:/repo",
    intentName: "Update A",
    paths: ["src/a.ts"],
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "plan",
    cwd: "C:/repo",
    intentName: "Update A",
    paths: [],
    threadId: "thread-one",
  }).success, false);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcAdd",
    checkpointCommit: "abcdef1",
    cwd: "C:/repo",
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcRemove",
    checkpointCommit: "abcdef1",
    cwd: "C:/repo",
    paths: ["src/a.ts"],
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcRemove",
    checkpointCommit: "abcdef1",
    cwd: "C:/repo",
    paths: [],
    threadId: "thread-one",
  }).success, false);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "compare",
    checkpointCommit: "abcdef1",
    cwd: "C:/repo",
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "proposalCreate",
    checkpointCommit: "abcdef1",
    cwd: "C:/repo",
    description: "",
    threadId: "thread-one",
    title: "Update A",
  }).success, true);
});

test("proposal contracts keep paths mandatory and terminal metadata explicit", () => {
  assert.equal(GitCheckpointProposalSchema.safeParse({
    baseCommit: "abcdef1",
    changes: [{
      additions: 2,
      deletions: 1,
      diff: "diff --git a/src/a.ts b/src/a.ts\n",
      kind: { move_path: null, type: "update" },
      path: "src/a.ts",
    }],
    committedSha: null,
    description: "",
    includeNewerAvailable: true,
    paths: ["src/a.ts"],
    proposalId: "proposal-one",
    status: "proposed",
    title: "Update A",
    unavailableReason: null,
  }).success, true);
  assert.equal(GitCheckpointProposalSchema.safeParse({
    baseCommit: "abcdef1",
    changes: [],
    committedSha: null,
    description: "",
    includeNewerAvailable: false,
    paths: [],
    proposalId: "proposal-one",
    status: "proposed",
    title: "Update A",
    unavailableReason: null,
  }).success, false);
});
