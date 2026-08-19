/*
 * Exports:
 * - No production exports; Node tests cover full checkpoints, arc claims, proposals, commit isolation, and restore. Keywords: git, checkpoint, arc, proposal, restore, test.
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
  createGitPlan,
  diffGitCheckpoint,
  addToGitArc,
  readGitCheckpointProposal,
  removeFromGitArc,
  restoreGitCheckpoint,
  restoreGitCheckpointPaths,
} from "./git-checkpoints.ts";

const execFileAsync = promisify(execFile);
const checkpointCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];
let templateRoot = "";

function checkpointTest(name: string, run: (context: TestContext) => Promise<void>) {
  checkpointCases.push({ name, run });
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
  const checkpoint = await createGitPlan({
    cwd: repoRoot,
    intentName: "Restore selected paths",
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
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
  }), /Selected restore paths no longer match the arc baseline.*selected\.txt/u);
});

checkpointTest("plans reject dirty claimed paths and snapshot the full worktree", async (context) => {
  const { repoRoot } = await createRepository(context);
  await write(repoRoot, "selected.txt", "already dirty\n");
  await assert.rejects(createGitPlan({
    cwd: repoRoot,
    intentName: "Update selected",
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /Plan paths must be clean against HEAD: selected\.txt/u);

  await git(repoRoot, ["restore", "--", "selected.txt"]);
  await write(repoRoot, "unrelated.txt", "unrelated dirty at checkpoint\n");
  await write(repoRoot, "untracked-at-checkpoint.txt", "untracked checkpoint content\n");
  const checkpoint = await createGitPlan({
    cwd: repoRoot,
    intentName: "Update selected",
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
  const arcComparison = await compareGitCheckpoint({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.deepEqual(arcComparison.changes.map((change) => change.path), ["selected.txt"]);
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
    threadId: "thread-one",
  })).diff, /implementation/u);
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected work",
  });
  assert.deepEqual(proposal.paths, ["selected.txt"]);
  assert.equal("changes" in proposal, false);
});

checkpointTest("arc additions preserve the full baseline and verify continuation before new paths", async (context) => {
  const { repoRoot } = await createRepository(context);
  await write(repoRoot, "later-claim.txt", "captured before plan\n");
  const original = await createGitPlan({
    cwd: repoRoot,
    intentName: "Update selected",
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  const originalTree = (await git(repoRoot, ["rev-parse", `${original.checkpointCommit}^{tree}`])).trim();
  const originalParent = (await git(repoRoot, ["rev-parse", `${original.checkpointCommit}^`])).trim();
  await assert.rejects(removeFromGitArc({
    checkpointCommit: original.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /must leave at least one claimed path/u);
  await write(repoRoot, "selected.txt", "first implementation\n");
  const continuation = await addToGitArc({
    checkpointCommit: original.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.deepEqual(continuation.scopePaths, ["selected.txt"]);
  assert.equal((await git(repoRoot, ["rev-parse", `${continuation.checkpointCommit}^{tree}`])).trim(), originalTree);
  assert.equal((await git(repoRoot, ["rev-parse", `${continuation.checkpointCommit}^`])).trim(), originalParent);

  await write(repoRoot, "head-only.txt", "compatible committed change\n");
  await git(repoRoot, ["add", "--", "head-only.txt", "later-claim.txt"]);
  await git(repoRoot, ["commit", "-m", "advance unrelated head"]);
  const compatibleHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const compatibleContinuation = await addToGitArc({
    checkpointCommit: continuation.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  const amended = await addToGitArc({
    checkpointCommit: compatibleContinuation.checkpointCommit,
    cwd: repoRoot,
    paths: ["literal[1].txt", "planned-new.tsx", "later-claim.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(amended.scopePaths, ["later-claim.txt", "literal[1].txt", "planned-new.tsx", "selected.txt", "unrelated.txt"]);
  assert.equal((await git(repoRoot, ["rev-parse", `${amended.checkpointCommit}^{tree}`])).trim(), originalTree);
  assert.equal((await git(repoRoot, ["rev-parse", `${compatibleContinuation.checkpointCommit}^`])).trim(), compatibleHead);
  assert.equal((await git(repoRoot, ["rev-parse", `${amended.checkpointCommit}^`])).trim(), compatibleHead);
  await write(repoRoot, "planned-new.tsx", "export default function PlannedNew() {}\n");
  await write(repoRoot, "later-claim.txt", "implementation after claim\n");
  const laterClaimProposal = await createGitCheckpointProposal({
    checkpointCommit: amended.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["later-claim.txt"],
    threadId: "thread-one",
    title: "Commit later claim",
  });
  assert.deepEqual(laterClaimProposal.paths, ["later-claim.txt"]);
  const comparison = await compareGitCheckpoint({
    checkpointCommit: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["planned-new.tsx", "selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["planned-new.tsx", "selected.txt"]);
  assert.equal(comparison.changes.find((change) => change.path === "planned-new.tsx")?.kind.type, "add");

  await write(repoRoot, "unrelated.txt", "dirty before remove\n");
  await assert.rejects(removeFromGitArc({
    checkpointCommit: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["unrelated.txt"],
    threadId: "thread-one",
  }), /Arc remove paths must be clean against HEAD: unrelated\.txt/u);
  await git(repoRoot, ["restore", "--", "unrelated.txt"]);
  const reduced = await removeFromGitArc({
    checkpointCommit: amended.checkpointCommit,
    cwd: repoRoot,
    paths: ["unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(reduced.scopePaths, ["later-claim.txt", "literal[1].txt", "planned-new.tsx", "selected.txt"]);
  assert.equal((await git(repoRoot, ["rev-parse", `${reduced.checkpointCommit}^{tree}`])).trim(), originalTree);
  assert.equal((await git(repoRoot, ["rev-parse", `${reduced.checkpointCommit}^`])).trim(), compatibleHead);
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "unrelated checkpoint\n");
  await assert.rejects(removeFromGitArc({
    checkpointCommit: reduced.checkpointCommit,
    cwd: repoRoot,
    paths: ["literal1.txt"],
    threadId: "thread-one",
  }), /must exactly match claimed entries: literal1\.txt/u);

  await assert.rejects(addToGitArc({
    checkpointCommit: reduced.checkpointCommit,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /already covered/u);

  await write(repoRoot, "deleted.txt", "dirty amendment path\n");
  await assert.rejects(addToGitArc({
    checkpointCommit: reduced.checkpointCommit,
    cwd: repoRoot,
    paths: ["deleted.txt"],
    threadId: "thread-one",
  }), /Plan paths must be clean against HEAD: deleted\.txt/u);
  await git(repoRoot, ["restore", "--", "deleted.txt"]);

  await write(repoRoot, "literal1.txt", "committed after checkpoint\n");
  await git(repoRoot, ["add", "--", "literal1.txt"]);
  await git(repoRoot, ["commit", "-m", "change later planned path"]);
  await assert.rejects(addToGitArc({
    checkpointCommit: reduced.checkpointCommit,
    cwd: repoRoot,
    paths: ["literal1.txt"],
    threadId: "thread-one",
  }), /New arc paths changed since the original plan: literal1\.txt/u);

  await git(repoRoot, ["add", "--", "selected.txt"]);
  await git(repoRoot, ["commit", "-m", "commit claimed path"]);
  await assert.rejects(addToGitArc({
    checkpointCommit: reduced.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  }), /Claimed paths no longer match the arc baseline.*selected\.txt/u);
  await assert.rejects(removeFromGitArc({
    checkpointCommit: reduced.checkpointCommit,
    cwd: repoRoot,
    paths: ["literal[1].txt"],
    threadId: "thread-one",
  }), /Retained paths no longer match the arc baseline.*selected\.txt/u);
});

checkpointTest("proposal file sets stay frozen while newer selected edits remain optional", async (context) => {
  const { repoRoot } = await createRepository(context);
  const encodedThreadId = Buffer.from("thread-one", "utf8").toString("base64url");
  await write(repoRoot, ".git/info/exclude", ".workbench/\n");
  await write(repoRoot, `.workbench/transcripts/codex/threads/${encodedThreadId}/thread.json`, "{}\n");
  const checkpoint = await createGitPlan({
    cwd: repoRoot,
    intentName: "Freeze proposal files",
    paths: ["deleted.txt", "literal[1].txt", "selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "proposed version\n");
  await write(repoRoot, "deleted.txt", "proposed newer-path version\n");
  await write(repoRoot, "literal[1].txt", "proposed clean-path version\n");
  const arcProposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    threadId: "thread-one",
    title: "Commit arc changes",
  });
  assert.deepEqual(arcProposal.paths, ["deleted.txt", "literal[1].txt", "selected.txt"]);
  await assert.rejects(createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "",
    paths: ["outside.txt"],
    threadId: "thread-one",
    title: "Reject outside path",
  }), /must stay within the arc's claimed set: outside\.txt/u);
  const proposal = await createGitCheckpointProposal({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    description: "Frozen proposal",
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
    title: "Commit selected",
  });
  assert.deepEqual(proposal.paths, ["selected.txt"]);
  const proposalCacheDirectory = path.join(
    repoRoot,
    ".workbench",
    "transcripts",
    "codex",
    "threads",
    encodedThreadId,
    "artifacts",
    "git-arc-proposals",
    proposal.proposalId,
  );
  const proposalCacheFiles = await fs.readdir(proposalCacheDirectory);
  assert.equal(proposalCacheFiles.length, 1);
  const proposalCachePath = path.join(proposalCacheDirectory, proposalCacheFiles[0]);
  const cacheBeforeRead = await fs.stat(proposalCachePath);
  const cachedPreview = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "thread-one",
  });
  const cacheAfterRead = await fs.stat(proposalCachePath);
  assert.match(cachedPreview.changes[0]?.diff ?? "", /proposed version/u);
  assert.equal(cacheAfterRead.mtimeMs, cacheBeforeRead.mtimeMs);
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
  const checkpoint = await createGitPlan({
    cwd: repoRoot,
    intentName: "Rebase proposal",
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

test("Git checkpoint controller operations", { concurrency: true }, async (context) => {
  await Promise.all(checkpointCases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
