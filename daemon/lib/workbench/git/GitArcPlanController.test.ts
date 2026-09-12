/* No production exports. Tests protect activation snapshot ownership, late edits and drift rejection. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitArcPlanController from "./GitArcPlanController";
import GitArcRegistry from "./GitArcRegistry";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { THREAD_GIT_BASE_FIXTURE } from "./WorkbenchGitTestFixtures";
import { GitArcStartDiagnosticError } from "./git-arc-start-diagnostics";

const fixtureCache = new GitTestFixtureCache();

for (const adopted of [false, true]) {
  test(`activation reports its validated ${adopted ? "adopted" : "clean"} snapshot while preserving later edits`, async (context) => {
    const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
    context.after(fixture.dispose);
    const repository = await WorkbenchGitRepository.open(fixture.root);
    const controller = new GitArcPlanController();
    const input = { cwd: fixture.root, threadId: "activation-snapshot" };
    const selected = path.join(fixture.root, "selected.txt");
    if (adopted) await fs.writeFile(selected, "adopted content\n");
    const plan = await controller.createPlan({
      ...input, intentName: "Capture activation", paths: adopted ? [] : ["selected.txt"],
      adoptPaths: adopted ? ["selected.txt"] : [],
    });
    const index = await repository.writeIndexTree();
    context.mock.method(WorkbenchGitRepository, "open", async () => repository);
    const snapshots = context.mock.method(repository, "writeScopedWorktreeTree", repository.writeScopedWorktreeTree.bind(repository));
    const publish = repository.updateRefs.bind(repository);
    context.mock.method(repository, "updateRefs", async (...args: Parameters<typeof publish>) => {
      await publish(...args);
      await fs.writeFile(selected, "edit after publication\n");
    });
    const result = await controller.startArc({ ...input, checkpointCommit: plan.checkpointCommit });
    assert.ok("changes" in result);
    assert.equal(await fs.readFile(selected, "utf8"), "edit after publication\n");
    assert.equal(await repository.writeIndexTree(), index);
    assert.deepEqual(result.changes.map(({ path: filePath }) => filePath), adopted ? ["selected.txt"] : []);
    if (adopted) {
      assert.match(result.changes[0]!.diff, /\+adopted content/u);
      assert.doesNotMatch(result.changes[0]!.diff, /edit after publication/u);
    }
    assert.equal(snapshots.mock.callCount(), 1);
    assert.equal((await new GitArcRegistry(repository).find({ harness: "codex", threadId: input.threadId }))?.phase, "active");
  });
}

test("activation rejects drift without publishing or disturbing worktree and index", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const controller = new GitArcPlanController();
  const input = { cwd: fixture.root, threadId: "activation-drift" };
  const plan = await controller.createPlan({ ...input, intentName: "Reject drift", paths: ["selected.txt"] });
  const selected = path.join(fixture.root, "selected.txt");
  await fs.writeFile(selected, "drift before activation\n");
  const registry = new GitArcRegistry(repository);
  const before = await registry.read();
  const index = await repository.writeIndexTree();
  context.mock.method(WorkbenchGitRepository, "open", async () => repository);
  const publication = context.mock.method(repository, "updateRefs", repository.updateRefs.bind(repository));
  await assert.rejects(controller.startArc({ ...input, checkpointCommit: plan.checkpointCommit }), GitArcStartDiagnosticError);
  assert.equal(publication.mock.callCount(), 0);
  assert.deepEqual(await registry.read(), before);
  assert.equal(await repository.writeIndexTree(), index);
  assert.equal(await fs.readFile(selected, "utf8"), "drift before activation\n");
});
