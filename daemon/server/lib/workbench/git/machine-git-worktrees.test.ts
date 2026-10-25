/*
 * No production exports. Tests cover machine worktree registration: Git env reaches only the exact machine root, never
 * a nested repository below it, and roots that are already repositories are refused.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { ensureMachineGitWorktree, machineGitEnvironment } from "./machine-git-worktrees";

const execFileAsync = promisify(execFile);

async function machine(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-machine-git-");
  context.after(async () => await temporary.dispose());
  const drive = path.join(temporary.path, "drive");
  const base = path.join(temporary.path, "data", "machine-git");
  await fs.mkdir(drive, { recursive: true });
  return { base, drive };
}

test("machine Git env reaches only the exact machine root", async context => {
  const { base, drive } = await machine(context);
  const nested = path.join(drive, "projects", "real");
  await fs.mkdir(nested, { recursive: true });
  await execFileAsync("git", ["init", "-q", nested], { windowsHide: true });

  const gitDir = await ensureMachineGitWorktree(drive, base);
  assert.equal(await ensureMachineGitWorktree(drive, base), gitDir);
  assert.equal(machineGitEnvironment(drive).GIT_DIR, gitDir);
  assert.deepEqual(machineGitEnvironment(path.join(drive, "projects")), {});
  assert.equal((await WorkbenchGitRepository.open(drive)).root, path.resolve(drive));
  assert.equal(path.resolve((await WorkbenchGitRepository.open(nested)).root), path.resolve(await fs.realpath(nested)));
  await assert.rejects(fs.stat(path.join(drive, ".git")), { code: "ENOENT" });
});

test("machine files round-trip byte-exact even when Git config asks for line ending conversion", async context => {
  const { base, drive } = await machine(context);
  const gitDir = await ensureMachineGitWorktree(drive, base);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "core.autocrlf", "true"], { windowsHide: true });
  const file = path.join(drive, "settings.ini");
  await fs.writeFile(file, "a = 1\nb = 2\n", "utf8");
  const repository = new WorkbenchGitRepository(drive);
  const head = await repository.headOrNull();
  const commit = await repository.createCommitFromTree(await repository.writeScopedWorktreeTree(["settings.ini"], head), head, "absorb\n");
  await fs.writeFile(file, "changed\n", "utf8");
  await repository.restorePaths(commit, ["settings.ini"]);
  assert.equal(await fs.readFile(file, "utf8"), "a = 1\nb = 2\n");
});

test("a root that is already a repository cannot back machine arcs", async context => {
  const { base, drive } = await machine(context);
  await execFileAsync("git", ["init", "-q", drive], { windowsHide: true });
  await assert.rejects(ensureMachineGitWorktree(drive, base), /already a Git repository/u);
  assert.deepEqual(machineGitEnvironment(drive), {});
});
