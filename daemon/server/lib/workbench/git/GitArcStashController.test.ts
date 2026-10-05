/*
 * Exports: none. Protect independent saved work across new live arcs and stash disposal.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import GitTestFixtureCache from "./GitTestFixtureCache";
import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";

const fixtures = new GitTestFixtureCache();

test("discarding an adopted stash preserves the caller's live claims and changes", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await controller.createAndStartPlan({ cwd, threadId: "child", intentName: "saved", paths: ["one.txt"] });
  await fs.writeFile(path.join(cwd, "one.txt"), "saved change\n");
  await controller.stashArc({ cwd, threadId: "child" });
  await controller.createAndStartPlan({ cwd, threadId: "owner", intentName: "live", paths: ["two.txt"] });
  await fs.writeFile(path.join(cwd, "two.txt"), "live change\n");
  await controller.adoptArc({ cwd, threadId: "owner", source: { harness: "codex", threadId: "child" } });
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "owner" })).stashedClaims, ["one.txt"]);
  await assert.rejects(controller.stashArc({ cwd, threadId: "owner" }), /stash/i);
  await controller.discardStashedArc({ cwd, threadId: "owner" });
  const status = await controller.readStatus({ cwd, threadId: "owner" });
  assert.deepEqual(status.stashedClaims, []);
  assert.deepEqual(status.dirtyClaims, ["two.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "live change\n");
});
