/*
 * No production exports. Tests cover machine worktree registration: Git env reaches only the exact machine root, never
 * a nested repository below it, and roots that are already repositories are refused; and object pruning, which spares
 * reachable and recent objects.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { ensureMachineGitWorktree, machineGitEnvironment, pruneMachineGitObjects } from "./machine-git-worktrees";

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

test("machine prune drops only unreachable objects and temporary packs past the grace", async context => {
  const { base, drive } = await machine(context);
  const gitDir = await ensureMachineGitWorktree(drive, base);
  const git = async (args: string[], input?: string) => {
    const child = execFileAsync("git", ["--git-dir", gitDir, ...args], { windowsHide: true });
    if (input !== undefined) child.child.stdin!.end(input);
    return (await child).stdout.trim();
  };
  const loose = (id: string) => path.join(gitDir, "objects", id.slice(0, 2), id.slice(2));
  const past = new Date(Date.now() - 2 * 60 * 60_000);

  await fs.writeFile(path.join(drive, "kept.txt"), "kept\n", "utf8");
  const repository = new WorkbenchGitRepository(drive);
  const head = await repository.headOrNull();
  const tree = await repository.writeScopedWorktreeTree(["kept.txt"], head);
  const commit = await repository.createCommitFromTree(tree, head, "absorb\n");
  await repository.updateRefs([{ ref: await repository.symbolicHead() ?? "HEAD", newValue: commit, oldValue: head }]);
  const reachable = [commit, tree, await git(["rev-parse", `${commit}:kept.txt`])];

  const stale = await git(["hash-object", "-w", "--stdin"], "stale snapshot\n");
  const fresh = await git(["hash-object", "-w", "--stdin"], "fresh snapshot\n");
  const temporaryPack = path.join(gitDir, "objects", "pack", "tmp_pack_abandoned");
  await fs.mkdir(path.dirname(temporaryPack), { recursive: true });
  await fs.writeFile(temporaryPack, "partial pack");
  for (const file of [...reachable.map(loose), loose(stale), temporaryPack]) await fs.utimes(file, past, past);

  await pruneMachineGitObjects(drive);

  await assert.rejects(fs.stat(loose(stale)), { code: "ENOENT" });
  await assert.rejects(fs.stat(temporaryPack), { code: "ENOENT" });
  await fs.stat(loose(fresh));
  for (const id of reachable) await fs.stat(loose(id));
});

test("a root that is already a repository cannot back machine arcs", async context => {
  const { base, drive } = await machine(context);
  await execFileAsync("git", ["init", "-q", drive], { windowsHide: true });
  await assert.rejects(ensureMachineGitWorktree(drive, base), /already a Git repository/u);
  assert.deepEqual(machineGitEnvironment(drive), {});
});
