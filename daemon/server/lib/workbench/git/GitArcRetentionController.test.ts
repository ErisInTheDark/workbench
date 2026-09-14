/*
 * No production exports. Protect guarded, thread-scoped Git arc retention cleanup.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { proposalMessage, proposalNamespace, type ProposalMetadata } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcRegistry from "./GitArcRegistry";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { CONTROLLER_PARTIAL_READY_FIXTURE } from "./WorkbenchGitTestFixtures";
import type { GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

const fixtureCache = new GitTestFixtureCache();

test("expired thread cleanup removes pending proposals from both resolved thread namespaces", async (context) => {
  const fixture = await fixtureCache.copy(CONTROLLER_PARTIAL_READY_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const nativeThreadId = "partial-thread";
  const canonicalThreadId = "wb-partial-thread";
  const resolve: GitArcThreadIdentityResolver = async ({ threadId }) => (
    threadId === nativeThreadId || threadId === canonicalThreadId
      ? { nativeThreadId, threadId: canonicalThreadId }
      : null
  );
  const controller = new WorkbenchGitCheckpointController(undefined, resolve);
  const registry = new GitArcRegistry(repository);
  const active = await registry.find({ harness: "codex", threadId: nativeThreadId });
  assert.ok(active);
  const proposalId = "pending-retention";
  const baseCommit = await repository.currentHead();
  const metadata: ProposalMetadata = {
    amendTargetSha: null,
    baseCommit,
    committedSha: null,
    description: "",
    liveBaseCommit: baseCommit,
    livePaths: ["one.txt"],
    mode: "commit",
    paths: ["one.txt"],
    proposalId,
    sourceCheckpoint: active.checkpointCommit,
    status: "proposed",
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Pending proposal",
    unavailableReason: null,
    version: 2,
  };
  const proposalCommit = await repository.createCommitFromTree(
    await repository.resolveTree(baseCommit),
    baseCommit,
    proposalMessage(metadata),
  );
  await repository.updateRef(`${proposalNamespace("codex", "partial-thread")}/${proposalId}`, proposalCommit);
  await registry.set({
    ...active,
    claimedPaths: [],
    phase: "resolved",
    proposalId,
    proposalIds: [...active.proposalIds, proposalId],
  }, active.checkpointCommit);

  const ownerRefsBefore = await repository.listRefs(`refs/worktree/agents/codex/${nativeThreadId}`);
  assert.ok(ownerRefsBefore.length > 0);
  const recovery = await new GitArcClaimLossStore(repository).read({ harness: "codex", threadId: nativeThreadId });
  assert.ok(recovery);
  assert.ok(ownerRefsBefore.includes(recovery.ref));
  const canonicalRef = `refs/worktree/agents/codex/${canonicalThreadId}/checkpoints/preserved`;
  await repository.updateRef(canonicalRef, active.checkpointCommit);
  const unrelatedRef = "refs/worktree/agents/codex/other-thread/checkpoints/preserved";
  await repository.updateRef(unrelatedRef, active.checkpointCommit);

  const result = await controller.pruneThreadHistory({
    cwd: fixture.root, harness: "codex", threadId: canonicalThreadId,
  });

  assert.equal(result.prunedRefCount, ownerRefsBefore.length + 1);
  assert.equal(result.registryEntryRemoved, true);
  assert.deepEqual(await repository.listRefs(`refs/worktree/agents/codex/${nativeThreadId}`), []);
  assert.deepEqual(await repository.listRefs(`refs/worktree/agents/codex/${canonicalThreadId}`), []);
  assert.equal(await repository.readRef(unrelatedRef), active.checkpointCommit);
  assert.equal(await registry.find({ harness: "codex", threadId: nativeThreadId }), null);
  assert.equal(await repository.readRef(recovery.ref), null);
});
