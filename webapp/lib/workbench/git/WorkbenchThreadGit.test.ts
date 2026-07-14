/*
 * Exports:
 * - No production exports; Node tests cover thread-owned path selection, current-content commits, hook execution, isolation, unstage behavior, and failure recovery. Keywords: git, thread, selection, commit, hooks, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import WorkbenchThreadGit from "./WorkbenchThreadGit.ts";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
}

async function write(repoRoot: string, relativePath: string, contents: string) {
  const filePath = path.join(repoRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createRepository() {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-test-"));
  temporaryPaths.push(testRoot);
  const repoRoot = path.join(testRoot, "repo");
  const storageRootPath = path.join(testRoot, "storage");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.name", "Workbench Test"]);
  await git(repoRoot, ["config", "user.email", "workbench@example.invalid"]);
  await write(repoRoot, "selected.txt", "selected base\n");
  await write(repoRoot, "ordinary.txt", "ordinary base\n");
  await write(repoRoot, "nested/one.txt", "one base\n");
  await write(repoRoot, "nested/two.txt", "two base\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "base"]);
  return { repoRoot, storageRootPath };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) => fs.rm(temporaryPath, { force: true, recursive: true })));
});

test("commits selected paths at commit time while preserving unrelated staged work", async () => {
  const { repoRoot, storageRootPath } = await createRepository();
  await write(repoRoot, "selected.txt", "selected when marked\n");
  await write(repoRoot, "ordinary.txt", "ordinary staged\n");
  await git(repoRoot, ["add", "--", "ordinary.txt"]);

  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });
  assert.deepEqual(await owner.add(["selected.txt"]), {
    changedPaths: ["selected.txt"],
    selectedPaths: ["selected.txt"],
  });
  await write(repoRoot, "selected.txt", "selected at commit\n");
  const result = await owner.commit("thread-owned commit");

  assert.deepEqual(result.committedPaths, ["selected.txt"]);
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "selected at commit\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:ordinary.txt"]), "ordinary base\n");
  assert.equal((await git(repoRoot, ["diff", "--cached", "--name-only"])).trim(), "ordinary.txt");
  assert.equal((await git(repoRoot, ["status", "--short", "--", "selected.txt"])).trim(), "");
  await assert.rejects(owner.commit("nothing selected"), /no selected files/u);
});

test("uses the repository's configured commit hooks", async () => {
  const { repoRoot, storageRootPath } = await createRepository();
  const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
  await git(repoRoot, ["config", "core.hooksPath", ".git/hooks"]);
  await write(repoRoot, ".git/hooks/pre-commit", "#!/bin/sh\nprintf 'hook ran\\n' > hook-ran.txt\n");
  await fs.chmod(hookPath, 0o755);
  await write(repoRoot, "selected.txt", "selected with hook\n");
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });
  await owner.add(["selected.txt"]);

  await owner.commit("commit with hook");

  assert.equal(await fs.readFile(path.join(repoRoot, "hook-ran.txt"), "utf8"), "hook ran\n");
});

test("isolates thread selections and stacks disjoint commits from the current HEAD", async () => {
  const { repoRoot, storageRootPath } = await createRepository();
  await write(repoRoot, "selected.txt", "thread one\n");
  await write(repoRoot, "ordinary.txt", "thread two\n");
  const first = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });
  const second = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-two" });
  await first.add(["selected.txt"]);
  await second.add(["ordinary.txt"]);

  const firstResult = await first.commit("first thread");
  const secondResult = await second.commit("second thread");

  assert.notEqual(firstResult.commit, secondResult.commit);
  assert.equal((await git(repoRoot, ["rev-parse", `${secondResult.commit}^`])).trim(), firstResult.commit);
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "thread one\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:ordinary.txt"]), "thread two\n");
});

test("expands directories to changed files and unstages selected descendants", async () => {
  const { repoRoot, storageRootPath } = await createRepository();
  await fs.rm(path.join(repoRoot, "nested", "one.txt"));
  await write(repoRoot, "nested/two.txt", "two changed\n");
  await write(repoRoot, "nested/three.txt", "three untracked\n");
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });

  assert.deepEqual((await owner.add(["nested"])).selectedPaths, [
    "nested/one.txt",
    "nested/three.txt",
    "nested/two.txt",
  ]);
  assert.deepEqual(await owner.unstage(["nested/two.txt"]), {
    changedPaths: ["nested/two.txt"],
    selectedPaths: ["nested/one.txt", "nested/three.txt"],
  });
  const result = await owner.commit("selected nested files");

  assert.deepEqual(result.committedPaths, ["nested/one.txt", "nested/three.txt"]);
  await assert.rejects(git(repoRoot, ["show", "HEAD:nested/one.txt"]));
  assert.equal(await git(repoRoot, ["show", "HEAD:nested/three.txt"]), "three untracked\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:nested/two.txt"]), "two base\n");
  assert.equal((await git(repoRoot, ["status", "--short"])).trim(), "M nested/two.txt");
});

test("restores a claimed selection when the selected files are no longer committable", async () => {
  const { repoRoot, storageRootPath } = await createRepository();
  await write(repoRoot, "selected.txt", "temporary change\n");
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });
  await owner.add(["selected.txt"]);
  await write(repoRoot, "selected.txt", "selected base\n");
  await assert.rejects(owner.commit("fails without a diff"));

  await write(repoRoot, "selected.txt", "change after failure\n");
  const result = await owner.commit("selection survived");
  assert.deepEqual(result.committedPaths, ["selected.txt"]);
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "change after failure\n");
});

test("rejects selections outside the repository", async () => {
  const { repoRoot, storageRootPath } = await createRepository();
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });
  await assert.rejects(owner.add(["../outside.txt"]), /must stay inside the repository/u);
});
