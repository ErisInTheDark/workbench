/*
 * Exports: none. Protect build-view mirrors as checkout-byte projections of synthetic Git trees.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";

const fixtures = new GitTestFixtureCache();

test("mirror applies Git checkout filters to canonical tree blobs", async context => {
  const fixture = await fixtures.copyFresh(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const repository = await WorkbenchGitRepository.open(cwd);
  await repository.run(["config", "core.autocrlf", "true"]);
  await fs.writeFile(path.join(cwd, "line-endings.txt"), Buffer.from("one\r\ntwo\r\n"));
  const tree = await repository.writeScopedWorktreeTree(["line-endings.txt"]);
  assert.deepEqual(
    await repository.runBufferWithInput(["cat-file", "blob", `${tree}:line-endings.txt`], ""),
    Buffer.from("one\ntwo\n"),
  );

  const exclude = path.resolve(cwd, (await repository.run(["rev-parse", "--git-path", "info/exclude"])).trim());
  await fs.appendFile(exclude, "\nbuild-out/\n");
  const output = path.join(cwd, "build-out");
  const controller = new WorkbenchGitCheckpointController();
  await controller.mirrorClaimView({
    into: output,
    paths: ["line-endings.txt"],
    repoRoot: cwd,
    tree,
  });

  assert.deepEqual(await fs.readFile(path.join(output, "line-endings.txt")), Buffer.from("one\r\ntwo\r\n"));
  assert.deepEqual(await controller.mirrorClaimView({
    into: output,
    paths: ["line-endings.txt"],
    repoRoot: cwd,
    tree,
  }), { deleted: 0, written: 0 });
  assert.deepEqual(await fs.readFile(path.join(output, "line-endings.txt")), Buffer.from("one\r\ntwo\r\n"));
});
