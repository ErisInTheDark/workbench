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
import GitArcRegistry, { getGitArcLiveReloadScopes, type GitArcRegistryEntry } from "./GitArcRegistry";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import { remapArcOutcome } from "./git-arc-storage";

function registryFromState(entries: object[]) {
  let nextBlob = 0;
  return new GitArcRegistry({
    readBlobAtRef: async () => ({ blob: "a".repeat(40), contents: `${JSON.stringify({ entries, version: 1 })}\n` }),
    writeBlob: async () => `${String(++nextBlob).padStart(40, "b")}`,
  } as never);
}

test("plan and arc requests encode claimed-path defaults and successor refs", () => {
  const reloadPlan = GitCheckpointRequestSchema.safeParse({
    action: "plan",
    cwd: "C:/repo",
    intentName: "Update A",
    paths: ["src/a.ts"],
    reloadScopes: ["mcp", "reload-coordinator"],
    threadId: "thread-one",
  });
  assert.equal(reloadPlan.success, true);
  if (reloadPlan.success && reloadPlan.data.action === "plan") assert.deepEqual(reloadPlan.data.reloadScopes, ["mcp", "reload-coordinator"]);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "plan",
    cwd: "C:/repo",
    intentName: "Update A",
    paths: [],
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcAdd",
    cwd: "C:/repo",
    threadId: "thread-one",
  }).success, false);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcAdd",
    cwd: "C:/repo",
    paths: ["src/new.ts"],
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcAdd",
    cwd: "C:/repo",
    paths: [],
    threadId: "thread-one",
  }).success, false);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcAdopt",
    cwd: "C:/repo",
    paths: ["src/dirty.ts"],
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcRemove",
    cwd: "C:/repo",
    paths: ["src/a.ts"],
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcRemove",
    cwd: "C:/repo",
    paths: [],
    threadId: "thread-one",
  }).success, false);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcMove",
    cwd: "C:/repo",
    move: { kind: "operands", operands: ["src/a.ts", "src/b.ts"] },
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcMove",
    cwd: "C:/repo",
    move: { confirm: false, kind: "regex", pattern: "^src/(.+)$", replacement: "tests/$1", roots: ["src"] },
    threadId: "thread-one",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcMove",
    cwd: "C:/repo",
    move: { kind: "maps", mappings: Array.from({ length: 201 }, (_, index) => ({ destination: `to/${index}`, source: `from/${index}` })) },
    threadId: "thread-one",
  }).success, false);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "compare",
    cwd: "C:/repo",
    threadId: "thread-one",
  }).success, true);
  const explicitCompare = GitCheckpointRequestSchema.safeParse({
    action: "compare",
    checkpointCommit: "a".repeat(40),
    cwd: "C:/repo",
    threadId: "thread-one",
  });
  assert.equal(explicitCompare.success, true);
  if (!explicitCompare.success) assert.fail("Expected the explicit compare ref to pass validation.");
  if (explicitCompare.data.action !== "compare") assert.fail("Expected a compare request.");
  assert.equal(explicitCompare.data.checkpointCommit, "a".repeat(40));
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "proposalCreate",
    cwd: "C:/repo",
    description: "",
    threadId: "thread-one",
    title: "Update A",
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "proposalRescind",
    cwd: "C:/repo",
    proposalId: "proposal-one",
    threadId: "thread-one",
  }).success, true);
});

test("current-plan requests encode adoption, revision, atomic start, and ref-free activation", () => {
  const common = { cwd: "C:/repo", threadId: "thread-one" };
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "plan",
    adoptPaths: ["src/dirty-a.ts", "src/dirty-b.ts"],
    intentName: "Draft",
    paths: ["src/clean.ts"],
    ...common,
  }).success, true);
  for (const action of ["planAdd", "planRemove", "planAdopt"] as const) {
    assert.equal(GitCheckpointRequestSchema.safeParse({ action, paths: ["src/a.ts"], ...common }).success, true);
  }
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "planStart",
    adoptPaths: ["src/dirty.ts"],
    intentDescription: "Keep the existing approved route.",
    intentName: "Continue",
    paths: ["src/a.ts"],
    ...common,
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({ action: "arcStart", ...common }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "arcStart",
    checkpointCommit: "abcdef1",
    ...common,
  }).success, true);
});

test("proposal and plan diagnostics encode explicit lifecycle targets", () => {
  const common = { cwd: "C:/repo", threadId: "thread-one" };
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "diff",
    checkpointCommit: "abcdef1",
    paths: ["src/reported.ts"],
    ...common,
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "proposalCreate",
    amendProposalId: "proposal-ancestor",
    description: "",
    title: "Amend ancestor",
    ...common,
  }).success, true);
  assert.equal(GitCheckpointRequestSchema.safeParse({
    action: "proposalCreate",
    description: "",
    replaceProposalId: "proposal-pending",
    title: "Replace pending",
    ...common,
  }).success, true);
});

