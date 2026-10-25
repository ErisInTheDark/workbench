/*
 * Exports: none. Protect build views holding other owners at the caller's own baseline, and mirrors as checkout-byte
 * projections of synthetic Git trees.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { CONTROLLER_BASE_FIXTURE, STACK_OPERATIONS_FIXTURE } from "./GitArcControllerTestFixtures";

const fixtures = new GitTestFixtureCache();

test("views hold other owners at the caller's own or inherited sealed layers, never theirs", async context => {
  const fixture = await fixtures.copyFresh(STACK_OPERATIONS_FIXTURE);
  context.after(() => fixture.dispose());
  const controller = new WorkbenchGitCheckpointController();
  const viewOf = async (root: string, threadId: string) => {
    const cwd = path.join(fixture.bundleRoot, root);
    const repository = await WorkbenchGitRepository.open(cwd);
    const { tree } = await controller.readClaimView({ cwd, threadId, holdOwn: false });
    return async (file: string, treeish = tree) => await repository.run(["show", `${treeish}:${file}`]);
  };

  // The owner sealed "first" into one.txt; unrelated "other" never built on it.
  const { sealed, transfer } = fixture.state;
  const other = await viewOf(sealed.root, "other");
  assert.equal(await other("one.txt"), await other("one.txt", "HEAD"));
  assert.equal(await (await viewOf(sealed.root, "owner"))("one.txt"), "first\n");

  // The child sits on parent layer one; the parent sealed two.txt in layer two after the handoff.
  const child = await viewOf(transfer.root, "child");
  assert.equal(await child("one.txt"), "parent one\n");
  assert.equal(await child("two.txt"), await child("two.txt", "HEAD"));
  assert.equal(await child("three.txt"), "child start\n");
});

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
