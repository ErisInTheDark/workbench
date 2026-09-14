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
import { PATH_MOVER_ARC_READY_FIXTURE } from "./WorkbenchGitTestFixtures";

test("strict addition reads only ownership before rejecting overlap and preserves claim mutation safeguards", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(PATH_MOVER_ARC_READY_FIXTURE);
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
  assert.deepEqual(added.scopePaths, ["other", "src"]);
  assert.deepEqual((await registry.find(identity))?.claimedPaths, ["other", "src"]);
  const unchanged = await lifecycle.claims({ ...identity, inherit: true, addPaths: ["src"] });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.scopePaths, ["other", "src"]);

  const dirty = path.join(fixture.root, "dirty.txt");
  await fs.writeFile(dirty, "unclaimed work\n", "utf8");
  const beforeDirty = await registry.read();
  await assert.rejects(controller.addToArc({ ...identity, paths: ["dirty.txt"] }), GitCheckpointDirtyPathsError);
  assert.equal((await registry.read()).blob, beforeDirty.blob);
  assert.equal(await repository.writeIndexTree(), indexBefore);
  assert.equal(await fs.readFile(selected, "utf8"), selectedBefore);
  assert.equal(await fs.readFile(dirty, "utf8"), "unclaimed work\n");
});