test("proposal contracts keep paths mandatory and terminal metadata explicit", () => {
  assert.equal(GitCheckpointProposalSchema.safeParse({
    amendTargetSha: null,
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
    mode: "commit",
    paths: ["src/a.ts"],
    proposalId: "proposal-one",
    status: "proposed",
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Update A",
    unavailableReason: null,
  }).success, true);
  assert.equal(GitCheckpointProposalSchema.safeParse({
    amendTargetSha: null,
    baseCommit: "abcdef1",
    changes: [{ additions: 0, deletions: 0, diff: "", kind: { move_path: null, type: "update" }, path: "src/a.ts" }],
    committedSha: null,
    description: "",
    includeNewerAvailable: false,
    mode: "commit",
    paths: ["src/a.ts"],
    proposalId: "proposal-one",
    status: "rescinded",
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Update A",
    unavailableReason: "Rescinded by the agent.",
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

test("accepted proposal receipt ledgers remap both target and resulting HEAD commits", () => {
  const remapped = remapArcOutcome({
    acceptedProposals: [{ commitSha: "aaaaaaa", headSha: "bbbbbbb", proposalId: "proposal-one" }],
    committedSha: "aaaaaaa", proposalId: "proposal-one", sourceCheckpoint: "ccccccc", status: "committed", successorCheckpoint: null, version: 1,
  } as never, new Map([["aaaaaaa", "ddddddd"], ["bbbbbbb", "eeeeeee"]]));
  assert.deepEqual((remapped as { acceptedProposals?: unknown }).acceptedProposals, [{ commitSha: "ddddddd", headSha: "eeeeeee", proposalId: "proposal-one" }]);
});

test("registry reads normalize legacy phase and scalar proposal identity without migration", async () => {
  const registry = registryFromState([{
    checkpointCommit: "a".repeat(40), claimedPaths: ["src/a.ts"], harness: "codex", intentDescription: "", intentName: "legacy",
    proposalId: "proposal-one", threadId: "legacy", updatedAt: "2026-08-20T00:00:00.000Z",
  }]);
  const legacy = await registry.find({ harness: "codex", threadId: "legacy" }) as { phase?: string; proposalIds?: string[] } | null;
  assert.deepEqual({ phase: legacy?.phase, proposalIds: legacy?.proposalIds }, { phase: "active", proposalIds: ["proposal-one"] });
});

test("registry updates preserve reload scope claims beside file claims", async () => {
  const original: GitArcRegistryEntry = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["src/a.ts"],
    harness: "codex",
    intentDescription: "",
    intentName: "reload-aware arc",
    phase: "active" as const,
    proposalId: null,
    proposalIds: [],
    reloadScopes: ["mcp", "orchestrator-logic"],
    retainedArc: null,
    threadId: "reload-aware",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const registry = registryFromState([original]);
  const { nextState } = await registry.prepareSet({
    ...original,
    proposalId: "proposal-one",
    proposalIds: ["proposal-one"],
  }, original.checkpointCommit);
  assert.deepEqual(nextState.entries[0]?.reloadScopes, ["mcp", "orchestrator-logic"]);
});

test("live reload scope claims follow active and retained arc ownership", () => {
  const common: GitArcRegistryEntry = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: [],
    harness: "codex",
    intentDescription: "",
    intentName: "reload-aware arc",
    phase: "active",
    proposalIds: [],
    reloadScopes: ["mcp"],
    retainedArc: null,
    threadId: "reload-aware",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  assert.deepEqual(getGitArcLiveReloadScopes(common), ["mcp"]);
  assert.deepEqual(getGitArcLiveReloadScopes({
    ...common,
    phase: "plan",
    reloadScopes: ["next-dev"],
    retainedArc: {
      checkpointCommit: "b".repeat(40),
      claimedPaths: ["src/a.ts"],
      intentDescription: "",
      intentName: "retained arc",
      phase: "active",
      proposalIds: [],
      reloadScopes: ["orchestrator-logic"],
    },
  }), ["orchestrator-logic"]);
  assert.deepEqual(getGitArcLiveReloadScopes({ ...common, phase: "plan", reloadScopes: ["next-dev"] }), []);
  assert.deepEqual(getGitArcLiveReloadScopes({ ...common, phase: "resolved" }), []);
});

test("registry collisions use only active and retained-plan claims", async () => {
  const common = { checkpointCommit: "a".repeat(40), harness: "codex", intentDescription: "", proposalIds: [], updatedAt: "2026-08-20T00:00:00.000Z" };
  const registry = registryFromState([
    { ...common, claimedPaths: ["src/active.ts"], intentName: "active", phase: "active", threadId: "active" },
    { ...common, claimedPaths: [], intentName: "fresh", phase: "plan", threadId: "fresh-plan" },
    { ...common, claimedPaths: ["src/retained.ts"], intentName: "retained", phase: "plan", threadId: "retained-plan" },
    { ...common, claimedPaths: ["src/resolved.ts"], intentName: "resolved", phase: "resolved", threadId: "resolved" },
  ]);
  const allowed = await registry.prepareClaim({
    checkpointCommit: "b".repeat(40), claimedPaths: ["src/resolved.ts"], harness: "codex", intentDescription: "", intentName: "new", proposalId: null, threadId: "new",
  });
  let retainedCollision = false;
  try {
    await registry.prepareClaim({
      checkpointCommit: "c".repeat(40), claimedPaths: ["src/retained.ts"], harness: "codex", intentDescription: "", intentName: "collision", proposalId: null, threadId: "collision",
    });
  } catch { retainedCollision = true; }
  assert.deepEqual({
    allowedClaims: allowed.nextState.entries.find((entry) => entry.threadId === "new")?.claimedPaths,
    retainedCollision,
  }, {
    allowedClaims: ["src/resolved.ts"], retainedCollision: true,
  });
});

test("checkpoint facade exposes the complete plan, proposal, and lifecycle owner surface", () => {
  const prototype = WorkbenchGitCheckpointController.prototype as unknown as Record<string, unknown>;
  const required = [
    "addToPlan", "adoptIntoPlan", "createAndStartPlan", "findPlanState", "listLifecycleStates", "listPlanStates", "removeFromPlan", "rescindProposal",
  ];
  assert.deepEqual(required.filter((method) => typeof prototype[method] !== "function"), []);
});

test("checkpoint, plan, and proposal responsibilities have dedicated owners", async () => {
  const modules = await Promise.allSettled([
    import("./GitCheckpointStore"),
    import("./GitArcPlanController"),
    import("./GitArcProposalController"),
  ]);
  assert.deepEqual(modules.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled"]);
});
