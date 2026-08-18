/*
 * Exports:
 * - No production exports; Node tests cover scoped checkpoints, amendment, proposals, commit isolation, and restore. Keywords: git, checkpoint, proposal, restore, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  commitGitCheckpointProposal,
  compareGitCheckpoint,
  createGitCheckpointProposal,
  createGitImplementationCheckpoint,
  createGitPlanCheckpoint,
  diffGitCheckpoint,
  readGitCheckpointProposal,
  restoreGitCheckpointPaths,
} from "./git-checkpoints.ts";

const execFileAsync = promisify(execFile);
let templateRoot = "";

function checkpointTest(name: string, run: (context: TestContext) => Promise<void>) {
  test(name, { concurrency: true }, run);
}

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "workbench@example.invalid",
      GIT_AUTHOR_NAME: "Workbench Test",
      GIT_COMMITTER_EMAIL: "workbench@example.invalid",
      GIT_COMMITTER_NAME: "Workbench Test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
    },
    windowsHide: true,
  })).stdout;
}

async function write(repoRoot: string, relativePath: string, contents: string) {
  const filePath = path.join(repoRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createRepository(context: TestContext) {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-checkpoint-test-"));
  context.after(async () => {
    await fs.rm(testRoot, { force: true, recursive: true });
  });
  const repoRoot = path.join(testRoot, "repo");
  await git(testRoot, ["clone", "--quiet", templateRoot, repoRoot]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  return { repoRoot, testRoot };
}

before(async () => {
  templateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-checkpoint-template-"));
  await git(templateRoot, ["init", "-b", "main"]);
  await write(templateRoot, "selected.txt", "selected checkpoint\n");
  await write(templateRoot, "deleted.txt", "deleted checkpoint\n");
  await write(templateRoot, "unrelated.txt", "unrelated checkpoint\n");
  await write(templateRoot, "literal[1].txt", "literal checkpoint\n");
  await write(templateRoot, "literal1.txt", "neighbor checkpoint\n");
  await git(templateRoot, ["add", "-A"]);
  await git(templateRoot, ["commit", "-m", "base"]);
});

after(async () => {
  await fs.rm(templateRoot, { force: true, recursive: true });
});

checkpointTest("restores only selected checkpoint paths while preserving the ordinary index and unrelated worktree changes", async (context) => {
  const { repoRoot } = await createRepository(context);
  const checkpoint = await createGitPlanCheckpoint({ cwd: repoRoot, threadId: "thread-one" });
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

  await write(repoRoot, "literal[1].txt", "literal changed\n");
  await write(repoRoot, "literal1.txt", "neighbor changed\n");
  const literalResult = await restoreGitCheckpointPaths({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    filePaths: ["literal[1].txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(literalResult.restoredPaths, ["literal[1].txt"]);
  assert.equal(await fs.readFile(path.join(repoRoot, "literal[1].txt"), "utf8"), "literal checkpoint\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "literal1.txt"), "utf8"), "neighbor changed\n");

  const restoreInput = {
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  };
  await assert.rejects(
    restoreGitCheckpointPaths({ ...restoreInput, filePaths: ["."] }),
    /must identify content inside the Git repository/u,
  );
  await assert.rejects(
    restoreGitCheckpointPaths({ ...restoreInput, filePaths: ["../outside.txt"] }),
    /must stay inside the Git repository/u,
  );

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

checkpointTest("implementation checkpoints reject dirty paths and enforce stored scope", async (context) => {
  const { repoRoot } = await createRepository(context);
  await write(repoRoot, "selected.txt", "already dirty\n");
  await assert.rejects(createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /Implementation checkpoint paths must be clean: selected\.txt/u);

  await git(repoRoot, ["restore", "--", "selected.txt"]);
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "implementation\n");
  const comparison = await compareGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["selected.txt"]);
  assert.match((await diffGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  })).diff, /implementation/u);
  await assert.rejects(compareGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    paths: ["unrelated.txt"],
    threadId: "thread-one",
  }), /outside implementation scope/u);
});

checkpointTest("amending preserves the original baseline and adds only new clean scope", async (context) => {
  const { repoRoot } = await createRepository(context);
  const original = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "first implementation\n");
  const amended = await createGitImplementationCheckpoint({
    amendCheckpoint: original.checkpointCommit,
    cwd: repoRoot,
    paths: ["unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(amended.scopePaths, ["selected.txt", "unrelated.txt"]);
  const comparison = await compareGitCheckpoint({
    checkpointCommit: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["selected.txt"]);
  await assert.rejects(createGitImplementationCheckpoint({
    amendCheckpoint: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /already covered/u);
});

checkpointTest("proposal file sets stay frozen while newer selected edits remain optional", async (context) => {
  const { repoRoot } = await createRepository(context);
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  await assert.rejects(createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
    title: "Reject clean path",
  }), /Every proposed path must identify an exact changed file: unrelated\.txt/u);
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "Frozen proposal",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected",
  });
  await write(repoRoot, "selected.txt", "newer version\n");
  await write(repoRoot, "unrelated.txt", "unrelated staged\n");
  await git(repoRoot, ["add", "--", "unrelated.txt"]);
  await write(repoRoot, "unrelated.txt", "unrelated worktree\n");
  const newerPreview = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: true,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(newerPreview.includeNewerAvailable, true);
  assert.match(newerPreview.changes[0]?.diff ?? "", /newer version/u);
  assert.deepEqual(newerPreview.paths, ["selected.txt"]);

  const committed = await commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "Frozen proposal",
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
    title: "Commit selected",
  });
  assert.equal(committed.status, "committed");
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "proposed version\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "newer version\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:unrelated.txt"]), "unrelated checkpoint\n");
  assert.equal(await git(repoRoot, ["show", ":unrelated.txt"]), "unrelated staged\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "unrelated worktree\n");
  await assert.rejects(commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "Frozen proposal",
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
    title: "Commit selected again",
  }), /not available to commit/u);
});

checkpointTest("proposal can commit newer versions without expanding its file set", async (context) => {
  const { repoRoot } = await createRepository(context);
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected",
  });
  await write(repoRoot, "selected.txt", "newer version\n");
  await write(repoRoot, "unrelated.txt", "outside proposal\n");
  const committed = await commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "Includes the selected tweak",
    includeNewer: true,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
    title: "Commit newer selected",
  });
  assert.equal(committed.status, "committed");
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "newer version\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:unrelated.txt"]), "unrelated checkpoint\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "outside proposal\n");
});

checkpointTest("proposal becomes durably unavailable when a saved file becomes clean", async (context) => {
  const { repoRoot } = await createRepository(context);
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected",
  });
  await git(repoRoot, ["restore", "--", "selected.txt"]);
  const unavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.unavailableReason ?? "", /no longer has working-tree changes/u);
  const stillUnavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(stillUnavailable.status, "unavailable");
});

checkpointTest("proposal becomes unavailable when HEAD moves", async (context) => {
  const { repoRoot } = await createRepository(context);
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected",
  });
  await write(repoRoot, "head-moved.txt", "new head\n");
  await git(repoRoot, ["add", "--", "head-moved.txt"]);
  await git(repoRoot, ["commit", "-m", "move head"]);
  const unavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.unavailableReason ?? "", /HEAD moved/u);
});
