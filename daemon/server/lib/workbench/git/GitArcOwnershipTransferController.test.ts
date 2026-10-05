/*
 * Exports: none. Protect whole adoption and selected release across live and saved work.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitArcRegistry from "./GitArcRegistry";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";

const fixtures = new GitTestFixtureCache();
type AdoptionOwner = WorkbenchGitCheckpointController & {
  adoptArc(input: { cwd: string; threadId: string; source: { harness: "codex"; threadId: string } }): Promise<object>;
};

async function start(controller: WorkbenchGitCheckpointController, cwd: string, threadId: string, paths: string[]) {
  return await controller.createAndStartPlan({ cwd, threadId, paths, intentName: "change files" });
}

test("whole-source adoption keeps caller claims, pending proposals and source dirty work without changing files", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController() as AdoptionOwner;
  await start(controller, cwd, "parent", ["one.txt"]);
  await start(controller, cwd, "child", ["two.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "parent proposed\n");
  await fs.writeFile(path.join(cwd, "two.txt"), "child change\n");
  const proposal = await controller.createProposal({ cwd, description: "", threadId: "parent", title: "parent work" });
  assert.equal(typeof controller.adoptArc, "function", "the Git owner must support whole-source adoption");
  await controller.adoptArc({ cwd, threadId: "parent", source: { harness: "codex", threadId: "child" } });
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "parent" })).pending.map(({ proposalId }) => proposalId),
    [proposal.proposalId], "adoption leaves the caller's proposed snapshot committable");
  assert.deepEqual((await controller.readScope({ cwd, threadId: "parent" }))?.claimedPaths, ["one.txt", "two.txt"]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "child" }))?.claimedPaths ?? [], []);
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "child change\n");
  assert.ok((await controller.compare({ cwd, threadId: "parent" })).changes.some(change => change.path === "two.txt"));
});

test("adopted stash coexists with caller claims and restores without losing caller changes", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController() as AdoptionOwner;
  await start(controller, cwd, "parent", ["one.txt"]);
  await start(controller, cwd, "child", ["two.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "parent change\n");
  const parentLoss = new GitArcClaimLossStore(await WorkbenchGitRepository.open(cwd));
  const boundary = await parentLoss.prepare({ harness: "codex", threadId: "parent" }, ["one.txt"]);
  await (await WorkbenchGitRepository.open(cwd)).updateRefs([boundary]);
  await fs.writeFile(path.join(cwd, "two.txt"), "saved child change\n");
  await controller.stashArc({ cwd, threadId: "child" });
  const repository = await WorkbenchGitRepository.open(cwd);
  const registry = new GitArcRegistry(repository);
  const losses = new GitArcClaimLossStore(repository);
  const frozen = await losses.read({ harness: "codex", threadId: "child" });
  assert.equal((await registry.find({ harness: "codex", threadId: "child" }))?.phase, "stashed",
    "ordinary stash ownership must retain its existing registry phase");
  assert.ok(frozen?.frozen, "ordinary stash work must keep its frozen claim-loss snapshot");
  assert.equal(typeof controller.adoptArc, "function", "the Git owner must support stash adoption");
  await controller.adoptArc({ cwd, threadId: "parent", source: { harness: "codex", threadId: "child" } });
  assert.equal((await parentLoss.read({ harness: "codex", threadId: "parent" }))?.commit, boundary.newValue,
    "the caller's earlier recovery boundary stays intact during adoption");
  assert.equal(await repository.readRef("refs/worktree/agents/codex/parent/arc-stash"), frozen!.commit,
    "adoption must reuse the frozen Git object under the caller's separate stash address");
  assert.equal(await losses.read({ harness: "codex", threadId: "child" }), null,
    "the transferred source no longer owns its frozen snapshot");
  const status = await controller.readStatus({ cwd, threadId: "parent" });
  assert.deepEqual(status.dirtyClaims, ["one.txt"]);
  assert.deepEqual(status.stashedClaims, ["two.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "two\n");
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "child" })).stashedClaims, []);
  await controller.unstashArc({ cwd, threadId: "parent" });
  assert.equal((await parentLoss.read({ harness: "codex", threadId: "parent" }))?.commit, boundary.newValue,
    "restoring adopted work must not overwrite an earlier recovery boundary");
  // The restored checkpoint carries its own evidence, so the unrelated earlier boundary cannot break status.
  const restored = await controller.readStatus({ cwd, threadId: "parent" });
  assert.deepEqual(restored.dirtyClaims, ["one.txt", "two.txt"]);
  assert.deepEqual([restored.recovery, restored.unavailableRecovery], [[], []]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "parent" }))?.claimedPaths, ["one.txt", "two.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "parent change\n");
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "saved child change\n");
});

test("an existing caller stash rejects adoption without transferring source claims or saved work", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController() as AdoptionOwner;
  for (const [threadId, file] of [["parent", "one.txt"], ["child", "two.txt"]]) {
    await start(controller, cwd, threadId!, [file!]);
    await fs.writeFile(path.join(cwd, file!), `${threadId} saved\n`);
    await controller.stashArc({ cwd, threadId: threadId! });
  }
  assert.equal(typeof controller.adoptArc, "function", "the Git owner must reject unsafe stash adoption");
  await assert.rejects(controller.adoptArc({
    cwd, threadId: "parent", source: { harness: "codex", threadId: "child" },
  }), /stash/i);
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "parent" })).stashedClaims, ["one.txt"]);
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "child" })).stashedClaims, ["two.txt"]);
});

test("a caller's ordinary stash survives adoption of live child claims", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const repository = await WorkbenchGitRepository.open(cwd);
  const losses = new GitArcClaimLossStore(repository);
  const controller = new WorkbenchGitCheckpointController() as AdoptionOwner;
  await start(controller, cwd, "parent", ["one.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "parent saved\n");
  await controller.stashArc({ cwd, threadId: "parent" });
  const frozen = await losses.read({ harness: "codex", threadId: "parent" });
  assert.ok(frozen?.frozen);
  await start(controller, cwd, "child", ["two.txt"]);
  await fs.writeFile(path.join(cwd, "two.txt"), "child live\n");
  await controller.adoptArc({ cwd, threadId: "parent", source: { harness: "codex", threadId: "child" } });
  assert.equal(await repository.readRef("refs/worktree/agents/codex/parent/arc-stash"), frozen.commit);
  assert.equal(await losses.read({ harness: "codex", threadId: "parent" }), null);
  const saved = await controller.readStatus({ cwd, threadId: "parent" });
  assert.deepEqual(saved.dirtyClaims, ["two.txt"]);
  assert.deepEqual(saved.stashedClaims, ["one.txt"]);
  const proposal = await controller.createProposal({ cwd, description: "", threadId: "parent", title: "live work" });
  await controller.unstashArc({ cwd, threadId: "parent" });
  // Unstash only writes disjoint saved paths, so the live proposal's snapshot stays committable.
  assert.equal((await controller.getProposal({
    cwd, includeNewer: false, proposalId: proposal.proposalId, threadId: "parent",
  })).status, "proposed");
  assert.deepEqual((await controller.readScope({ cwd, threadId: "parent" }))?.claimedPaths, ["one.txt", "two.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "parent saved\n");
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "child live\n");
});

test("selected release returns dirty claims to a resolved child without exposing the parent's remainder", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await start(controller, cwd, "child", ["one.txt"]);
  await controller.releaseArc({ cwd, threadId: "child", disown: false });
  await start(controller, cwd, "parent", ["one.txt", "two.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "child receives this dirty work\n");
  await fs.writeFile(path.join(cwd, "two.txt"), "parent keeps this dirty work\n");
  const moved = await controller.createProposal({ cwd, description: "", paths: ["one.txt"], threadId: "parent", title: "moved" });
  const kept = await controller.createProposal({ cwd, description: "", paths: ["two.txt"], threadId: "parent", title: "kept" });
  const repository = await WorkbenchGitRepository.open(cwd);
  const index = await repository.writeIndexTree();
  const operation = await controller.prepareReleaseToChild({
    cwd, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["one.txt"],
  });
  const released = await operation.apply();
  assert.deepEqual(released.releasedClaims, ["one.txt"]);
  // Only the proposal covering moved files loses its owner, and it is reported rather than silently dropped.
  const reason = "Selected claims were released to a subagent.";
  assert.deepEqual(released.invalidatedProposals, [{ proposalId: moved.proposalId, reason }]);
  const parentStatus = await controller.readStatus({ cwd, threadId: "parent" });
  assert.deepEqual(parentStatus.pending.map(({ proposalId }) => proposalId), [kept.proposalId]);
  assert.deepEqual(parentStatus.unavailable, [{ proposalId: moved.proposalId, title: "moved", reason }]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "parent" }))?.claimedPaths, ["two.txt"]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "child" }))?.claimedPaths, ["one.txt"]);
  assert.deepEqual((await controller.compare({ cwd, threadId: "parent" })).changes.map(change => change.path), ["two.txt"]);
  assert.deepEqual((await controller.compare({ cwd, threadId: "child" })).changes.map(change => change.path), ["one.txt"]);
  assert.equal(await repository.writeIndexTree(), index);
  assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "child receives this dirty work\n");
});

test("selected release preserves the child's ordinary stash under its side address", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await start(controller, cwd, "child", ["one.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "child saved\n");
  await controller.stashArc({ cwd, threadId: "child" });
  const repository = await WorkbenchGitRepository.open(cwd);
  const losses = new GitArcClaimLossStore(repository);
  const frozen = await losses.read({ harness: "codex", threadId: "child" });
  await start(controller, cwd, "parent", ["two.txt"]);
  await fs.writeFile(path.join(cwd, "two.txt"), "parent gives this\n");
  await (await controller.prepareReleaseToChild({
    cwd, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["two.txt"],
  })).apply();
  assert.equal(await repository.readRef("refs/worktree/agents/codex/child/arc-stash"), frozen?.commit);
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "child" })).stashedClaims, ["one.txt"]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "child" }))?.claimedPaths, ["two.txt"]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "parent" }))?.claimedPaths ?? [], []);
});

test("returning adopted live claims leaves the parent's saved stash with the parent", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await start(controller, cwd, "parent", ["one.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "parent saved\n");
  await controller.stashArc({ cwd, threadId: "parent" });
  await start(controller, cwd, "child", ["two.txt"]);
  await controller.adoptArc({ cwd, threadId: "parent", source: { harness: "codex", threadId: "child" } });
  const repository = await WorkbenchGitRepository.open(cwd);
  const savedRef = "refs/worktree/agents/codex/parent/arc-stash";
  const savedCommit = await repository.readRef(savedRef);
  await fs.writeFile(path.join(cwd, "two.txt"), "returned dirty work\n");
  await (await controller.prepareReleaseToChild({
    cwd, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["two.txt"],
  })).apply();
  assert.equal(await repository.readRef(savedRef), savedCommit);
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "parent" })).stashedClaims, ["one.txt"]);
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "child" })).dirtyClaims, ["two.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "returned dirty work\n");
});

test("selected release keeps a parent's inactive plan while narrowing its retained claims", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await start(controller, cwd, "parent", ["one.txt", "two.txt"]);
  await fs.writeFile(path.join(cwd, "one.txt"), "one retained\n");
  await fs.writeFile(path.join(cwd, "two.txt"), "two retained\n");
  await controller.editPlanClaims({
    cwd, threadId: "parent", inherit: true,
    addPaths: [], removePaths: [], adoptPaths: [],
  });
  const result = await (await controller.prepareReleaseToChild({
    cwd, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["one.txt"],
  })).apply();
  assert.deepEqual(result.plannedPaths, ["one.txt", "two.txt"]);
  const parent = await controller.readScope({ cwd, threadId: "parent" });
  assert.equal(parent?.phase, "plan");
  assert.deepEqual(parent?.plannedPaths, ["one.txt", "two.txt"]);
  assert.deepEqual(parent?.claimedPaths, ["two.txt"]);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "child" }))?.claimedPaths, ["one.txt"]);
});

test("selected release rejects unowned paths and uncovered child plans before changing ownership", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await start(controller, cwd, "parent", ["two.txt"]);
  const input = {
    cwd, threadId: "child", source: { harness: "codex" as const, threadId: "parent" }, selectedPaths: ["one.txt"],
  };
  await assert.rejects(controller.prepareReleaseToChild(input), /selected path|owned/i);
  await controller.editPlanClaims({
    cwd, threadId: "child", inherit: false, intentName: "other work",
    addPaths: ["one.txt"], removePaths: [], adoptPaths: [],
  });
  await assert.rejects(controller.prepareReleaseToChild({ ...input, selectedPaths: ["two.txt"] }), /plan.*cover/i);
  assert.deepEqual((await controller.readScope({ cwd, threadId: "parent" }))?.claimedPaths, ["two.txt"]);
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "child" })).cleanClaims, []);
});
