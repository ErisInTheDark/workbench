/* No production exports. Tests protect strict-add query cost, combined-claim semantics and rejected-mutation preservation. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitArcLifecycleController from "./GitArcLifecycleController";
import { GitCheckpointDirtyPathsError } from "./GitArcPlanController";
import GitArcRegistry from "./GitArcRegistry";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { SRC_ARC_READY_FIXTURE, SRC_BASE_FIXTURE } from "./WorkbenchGitTestFixtures";

test("a started folder claims only its current files, leaving new files and folder removal to the owner", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(SRC_BASE_FIXTURE);
  context.after(fixture.dispose);
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(await WorkbenchGitRepository.open(fixture.root));
  const owner = { cwd: fixture.root, harness: "codex" as const, threadId: "folder-owner" };
  const sibling = { cwd: fixture.root, harness: "codex" as const, threadId: "folder-sibling" };

  const started = await controller.createAndStartPlan({ ...owner, intentName: "own src", paths: ["src"] });
  assert.deepEqual(started.scopePaths, ["src/one.test.ts"]);
  assert.deepEqual((await registry.find(owner))?.claimedPaths, ["src/one.test.ts"]);

  await controller.createAndStartPlan({ ...sibling, intentName: "add beside", paths: ["src/new.ts"] });
  assert.deepEqual((await registry.find(sibling))?.claimedPaths, ["src/new.ts"]);
  await assert.rejects(
    controller.editArcClaims({ ...sibling, inherit: true, addPaths: ["src/one.test.ts"] }),
    /overlap active sibling work/u,
    "files the folder held at activation stay exclusive",
  );

  const removed = await controller.editArcClaims({ ...owner, inherit: true, removePaths: ["src"] });
  assert.deepEqual(removed.scopePaths, []);
});

test("continuing an arc stored with a folder claim converts it to file claims", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(SRC_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const head = await repository.currentHead();
  const legacyCommit = await repository.createCommitFromTree(await repository.resolveTree(head), head, [
    "workbench-git-checkpoint-v1",
    JSON.stringify({ amendedFrom: null, intentName: "legacy folder", kind: "arc", scopePaths: ["src"], version: 2 }),
    "",
  ].join("\n"));
  await repository.updateRef(`refs/worktree/agents/legacy-thread/checkpoints/legacy-${legacyCommit.slice(0, 7)}`, legacyCommit);
  const identity = { cwd: fixture.root, harness: "opencode" as const, threadId: "legacy-thread" };
  const controller = new WorkbenchGitCheckpointController();
  await controller.startArc({ ...identity, checkpointCommit: legacyCommit });
  const registry = new GitArcRegistry(repository);
  assert.deepEqual((await registry.find(identity))?.claimedPaths, ["src"], "precondition: a stored folder claim");

  const continued = await controller.continueArc(identity);
  assert.deepEqual(continued.scopePaths, ["src/one.test.ts"]);
  assert.deepEqual((await registry.find(identity))?.claimedPaths, ["src/one.test.ts"]);
  assert.deepEqual((await controller.continueArc(identity)).scopePaths, ["src/one.test.ts"], "the converted arc stays consistent");
});

test("strict addition reads only ownership before rejecting overlap and preserves claim mutation safeguards", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(SRC_ARC_READY_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const controller = new WorkbenchGitCheckpointController();
  const lifecycle = new GitArcLifecycleController();
  const registry = new GitArcRegistry(repository);
  const identity = { cwd: fixture.root, harness: "codex" as const, threadId: "move-thread" };
  const before = await registry.read();
  const indexBefore = await repository.writeIndexTree();
  const selected = path.join(fixture.root, "src/one.test.ts");
  const selectedBefore = await fs.readFile(selected, "utf8");

  // Root resolution is outside this ownership-query budget; the Git reads remain real.
  context.mock.method(WorkbenchGitRepository, "open", async () => repository);
  let gitCalls = 0;
  const run = repository.run.bind(repository);
  const runWithInput = repository.runWithInput.bind(repository);
  const runBufferWithInput = repository.runBufferWithInput.bind(repository);
  context.mock.method(repository, "run", (...args: Parameters<typeof run>) => {
    gitCalls++;
    return run(...args);
  });
  context.mock.method(repository, "runWithInput", (...args: Parameters<typeof runWithInput>) => {
    gitCalls++;
    return runWithInput(...args);
  });
  context.mock.method(repository, "runBufferWithInput", (...args: Parameters<typeof runBufferWithInput>) => {
    gitCalls++;
    return runBufferWithInput(...args);
  });

  await assert.rejects(controller.addToArc({ ...identity, paths: ["src/one.test.ts"] }), /already covered/u);
  assert.ok(gitCalls <= 1, `rejecting an owned path needed ${gitCalls} Git queries after root resolution`);
  assert.equal((await registry.read()).blob, before.blob);

  const added = await controller.addToArc({ ...identity, paths: ["other"] });
  assert.deepEqual(added.scopePaths, ["other", "src/one.test.ts"]);
  assert.deepEqual((await registry.find(identity))?.claimedPaths, ["other", "src/one.test.ts"]);
  const unchanged = await lifecycle.claims({ ...identity, inherit: true, addPaths: ["src"] });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.scopePaths, ["other", "src/one.test.ts"]);

  const dirty = path.join(fixture.root, "dirty.txt");
  await fs.writeFile(dirty, "unclaimed work\n", "utf8");
  const beforeDirty = await registry.read();
  await assert.rejects(controller.addToArc({ ...identity, paths: ["dirty.txt"] }), GitCheckpointDirtyPathsError);
  assert.equal((await registry.read()).blob, beforeDirty.blob);
  assert.equal(await repository.writeIndexTree(), indexBefore);
  assert.equal(await fs.readFile(selected, "utf8"), selectedBefore);
  assert.equal(await fs.readFile(dirty, "utf8"), "unclaimed work\n");
});
