/*
 * No production exports. Real-Git regression wards cover one-process object reads and exact combined file-change inspection. Keywords: git, repository, object, diff, binary, literal path.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { THREAD_GIT_BASE_FIXTURE } from "./WorkbenchGitTestFixtures";

const fixtureCache = new GitTestFixtureCache();

test("reads ref objects and inspects text, binary, and literal-path changes with real Git", async (context) => {
  const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);

  const head = await repository.currentHead();
  const commit = await repository.readCommitAt("HEAD");
  assert.equal(commit?.commit, head);
  assert.equal(commit?.identity.message, "base\n");
  assert.equal(commit?.identity.parents.length, 0);
  assert.match(commit?.identity.tree ?? "", /^[a-f0-9]{40}$/u);

  const blob = await repository.writeBlob("registry contents\n");
  await repository.updateRef("refs/worktree/workbench/test-object", blob);
  assert.deepEqual(await repository.readBlobAtRef("refs/worktree/workbench/test-object"), {
    blob,
    contents: "registry contents\n",
  });
  assert.equal(await repository.readBlobAtRef("refs/worktree/workbench/missing-object"), null);
  assert.equal(await repository.readCommitAt("refs/worktree/workbench/missing-object"), null);
  await assert.rejects(repository.readBlobAtRef("HEAD"), /does not resolve to a blob/u);
  await assert.rejects(repository.readCommitAt("refs/worktree/workbench/test-object"), /is not a commit/u);

  await fs.writeFile(path.join(fixture.root, "selected.txt"), "selected changed\nsecond line\n", "utf8");
  await fs.rm(path.join(fixture.root, "ordinary.txt"));
  await fs.writeFile(path.join(fixture.root, "literal[1].txt"), "literal addition\n", "utf8");
  await fs.writeFile(path.join(fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const paths = ["binary.bin", "literal[1].txt", "ordinary.txt", "selected.txt"];
  const tree = await repository.writeScopedWorktreeTree(paths);
  const changes = await repository.buildFileChanges("HEAD", tree, paths);

  assert.deepEqual(changes.map(({ additions, deletions, kind, path: filePath }) => ({
    additions,
    deletions,
    kind: kind.type,
    path: filePath,
  })), [
    { additions: 0, deletions: 0, kind: "add", path: "binary.bin" },
    { additions: 1, deletions: 0, kind: "add", path: "literal[1].txt" },
    { additions: 0, deletions: 1, kind: "delete", path: "ordinary.txt" },
    { additions: 2, deletions: 1, kind: "update", path: "selected.txt" },
  ]);
  assert(changes.every(({ diff }) => diff.startsWith("diff --git ")));
  assert.match(changes.find(({ path: filePath }) => filePath === "binary.bin")?.diff ?? "", /GIT binary patch/u);
  assert.match(changes.find(({ path: filePath }) => filePath === "literal[1].txt")?.diff ?? "", /literal addition/u);
});
