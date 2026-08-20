/* No production exports. Bounded concurrent regression wards cover mapping, stateless regex batches, direct moves, and rollback. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";

import GitArcPathMover, { MAX_GIT_ARC_MOVE_MAPPINGS } from "./GitArcPathMover.ts";
import GitArcRegistry from "./GitArcRegistry.ts";
import GitTestFixtureCache from "./GitTestFixtureCache.ts";
import WorkbenchGitRepository from "./WorkbenchGitRepository.ts";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController.ts";
import { PATH_MOVER_ARC_READY_FIXTURE, PATH_MOVER_BASE_FIXTURE } from "./WorkbenchGitTestFixtures.ts";

const fixtureCache = new GitTestFixtureCache();
const pathMoverCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];

function pathMoverTest(name: string, run: (context: TestContext) => Promise<void>) {
  pathMoverCases.push({ name, run });
}

async function createRepository(context: TestContext) {
  const fixture = await fixtureCache.copy(PATH_MOVER_BASE_FIXTURE);
  context.after(fixture.dispose);
  const root = fixture.root;
  const repository = new WorkbenchGitRepository(root);
  return { mover: new GitArcPathMover(repository, 1_000), repository, root };
}

async function createArcRepository(context: TestContext) {
  const fixture = await fixtureCache.copy(PATH_MOVER_ARC_READY_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  return { repository, root: fixture.root };
}

pathMoverTest("regex moves select 200 sorted mappings and report the honest remainder", async (context) => {
  const { mover, root } = await createRepository(context);
  await Promise.all(Array.from({ length: 246 }, async (_value, index) => {
    await fs.writeFile(path.join(root, "src", `${String(index).padStart(3, "0")}.test.ts`), `${index}\n`);
  }));
  const batch = await mover.resolve({
    confirm: false,
    kind: "regex",
    pattern: String.raw`^src/(?!tests/)(.+\.test\.tsx?)$`,
    replacement: "src/tests/$1",
    roots: ["src"],
  });
  assert.equal(batch.mappings.length, MAX_GIT_ARC_MOVE_MAPPINGS);
  assert.equal(batch.matchedPathCount, 247);
  assert.equal(batch.remainingMatchCount, 47);
  assert.deepEqual(batch.mappings[0], { destination: "src/tests/000.test.ts", source: "src/000.test.ts" });

  await fs.mkdir(path.join(root, "webapp", "components"), { recursive: true });
  await fs.mkdir(path.join(root, "webapp", "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "webapp", "components", "button.test.tsx"), "button\n");
  await fs.writeFile(path.join(root, "webapp", "tests", "existing.test.tsx"), "existing\n");
  const mirrored = await mover.resolve({
    confirm: false,
    kind: "regex",
    pattern: String.raw`^webapp/(?!tests/)(.+\.test\.tsx?)$`,
    replacement: "webapp/tests/$1",
    roots: ["webapp"],
  });
  assert.deepEqual(mirrored.mappings, [{
    destination: "webapp/tests/components/button.test.tsx",
    source: "webapp/components/button.test.tsx",
  }]);
});

pathMoverTest("path mover applies direct moves without changing the ordinary index", async (context) => {
  const { mover, root } = await createRepository(context);
  const beforeIndex = await fs.readFile(path.join(root, ".git", "index"));
  const batch = await mover.resolve({ kind: "operands", operands: ["src/one.test.ts", "tests/src/one.test.ts"] });
  await mover.apply(batch.mappings, async () => undefined);
  assert.equal(await fs.readFile(path.join(root, "tests", "src", "one.test.ts"), "utf8"), "one\n");
  assert.deepEqual(await fs.readFile(path.join(root, ".git", "index")), beforeIndex);
});

pathMoverTest("path mover rolls completed moves back when publication fails", async (context) => {
  const { mover, root } = await createRepository(context);
  await fs.writeFile(path.join(root, "src", "two.test.ts"), "two\n");
  const batch = await mover.resolve({
    kind: "maps",
    mappings: [
      { destination: "tests/one.test.ts", source: "src/one.test.ts" },
      { destination: "tests/two.test.ts", source: "src/two.test.ts" },
    ],
  });
  await assert.rejects(mover.apply(batch.mappings, async () => { throw new Error("publish failed"); }), /publish failed/u);
  assert.equal(await fs.readFile(path.join(root, "src", "one.test.ts"), "utf8"), "one\n");
  assert.equal(await fs.readFile(path.join(root, "src", "two.test.ts"), "utf8"), "two\n");
  await assert.rejects(fs.access(path.join(root, "tests")));
});

pathMoverTest("path mover rejects overlapping sources and occupied destinations", async (context) => {
  const { mover, root } = await createRepository(context);
  await fs.writeFile(path.join(root, "occupied.ts"), "occupied\n");
  await assert.rejects(mover.resolve({
    kind: "maps",
    mappings: [
      { destination: "moved-src", source: "src" },
      { destination: "moved-one.ts", source: "src/one.test.ts" },
    ],
  }), /sources overlap/u);
  await assert.rejects(mover.resolve({ kind: "operands", operands: ["src/one.test.ts", "occupied.ts"] }), /already exists/u);
});

pathMoverTest("arc move previews read-only, rejects sibling overlap, and applies minimal destination claims", async (context) => {
  const { repository, root } = await createArcRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  const activeBefore = await registry.find({ harness: "codex", threadId: "move-thread" });

  const preview = await controller.moveInArc({
    cwd: root,
    harness: "codex",
    move: {
      confirm: false,
      kind: "regex",
      pattern: String.raw`^src/(.+\.test\.tsx?)$`,
      replacement: "tests/src/$1",
      roots: ["src"],
    },
    threadId: "move-thread",
  });
  assert.equal(preview.mode, "preview");
  assert.deepEqual(preview.additionalClaims, ["tests/src/one.test.ts"]);
  assert.deepEqual(preview.scopePaths, ["src"]);
  assert.deepEqual(await registry.find({ harness: "codex", threadId: "move-thread" }), activeBefore);
  assert.equal(await fs.readFile(path.join(root, "src", "one.test.ts"), "utf8"), "one\n");

  await registry.claim({
    checkpointCommit: await repository.currentHead(),
    claimedPaths: ["claimed-destination"],
    harness: "opencode",
    intentDescription: "",
    intentName: "own destination",
    proposalId: null,
    threadId: "sibling-owner",
  });
  await assert.rejects(controller.moveInArc({
    cwd: root,
    harness: "codex",
    move: { kind: "operands", operands: ["src/one.test.ts", "claimed-destination/one.test.ts"] },
    threadId: "move-thread",
  }), /overlap active sibling work/u);
  assert.equal(await fs.readFile(path.join(root, "src", "one.test.ts"), "utf8"), "one\n");

  const moved = await controller.moveInArc({
    cwd: root,
    harness: "codex",
    move: { kind: "operands", operands: ["src/one.test.ts", "tests/src/one.test.ts"] },
    threadId: "move-thread",
  });
  assert.equal(moved.mode, "applied");
  assert.deepEqual(moved.additionalClaims, ["tests/src/one.test.ts"]);
  assert.deepEqual(moved.scopePaths, ["src", "tests/src/one.test.ts"]);
  assert.equal(await fs.readFile(path.join(root, "tests", "src", "one.test.ts"), "utf8"), "one\n");
  await assert.rejects(fs.access(path.join(root, "src", "one.test.ts")));
  assert.equal((await registry.find({ harness: "codex", threadId: "move-thread" }))?.checkpointCommit, moved.checkpointCommit);
});

test("Git arc path moves", { concurrency: 5 }, async (context) => {
  await Promise.all(pathMoverCases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
