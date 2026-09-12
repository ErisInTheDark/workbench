/*
 * Exports: none. Protect exact final-loss publication, replacement and retention boundaries.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitArcRegistry from "./GitArcRegistry";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import { CONTROLLER_BASE_FIXTURE } from "./WorkbenchGitTestFixtures";

const fixtures = new GitTestFixtureCache();

test("final-loss ref and registry compare-and-swap publish together and preserve the disown snapshot", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: fixture.root, harness: "codex" as const, threadId: "atomic-loss" };
  await controller.createAndStartPlan({ ...identity, intentName: "atomic loss", paths: ["one.txt", "two.txt"] });
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
  assert.notEqual((await store.read(identity))?.commit, boundary.commit);
  const ref = (await store.read(identity))!.ref;
  await controller.pruneThreadHistory(identity);
  assert.equal(await repository.readRef(ref), null);
  assert.equal(await store.read(identity), null);
  const corrupt = await repository.createCommitFromTree(boundary.tree, boundary.head, "invalid metadata");
  await repository.updateRefs([{ ref, oldValue: "0".repeat(40), newValue: corrupt }]);
  await assert.rejects(store.read(identity));
  const wrongParent = await repository.createCommitFromTree(boundary.tree, boundary.head, JSON.stringify({ version: 1, paths: ["one.txt"], head: null }));
  await repository.updateRefs([{ ref, oldValue: corrupt, newValue: wrongParent }]);
  await assert.rejects(store.read(identity), /parent/u);
});

test("planning, final removal and restore capture the boundary while a rejected release does not", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(fixture.dispose);
  const controller = new WorkbenchGitCheckpointController();
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const store = new GitArcClaimLossStore(repository);
  for (const route of ["planning", "removal", "restore", "settlement"]) {
    const identity = { cwd: fixture.root, harness: "codex" as const, threadId: route };
    const started = await controller.createAndStartPlan({ ...identity, intentName: route, paths: ["one.txt"] });
    if (route === "planning") await controller.createPlan({ ...identity, intentName: "new plan", paths: ["two.txt"] });
    else if (route === "removal") await controller.editArcClaims({ ...identity, inherit: true, removePaths: ["one.txt"] });
    else if (route === "settlement") await controller.releaseActiveClaim(identity);
    else {
      await fs.writeFile(path.join(fixture.root, "one.txt"), "restore me\n");
      await assert.rejects(controller.releaseArc({ ...identity, disown: false }));
      assert.equal(await store.read(identity), null);
      await controller.restore({ ...identity, checkpointCommit: started.checkpointCommit, confirmRestore: true });
    }
    assert.deepEqual((await store.read(identity))?.paths, ["one.txt"]);
    assert.deepEqual((await controller.compare(identity)).changes, []);
  }
});
