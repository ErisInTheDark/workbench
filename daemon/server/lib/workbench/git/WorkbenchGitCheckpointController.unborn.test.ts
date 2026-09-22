/* Exports: none. Tests protect arc lifecycle and first acceptance before branch history exists. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";

import GitTestFixtureCache from "./GitTestFixtureCache";
import { UNBORN_FIXTURE } from "./WorkbenchGitTestFixtures";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import { GitCheckpointDirtyPathsError } from "./GitArcPlanController";
import { GitArcStartDiagnosticError } from "./git-arc-start-diagnostics";

const fixtureCache = new GitTestFixtureCache();
const cases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];

function unbornTest(name: string, run: (context: TestContext) => Promise<void>) {
  cases.push({ name, run });
}

async function copyRepository(context: TestContext) {
  const fixture = await fixtureCache.copy(UNBORN_FIXTURE);
  context.after(fixture.dispose);
  return { repository: await WorkbenchGitRepository.open(fixture.root), source: fixture.root };
}

unbornTest("unborn arcs adopt initial files and accept only selected content into the first commit", async (context) => {
  const { repository, source } = await copyRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: source, threadId: "initial" };
  await fs.writeFile(path.join(source, "one.txt"), "initial one\n");
  await fs.writeFile(path.join(source, "unrelated.txt"), "staged unrelated\n");
  await repository.run(["add", "one.txt", "unrelated.txt"]);
  await fs.writeFile(path.join(source, "one.txt"), "working one\n");
  const index = await repository.writeIndexTree();
  await assert.rejects(controller.createPlan({
    ...identity, intentName: "start project", paths: ["one.txt"],
  }), GitCheckpointDirtyPathsError);
  const plan = await controller.createPlan({
    ...identity, intentName: "start project", paths: ["two.txt"], adoptPaths: ["one.txt"],
  });
  const active = await controller.startArc({ ...identity, checkpointCommit: plan.checkpointCommit });
  assert.equal(await repository.readRef("HEAD"), null);
  assert.equal(await repository.writeIndexTree(), index);
  await fs.writeFile(path.join(source, "two.txt"), "second file\n");
  await controller.continueArc(identity);
  const compared = await controller.compare(identity);
  assert.deepEqual(compared.changes.map(({ path }) => path), ["one.txt", "two.txt"]);
  await assert.rejects(controller.createProposal({
    ...identity, amend: true, freshTitle: "first", title: "first", description: "",
  }), /commit|HEAD/u);
  const proposal = await controller.createProposal({
    ...identity, paths: ["one.txt"], title: "first", description: "",
  });
  const accepted = await controller.commitProposal({
    ...identity, proposalId: proposal.proposalId, includeNewer: false, title: "first", description: "",
  });
  assert.ok(accepted.committedSha);
  assert.deepEqual((await repository.readCommit(accepted.committedSha)).parents, []);
  assert.deepEqual(await repository.listTreePaths(accepted.committedSha), ["one.txt"]);
  assert.equal(await repository.run(["show", "HEAD:one.txt"]), "working one\n");
  assert.equal(await repository.run(["show", ":unrelated.txt"]), "staged unrelated\n");
  assert.equal(await fs.readFile(path.join(source, "two.txt"), "utf8"), "second file\n");
  const continued = await controller.continueArc(identity);
  assert.deepEqual(continued.scopePaths, ["two.txt"]);
  assert.notEqual(continued.checkpointCommit, active.checkpointCommit);
});

unbornTest("unborn arc drift, collisions, moves and restore preserve ownership", async (context) => {
  const { repository, source } = await copyRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: source, threadId: "initial" };
  const plan = await controller.createPlan({ ...identity, intentName: "start", paths: ["one.txt"] });
  await fs.writeFile(path.join(source, "one.txt"), "appeared later\n");
  await assert.rejects(controller.startArc({ ...identity, checkpointCommit: plan.checkpointCommit }), GitArcStartDiagnosticError);
  const revised = await controller.editPlanClaims({
    ...identity, inherit: true, adoptPaths: ["one.txt"],
  });
  await controller.startArc({ ...identity, checkpointCommit: revised.checkpointCommit });
  await assert.rejects(controller.createAndStartPlan({
    cwd: source, threadId: "sibling", intentName: "collision", paths: ["one.txt"],
  }), /claim|collision/u);
  await controller.editArcClaims({ ...identity, inherit: true, addPaths: ["unused.txt"] });
  await controller.editArcClaims({ ...identity, inherit: true, removePaths: ["unused.txt"] });
  const unchanged = await controller.releaseArc({ ...identity, disown: false });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.releasedClaims, []);
  assert.deepEqual(unchanged.scopePaths, ["one.txt"]);
  const moved = await controller.moveInArc({
    ...identity, move: { kind: "maps", mappings: [{ source: "one.txt", destination: "moved.txt" }] },
  });
  assert.equal(await fs.readFile(path.join(source, "moved.txt"), "utf8"), "appeared later\n");
  await controller.restore({ ...identity, checkpointCommit: moved.checkpointCommit, paths: ["moved.txt"] });
  await assert.rejects(fs.access(path.join(source, "moved.txt")));
  await controller.releaseArc({ ...identity, disown: false });
  assert.equal(await repository.readRef("HEAD"), null);
});

unbornTest("first commits rebase independent unborn proposals but invalidate intersecting ones", async (context) => {
  const { repository, source } = await copyRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const independent = { cwd: source, threadId: "independent" };
  const intersecting = { cwd: source, threadId: "intersecting" };
  for (const [identity, file] of [[independent, "one.txt"], [intersecting, "two.txt"]] as const) {
    await controller.createAndStartPlan({ ...identity, intentName: "start", paths: [file] });
    await fs.writeFile(path.join(source, file), `proposed ${file}\n`);
  }
  const one = await controller.createProposal({ ...independent, title: "one", description: "" });
  const two = await controller.createProposal({ ...intersecting, title: "two", description: "" });
  await fs.writeFile(path.join(source, "two.txt"), "external two\n");
  await repository.run(["add", "two.txt"]);
  await repository.run(["commit", "-m", "external first"]);
  const first = await repository.currentHead();
  const rejected = await controller.getProposal({ ...intersecting, proposalId: two.proposalId, includeNewer: false });
  assert.equal(rejected.status, "unavailable");
  const accepted = await controller.commitProposal({
    ...independent, proposalId: one.proposalId, title: "one", description: "", includeNewer: false,
  });
  assert.ok(accepted.committedSha);
  assert.deepEqual((await repository.readCommit(accepted.committedSha)).parents, [first]);
  assert.equal(await repository.run(["show", "HEAD:two.txt"]), "external two\n");
});

test("unborn git arcs", { concurrency: 3 }, async (context) => {
  await Promise.all(cases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
