/*
 * Exports:
 * - No production exports; Node tests cover bounded checkpoint path restore, index preservation, literal paths, containment, and stale checkpoints. Keywords: git, checkpoint, restore, paths, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import {
  createGitCheckpoint,
  restoreGitCheckpointPaths,
} from "./git-checkpoints.ts";

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
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-checkpoint-test-"));
  temporaryPaths.push(testRoot);
  const repoRoot = path.join(testRoot, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.name", "Workbench Test"]);
  await git(repoRoot, ["config", "user.email", "workbench@example.invalid"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await write(repoRoot, "selected.txt", "selected checkpoint\n");
  await write(repoRoot, "deleted.txt", "deleted checkpoint\n");
  await write(repoRoot, "unrelated.txt", "unrelated checkpoint\n");
  await write(repoRoot, "literal[1].txt", "literal checkpoint\n");
  await write(repoRoot, "literal1.txt", "neighbor checkpoint\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "base"]);
  return { repoRoot, testRoot };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) => fs.rm(temporaryPath, { force: true, recursive: true })));
});

test("restores only selected checkpoint paths while preserving the ordinary index and unrelated worktree changes", async () => {
  const { repoRoot } = await createRepository();
  const checkpoint = await createGitCheckpoint({ cwd: repoRoot, purpose: "baseline", threadId: "thread-one" });
  await write(repoRoot, "selected.txt", "selected lint change\n");
  await fs.rm(path.join(repoRoot, "deleted.txt"));
  await write(repoRoot, "created.txt", "created by lint\n");
  await write(repoRoot, "unrelated.txt", "unrelated staged\n");
  await git(repoRoot, ["add", "--", "unrelated.txt"]);
  await write(repoRoot, "unrelated.txt", "unrelated worktree\n");

  const result = await restoreGitCheckpointPaths({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    filePaths: ["selected.txt", "deleted.txt", "created.txt"],
    threadId: "thread-one",
  });

  assert.deepEqual(result.restoredPaths, ["created.txt", "deleted.txt", "selected.txt"]);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "selected checkpoint\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "deleted.txt"), "utf8"), "deleted checkpoint\n");
  await assert.rejects(fs.stat(path.join(repoRoot, "created.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "unrelated worktree\n");
  assert.equal(await git(repoRoot, ["show", ":unrelated.txt"]), "unrelated staged\n");
  assert.equal((await git(repoRoot, ["status", "--short", "--", "selected.txt", "deleted.txt", "created.txt"])).trim(), "");
});

test("treats restore paths literally", async () => {
  const { repoRoot } = await createRepository();
  const checkpoint = await createGitCheckpoint({ cwd: repoRoot, purpose: "baseline", threadId: "thread-one" });
  await write(repoRoot, "literal[1].txt", "literal changed\n");
  await write(repoRoot, "literal1.txt", "neighbor changed\n");

  const result = await restoreGitCheckpointPaths({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    filePaths: ["literal[1].txt"],
    threadId: "thread-one",
  });

  assert.deepEqual(result.restoredPaths, ["literal[1].txt"]);
  assert.equal(await fs.readFile(path.join(repoRoot, "literal[1].txt"), "utf8"), "literal checkpoint\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "literal1.txt"), "utf8"), "neighbor changed\n");
});

test("rejects repository-root and outside restore paths", async () => {
  const { repoRoot } = await createRepository();
  const checkpoint = await createGitCheckpoint({ cwd: repoRoot, purpose: "baseline", threadId: "thread-one" });
  const input = {
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  };

  await assert.rejects(
    restoreGitCheckpointPaths({ ...input, filePaths: ["."] }),
    /cannot target the repository root/u,
  );
  await assert.rejects(
    restoreGitCheckpointPaths({ ...input, filePaths: ["../outside.txt"] }),
    /must stay inside the Git repository/u,
  );
});

test("rejects a path restore after HEAD moves away from the checkpoint parent", async () => {
  const { repoRoot } = await createRepository();
  const checkpoint = await createGitCheckpoint({ cwd: repoRoot, purpose: "baseline", threadId: "thread-one" });
  await write(repoRoot, "head-moved.txt", "new commit\n");
  await git(repoRoot, ["add", "--", "head-moved.txt"]);
  await git(repoRoot, ["commit", "-m", "move head"]);

  await assert.rejects(restoreGitCheckpointPaths({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    filePaths: ["selected.txt"],
    threadId: "thread-one",
  }), /Checkpoint parent differs from current HEAD/u);
});
