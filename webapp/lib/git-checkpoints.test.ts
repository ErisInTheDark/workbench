/*
 * Exports:
 * - No production exports; Node tests cover full checkpoints, verified paths, amendment, proposals, commit isolation, and restore. Keywords: git, checkpoint, proposal, restore, test.
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
  restoreGitCheckpoint,
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
  await write(repoRoot, "selected.txt", "lint after unrelated commit\n");
  const afterUnrelatedCommit = await restoreGitCheckpointPaths({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    filePaths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(afterUnrelatedCommit.restoredPaths, ["selected.txt"]);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "selected checkpoint\n");
  await assert.rejects(restoreGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    confirmRestore: true,
    cwd: repoRoot,
    threadId: "thread-one",
  }), /Checkpoint parent differs from current HEAD/u);

  await write(repoRoot, "selected.txt", "committed selected change\n");
  await git(repoRoot, ["add", "--", "selected.txt"]);
  await git(repoRoot, ["commit", "-m", "change selected path"]);
  await write(repoRoot, "selected.txt", "later lint change\n");
  await assert.rejects(restoreGitCheckpointPaths({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    filePaths: ["selected.txt"],
    threadId: "thread-one",
  }), /Selected restore paths changed in committed history.*selected\.txt/u);
});

checkpointTest("implementation checkpoints reject dirty planned paths and snapshot the full worktree", async (context) => {
  const { repoRoot } = await createRepository(context);
  await write(repoRoot, "selected.txt", "already dirty\n");
  await assert.rejects(createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /Implementation checkpoint paths must be clean: selected\.txt/u);

  await git(repoRoot, ["restore", "--", "selected.txt"]);
  await write(repoRoot, "unrelated.txt", "unrelated dirty at checkpoint\n");
  await write(repoRoot, "untracked-at-checkpoint.txt", "untracked checkpoint content\n");
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.equal(await git(repoRoot, ["show", `${checkpoint.checkpointCommit}:unrelated.txt`]), "unrelated dirty at checkpoint\n");
  assert.equal(
    await git(repoRoot, ["show", `${checkpoint.checkpointCommit}:untracked-at-checkpoint.txt`]),
    "untracked checkpoint content\n",
  );
  await write(repoRoot, "selected.txt", "implementation\n");
  await write(repoRoot, "unrelated.txt", "later unrelated change\n");
  const comparison = await compareGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["selected.txt", "unrelated.txt"]);
  assert.match((await diffGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  })).diff, /implementation/u);
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
    title: "Commit selected work",
  });
  assert.deepEqual(proposal.paths, ["selected.txt", "unrelated.txt"]);
  assert.equal("changes" in proposal, false);
});

checkpointTest("amending preserves the full baseline and verifies only new clean unchanged paths", async (context) => {
  const { repoRoot } = await createRepository(context);
  const original = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  const originalTree = (await git(repoRoot, ["rev-parse", `${original.checkpointCommit}^{tree}`])).trim();
  const originalParent = (await git(repoRoot, ["rev-parse", `${original.checkpointCommit}^`])).trim();
  await write(repoRoot, "selected.txt", "first implementation\n");
  const amended = await createGitImplementationCheckpoint({
    amendCheckpoint: original.checkpointCommit,
    cwd: repoRoot,
    paths: ["planned-new.tsx", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(amended.scopePaths, ["planned-new.tsx", "selected.txt", "unrelated.txt"]);
  assert.equal((await git(repoRoot, ["rev-parse", `${amended.checkpointCommit}^{tree}`])).trim(), originalTree);
  assert.equal((await git(repoRoot, ["rev-parse", `${amended.checkpointCommit}^`])).trim(), originalParent);
  await write(repoRoot, "planned-new.tsx", "export default function PlannedNew() {}\n");
  const comparison = await compareGitCheckpoint({
    checkpointCommit: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["planned-new.tsx", "selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["planned-new.tsx", "selected.txt"]);
  assert.equal(comparison.changes.find((change) => change.path === "planned-new.tsx")?.kind.type, "add");
  await assert.rejects(createGitImplementationCheckpoint({
    amendCheckpoint: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /already covered/u);

  await write(repoRoot, "deleted.txt", "dirty amendment path\n");
  await assert.rejects(createGitImplementationCheckpoint({
    amendCheckpoint: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["deleted.txt"],
    threadId: "thread-one",
  }), /Implementation checkpoint paths must be clean: deleted\.txt/u);
  await git(repoRoot, ["restore", "--", "deleted.txt"]);

  await write(repoRoot, "literal1.txt", "committed after checkpoint\n");
  await git(repoRoot, ["add", "--", "literal1.txt"]);
  await git(repoRoot, ["commit", "-m", "change later planned path"]);
  await assert.rejects(createGitImplementationCheckpoint({
    amendCheckpoint: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["literal1.txt"],
    threadId: "thread-one",
  }), /Implementation amendment paths changed since checkpoint: literal1\.txt/u);
});

checkpointTest("proposal file sets stay frozen while newer selected edits remain optional", async (context) => {
  const { repoRoot } = await createRepository(context);
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["deleted.txt", "literal[1].txt", "selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  await write(repoRoot, "deleted.txt", "proposed newer-path version\n");
  await write(repoRoot, "literal[1].txt", "proposed clean-path version\n");
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
  const newerProposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["deleted.txt"],
    threadId: "thread-one",
    title: "Commit newer selected",
  });
  const cleanProposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["literal[1].txt"],
    threadId: "thread-one",
    title: "Expire clean selected",
  });
  await write(repoRoot, "selected.txt", "newer version\n");
  await write(repoRoot, "deleted.txt", "newer selected version\n");
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

  const committedNewer = await commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "Includes the selected tweak",
    includeNewer: true,
    proposalId: newerProposal.proposalId,
    threadId: "thread-one",
    title: "Commit newer selected",
  });
  assert.equal(committedNewer.status, "committed");
  assert.equal(await git(repoRoot, ["show", "HEAD:deleted.txt"]), "newer selected version\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:unrelated.txt"]), "unrelated checkpoint\n");
  assert.equal(await git(repoRoot, ["show", ":unrelated.txt"]), "unrelated staged\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "unrelated worktree\n");

  await git(repoRoot, ["restore", "--", "literal[1].txt"]);
  const unavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: cleanProposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.unavailableReason ?? "", /no longer has working-tree changes/u);
  const stillUnavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: cleanProposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(stillUnavailable.status, "unavailable");

  await assert.rejects(commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "Frozen proposal",
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
    title: "Commit selected again",
  }), /not available to commit/u);
});

checkpointTest("proposals rebase across compatible commits and reject selected or incompatible history", async (context) => {
  const { repoRoot } = await createRepository(context);
  const rootCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const checkpoint = await createGitImplementationCheckpoint({
    cwd: repoRoot,
    paths: ["deleted.txt", "literal[1].txt", "selected.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  await write(repoRoot, "deleted.txt", "conflicting proposal version\n");
  await write(repoRoot, "literal[1].txt", "alternate-branch proposal version\n");
  await write(repoRoot, "before-proposal.txt", "committed before proposal\n");
  await git(repoRoot, ["add", "--", "before-proposal.txt"]);
  await git(repoRoot, ["commit", "-m", "advance before proposal"]);
  const compatibleProposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected",
  });
  const conflictProposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["deleted.txt"],
    threadId: "thread-one",
    title: "Conflict selected path",
  });
  const incompatibleProposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["literal[1].txt"],
    threadId: "thread-one",
    title: "Incompatible history",
  });
  const proposalBase = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  assert.equal(compatibleProposal.baseCommit, proposalBase);
  await write(repoRoot, "head-moved.txt", "new head\n");
  await git(repoRoot, ["add", "--", "head-moved.txt"]);
  await git(repoRoot, ["commit", "-m", "move head"]);
  const rebasedHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const rebased = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: compatibleProposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(rebased.status, "proposed");
  assert.equal(rebased.baseCommit, rebasedHead);
  assert.deepEqual(rebased.changes.map((change) => change.path), ["selected.txt"]);

  const committed = await commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    includeNewer: false,
    proposalId: compatibleProposal.proposalId,
    threadId: "thread-one",
    title: "Commit selected",
  });
  assert.equal(committed.status, "committed");
  assert.equal((await git(repoRoot, ["rev-parse", "HEAD^"])).trim(), rebasedHead);
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "proposed version\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:before-proposal.txt"]), "committed before proposal\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:head-moved.txt"]), "new head\n");

  await write(repoRoot, "deleted.txt", "committed elsewhere\n");
  await git(repoRoot, ["add", "--", "deleted.txt"]);
  await git(repoRoot, ["commit", "-m", "commit selected elsewhere"]);
  const conflicted = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: conflictProposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(conflicted.status, "unavailable");
  assert.match(conflicted.unavailableReason ?? "", /Proposed paths changed in committed history: deleted\.txt/u);

  await git(repoRoot, ["checkout", "--quiet", "--detach", rootCommit]);
  await write(repoRoot, "branch-only.txt", "alternate advance\n");
  await git(repoRoot, ["add", "--", "branch-only.txt"]);
  await git(repoRoot, ["commit", "-m", "advance alternate branch"]);
  const incompatible = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: incompatibleProposal.proposalId,
    threadId: "thread-one",
  });
  assert.equal(incompatible.status, "unavailable");
  assert.match(incompatible.unavailableReason ?? "", /HEAD moved incompatibly/u);
});
