/* No production exports. Shared-state batteries protect atomic final-loss publication and every loss route. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitArcRegistry from "./GitArcRegistry";
import GitTestFixtureCache, { type GitTestFixtureCopy } from "./GitTestFixtureCache";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import { CLAIM_LOSS_OPERATIONS_FIXTURE } from "./GitArcClaimLossTestFixtures";
import type { GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

const fixtures = new GitTestFixtureCache();
type ClaimLossFixture = GitTestFixtureCopy<Awaited<ReturnType<typeof CLAIM_LOSS_OPERATIONS_FIXTURE.prepare>>>;

async function checkAtomicLoss(prepared: ClaimLossFixture) {
  const fixture = { root: path.join(prepared.bundleRoot, prepared.state.atomicRoot) };
  const repository = new WorkbenchGitRepository(fixture.root);
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: fixture.root, harness: "codex" as const, threadId: prepared.state.threadId };
  const registry = new GitArcRegistry(repository);
  const store = new GitArcClaimLossStore(repository);
  const entry = await registry.find(identity);
  assert.ok(entry);
  const partial = await registry.prepareSet({ ...entry, claimedPaths: ["one.txt"] }, entry.checkpointCommit);
  await repository.updateRefs(partial.updates);
  assert.equal(await store.read(identity), null);
  await fs.writeFile(path.join(fixture.root, "one.txt"), "boundary\n");
  const loss = await registry.prepareSet({ ...entry, claimedPaths: [], phase: "resolved" }, entry.checkpointCommit);
  const competing = await registry.prepareSet({ ...entry, claimedPaths: ["one.txt"], intentName: "competing writer" }, entry.checkpointCommit);
  await repository.updateRefs(competing.updates);
  await assert.rejects(repository.updateRefs(loss.updates));
  assert.equal(await store.read(identity), null);
  assert.deepEqual((await registry.find(identity))?.claimedPaths, ["one.txt"]);
  await controller.releaseArc({ ...identity, disown: true });
  const boundary = await store.read(identity);
  assert.ok(boundary);
  assert.equal(boundary.frozen, false);
  assert.deepEqual(boundary.paths, ["one.txt"]);
  await fs.writeFile(path.join(fixture.root, "one.txt"), "later\n");
  assert.equal((await store.read(identity))?.commit, boundary.commit);
  assert.deepEqual((await controller.compare(identity)).changes.map(change => change.path), ["one.txt"]);
  const headRef = await repository.symbolicHead();
  assert.ok(headRef);
  const laterCommit = await repository.createCommitFromTree(await repository.writeScopedWorktreeTree(["one.txt"], boundary.head), boundary.head, "later change");
  await repository.updateRefs([{ ref: headRef, oldValue: boundary.head!, newValue: laterCommit }]);
  const revertedCommit = await repository.createCommitFromTree(boundary.tree, laterCommit, "return to loss boundary");
  await repository.updateRefs([{ ref: headRef, oldValue: laterCommit, newValue: revertedCommit }]);
  await fs.writeFile(path.join(fixture.root, "one.txt"), "boundary\n");
  const reverted = await controller.readStatus(identity);
  assert.deepEqual(reverted.recovery[0]?.comparison, []);
  assert.deepEqual(reverted.recovery[0]?.commits.map(commit => commit.commit), [laterCommit, revertedCommit]);
  await fs.writeFile(path.join(fixture.root, "one.txt"), "later\n");
  await controller.editArcClaims({ ...identity, inherit: true, adoptPaths: ["one.txt"] });
  assert.deepEqual((await controller.readStatus(identity)).recovery, []);
  await controller.releaseArc({ ...identity, disown: true });
  const replacement = await store.read(identity);
  assert.notEqual(replacement?.commit, boundary.commit);
  assert.equal(replacement?.frozen, false);
  const frozenUpdate = await store.prepare(identity, ["one.txt"], {
    head: replacement!.head,
    tree: replacement!.tree,
  }, { frozen: true });
  await repository.updateRefs([frozenUpdate]);
  assert.equal((await store.read(identity))?.frozen, true);
  const ref = replacement!.ref;
  await controller.pruneThreadHistory(identity);
  assert.equal(await repository.readRef(ref), null);
  assert.equal(await store.read(identity), null);
  const corrupt = await repository.createCommitFromTree(boundary.tree, boundary.head, "invalid metadata");
  await repository.updateRefs([{ ref, oldValue: "0".repeat(40), newValue: corrupt }]);
  await assert.rejects(store.read(identity));
  const wrongParent = await repository.createCommitFromTree(boundary.tree, boundary.head, JSON.stringify({ version: 1, paths: ["one.txt"], head: null }));
  await repository.updateRefs([{ ref, oldValue: corrupt, newValue: wrongParent }]);
  await assert.rejects(store.read(identity), /parent/u);
}

async function checkLossRoutes(prepared: ClaimLossFixture) {
  const controller = new WorkbenchGitCheckpointController();
  for (const route of ["planning", "removal", "restore", "settlement"] as const) {
    const fixture = { root: path.join(prepared.bundleRoot, prepared.state.routes[route]) };
    const repository = new WorkbenchGitRepository(fixture.root);
    const store = new GitArcClaimLossStore(repository);
    const identity = { cwd: fixture.root, harness: "codex" as const, threadId: prepared.state.threadId };
    if (route === "planning") await controller.createPlan({ ...identity, intentName: "new plan", paths: ["two.txt"] });
    else if (route === "removal") await controller.editArcClaims({ ...identity, inherit: true, removePaths: ["one.txt"] });
    else if (route === "settlement") {
      await controller.releaseActiveClaim(identity);
      const canonicalThreadId = `wb-${identity.threadId}`;
      const resolve: GitArcThreadIdentityResolver = async ({ threadId }) => (
        threadId === identity.threadId || threadId === canonicalThreadId
          ? { nativeThreadId: identity.threadId, threadId: canonicalThreadId }
          : null
      );
      const mappedController = new WorkbenchGitCheckpointController(undefined, resolve);
      const canonicalIdentity = { ...identity, threadId: canonicalThreadId };
      const status = await mappedController.readStatus(canonicalIdentity);
      assert.deepEqual(status.unavailableRecovery, []);
      assert.deepEqual(status.recovery[0]?.paths, ["one.txt"]);
      assert.deepEqual((await mappedController.compare(canonicalIdentity)).changes, []);
      const successor = await new GitArcClaimLossStore(repository, resolve).prepare(identity, ["one.txt"]);
      assert.match(successor.ref, new RegExp(`/codex/${canonicalThreadId}/claim-loss$`, "u"));
      await repository.updateRefs([successor]);
      assert.equal((await new GitArcClaimLossStore(repository, resolve).read(identity))?.ref, successor.ref);
    }
    else {
      await fs.writeFile(path.join(fixture.root, "one.txt"), "restore me\n");
      await assert.rejects(controller.releaseArc({ ...identity, disown: false }));
      assert.equal(await store.read(identity), null);
      await controller.restore({ ...identity, checkpointCommit: prepared.state.routeCheckpoint, confirmRestore: true });
    }
    assert.deepEqual((await store.read(identity))?.paths, ["one.txt"]);
    assert.deepEqual((await controller.compare(identity)).changes, []);
  }
}

test("claim-loss boundaries", { concurrency: 2 }, async context => {
  const prepared = await fixtures.copy(CLAIM_LOSS_OPERATIONS_FIXTURE);
  context.after(prepared.dispose);
  await Promise.all([
    context.test("final-loss ref and registry compare-and-swap publish together and preserve the disown snapshot", () => checkAtomicLoss(prepared)),
    context.test("planning, final removal and restore capture the boundary while a rejected release does not", () => checkLossRoutes(prepared)),
  ]);
});
