/*
 * Exports:
 * - No production exports; bounded concurrent Node tests cover thread-owned path selection, current-content commits, hook execution, isolation, unstage behavior, and failure recovery. Keywords: git, thread, selection, commit, hooks, concurrency, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF, type GitRefUpdate } from "./WorkbenchGitRepository";
import GitTestFixtureCache, { type GitTestFixtureSpec } from "./GitTestFixtureCache";
import {
  HISTORY_GLOBAL_REMAP_READY_FIXTURE,
  HISTORY_MERGE_READY_FIXTURE,
  HISTORY_PUSHED_READY_FIXTURE,
  HISTORY_SIGNED_READY_FIXTURE,
  THREAD_GIT_BASE_FIXTURE,
  THREAD_GIT_LINEAR_FIXTURE,
} from "./WorkbenchGitTestFixtures";
import WorkbenchThreadGit from "./WorkbenchThreadGit.ts";
import {
  type ArcOutcome,
  outcomeRef,
  parseMarkedMetadata,
  PROPOSAL_METADATA_MARKER,
  type ProposalMetadata,
} from "./git-arc-storage";

const execFileAsync = promisify(execFile);
const fixtureCache = new GitTestFixtureCache();
const threadGitCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];

function threadGitTest(name: string, run: (context: TestContext) => Promise<void>) {
  threadGitCases.push({ name, run });
}

class RacingGitRepository extends WorkbenchGitRepository {
  raced = false;

  override async updateRefs(
    updates: GitRefUpdate[],
    deletes: Array<{ oldValue?: string; ref: string }> = [],
    options: { expectedStateGeneration?: string | null } = {},
  ) {
    if (options.expectedStateGeneration !== undefined && !this.raced) {
      this.raced = true;
      const competingGeneration = await this.writeBlob("concurrent Workbench ref writer\n");
      await this.updateRef(GIT_STATE_GENERATION_REF, competingGeneration);
    }
    await super.updateRefs(updates, deletes, options);
  }
}

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
}

async function write(repoRoot: string, relativePath: string, contents: string) {
  const filePath = path.join(repoRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createRepository(context: TestContext) {
  return await createRepositoryFrom(context, THREAD_GIT_BASE_FIXTURE);
}

async function createRepositoryFrom<State extends object>(context: TestContext, spec: GitTestFixtureSpec<State>) {
  const { root: repoRoot, state, storageRootPath, temporaryRoot: testRoot } = await fixtureCache.copy(spec);
  context.after(async () => await fs.rm(testRoot, { force: true, recursive: true }));
  return { repoRoot, state, storageRootPath, testRoot };
}

threadGitTest("commits selected paths at commit time while preserving unrelated staged work", async (context) => {
  const { repoRoot, storageRootPath } = await createRepository(context);
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

threadGitTest("uses the repository's configured commit hooks", async (context) => {
  const { repoRoot, storageRootPath } = await createRepository(context);
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

threadGitTest("isolates thread selections and stacks disjoint commits from the current HEAD", async (context) => {
  const { repoRoot, storageRootPath } = await createRepository(context);
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

threadGitTest("expands directories to changed files and unstages selected descendants", async (context) => {
  const { repoRoot, storageRootPath } = await createRepository(context);
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

threadGitTest("restores a claimed selection when the selected files are no longer committable", async (context) => {
  const { repoRoot, storageRootPath } = await createRepository(context);
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

threadGitTest("rejects selections outside the repository", async (context) => {
  const { repoRoot, storageRootPath } = await createRepository(context);
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "thread-one" });
  await assert.rejects(owner.add(["../outside.txt"]), /must stay inside the repository/u);
});

threadGitTest("a primary control cwd selects and commits only inside an explicit registered secondary worktree", async (context) => {
  const { repoRoot, storageRootPath, testRoot } = await createRepository(context);
  const secondaryRoot = path.join(testRoot, "secondary");
  await git(repoRoot, ["worktree", "add", "-b", "secondary", secondaryRoot]);
  await write(repoRoot, "selected.txt", "primary selected\n");
  await write(secondaryRoot, "selected.txt", "secondary selected\n");
  await write(secondaryRoot, "ordinary.txt", "secondary staged\n");
  await git(secondaryRoot, ["add", "--", "ordinary.txt"]);

  const primaryOwner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "primary-owned-thread" });
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, targetWorktree: secondaryRoot, threadId: "primary-owned-thread" });
  assert.deepEqual((await primaryOwner.add(["selected.txt"])).selectedPaths, ["selected.txt"]);
  assert.deepEqual((await owner.add(["selected.txt"])).selectedPaths, ["selected.txt"]);
  const result = await owner.commit("secondary worktree commit");

  assert.deepEqual(result.committedPaths, ["selected.txt"]);
  assert.equal(await git(secondaryRoot, ["show", "HEAD:selected.txt"]), "secondary selected\n");
  assert.equal(await git(secondaryRoot, ["show", "HEAD:ordinary.txt"]), "ordinary base\n");
  assert.equal((await git(secondaryRoot, ["diff", "--cached", "--name-only"])).trim(), "ordinary.txt");
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "selected base\n");
  assert.deepEqual((await primaryOwner.commit("primary worktree commit")).committedPaths, ["selected.txt"]);
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "primary selected\n");
});

threadGitTest("explicit targets fail closed unless they are absolute registered worktrees of the control repository", async (context) => {
  const { repoRoot, storageRootPath, testRoot } = await createRepository(context);
  const ordinaryDirectory = path.join(testRoot, "ordinary-directory");
  await fs.mkdir(ordinaryDirectory);
  await assert.rejects(
    WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, targetWorktree: ordinaryDirectory, threadId: "thread-one" }),
    /registered Git worktree/u,
  );
  await assert.rejects(
    WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, targetWorktree: "relative-worktree", threadId: "thread-one" }),
    /absolute path/u,
  );

  const foreignRoot = path.join(testRoot, "foreign");
  await fs.mkdir(foreignRoot);
  await git(foreignRoot, ["init", "-b", "main"]);
  await assert.rejects(
    WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, targetWorktree: foreignRoot, threadId: "thread-one" }),
    /registered Git worktree/u,
  );
});

threadGitTest("older amendment can replace the unpushed root commit and replay the full linear stack", async (context) => {
  const { repoRoot, storageRootPath, testRoot } = await createRepositoryFrom(context, THREAD_GIT_LINEAR_FIXTURE);
  const rootCommit = (await git(repoRoot, ["rev-list", "--max-parents=0", "HEAD"])).trim();
  const secondaryRoot = path.join(testRoot, "secondary-amend-witness");
  await git(repoRoot, ["worktree", "add", "--quiet", "-b", "secondary-amend-witness", secondaryRoot]);
  const secondaryHead = (await git(secondaryRoot, ["rev-parse", "HEAD"])).trim();
  const secondarySelected = await fs.readFile(path.join(secondaryRoot, "selected.txt"));
  const secondaryLater = await fs.readFile(path.join(secondaryRoot, "later.txt"));
  const secondaryIndex = await git(secondaryRoot, ["diff", "--cached", "--binary"]);
  await write(repoRoot, "root-added.txt", "present from rewritten root\n");
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "root-amend-thread" });
  await owner.add(["root-added.txt"]);

  const result = await owner.commit("rewritten root", rootCommit);

  assert.equal(result.rewrittenCommitCount, 3);
  assert.equal(await git(repoRoot, ["show", `${result.amendedCommit}:root-added.txt`]), "present from rewritten root\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:root-added.txt"]), "present from rewritten root\n");
  assert.equal((await git(repoRoot, ["show", "-s", "--format=%s", "HEAD"])).trim(), "descendant");
  assert.notEqual(result.commit, secondaryHead);
  assert.equal((await git(secondaryRoot, ["rev-parse", "HEAD"])).trim(), secondaryHead);
  assert.deepEqual(await fs.readFile(path.join(secondaryRoot, "selected.txt")), secondarySelected);
  assert.deepEqual(await fs.readFile(path.join(secondaryRoot, "later.txt")), secondaryLater);
  assert.equal(await git(secondaryRoot, ["diff", "--cached", "--binary"]), secondaryIndex);
});

threadGitTest("older amendment preserves selected/index state and remaps every Workbench SHA", async (context) => {
  const { repoRoot, state, storageRootPath } = await createRepositoryFrom(context, HISTORY_GLOBAL_REMAP_READY_FIXTURE);
  const repository = new WorkbenchGitRepository(repoRoot);
  const controller = new WorkbenchGitCheckpointController();
  const brokenRefPath = path.join(repoRoot, state.brokenRefRelativePath);
  await fs.mkdir(path.dirname(brokenRefPath), { recursive: true });
  await fs.writeFile(brokenRefPath, `${"1".repeat(40)}\n`, "utf8");
  await fs.rm(path.join(repoRoot, "selected.txt"));
  await write(repoRoot, "created.txt", "created amendment\n");
  await write(repoRoot, "ordinary.txt", "ordinary staged\n");
  await git(repoRoot, ["add", "ordinary.txt"]);
  const createdBefore = await fs.readFile(path.join(repoRoot, "created.txt"));
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "metadata-commit-thread" });
  await owner.add(["created.txt", "selected.txt"]);

  const rewrite = await owner.commit("rewrite metadata graph", state.target);

  assert.deepEqual(rewrite.committedPaths, ["created.txt", "selected.txt"]);
  assert.match(rewrite.warnings?.join("\n") ?? "", /Skipped unreadable Workbench ref.+missing object/u);
  assert.equal(await fs.readFile(brokenRefPath, "utf8"), `${"1".repeat(40)}\n`);
  await assert.rejects(git(repoRoot, ["show", "HEAD:selected.txt"]));
  assert.equal(await git(repoRoot, ["show", "HEAD:created.txt"]), "created amendment\n");
  assert.equal(await git(repoRoot, ["show", "HEAD:later.txt"]), "later descendant\n");
  await assert.rejects(fs.stat(path.join(repoRoot, "selected.txt")));
  assert.deepEqual(await fs.readFile(path.join(repoRoot, "created.txt")), createdBefore);
  assert.equal((await git(repoRoot, ["diff", "--cached", "--name-only"])).trim(), "ordinary.txt");
  const nextProposalCommit = await repository.readRef(state.proposalRef);
  assert.ok(nextProposalCommit);
  const nextProposal = parseMarkedMetadata<ProposalMetadata>(
    (await repository.readCommit(nextProposalCommit)).message,
    PROPOSAL_METADATA_MARKER,
  );
  assert.ok(nextProposal);
  assert.equal(nextProposal.amendTargetSha, rewrite.amendedCommit);
  assert.equal(nextProposal.baseCommit, rewrite.amendedCommit);
  assert.equal(nextProposal.committedSha, rewrite.amendedCommit);
  assert.equal(nextProposal.liveBaseCommit, rewrite.commit);
  assert.equal(nextProposal.supersededBySha, rewrite.commit);
  assert.notEqual(nextProposal.sourceCheckpoint, state.activePlanCheckpoint);
  const active = (await controller.listActiveClaims({ cwd: repoRoot }))
    .find(({ threadId }) => threadId === "metadata-thread");
  assert.equal(active?.checkpointCommit, nextProposal.sourceCheckpoint);
  assert.equal(await repository.readRef(state.previousOutcomeRef), null);
  const nextOutcomeBlob = await repository.readRef(outcomeRef("codex", "metadata-thread", nextProposal.sourceCheckpoint));
  assert.ok(nextOutcomeBlob);
  const nextOutcome = JSON.parse(await repository.readBlob(nextOutcomeBlob)) as ArcOutcome;
  assert.equal(nextOutcome.committedSha, rewrite.commit);
  assert.equal(nextOutcome.sourceCheckpoint, nextProposal.sourceCheckpoint);
  assert.equal(nextOutcome.successorCheckpoint, nextProposal.sourceCheckpoint);
  const started = await controller.startArc({
    checkpointCommit: state.checkpointPlanCheckpoint,
    cwd: repoRoot,
    threadId: "arc-thread",
  });
  assert.notEqual(started.checkpointCommit, state.checkpointPlanCheckpoint);
  assert.match(started.checkpointRef, new RegExp(started.checkpointCommit.slice(0, 8), "u"));
  assert.equal((await git(repoRoot, ["rev-parse", `${started.checkpointCommit}^`])).trim(), (await git(repoRoot, ["rev-parse", "HEAD"])).trim());
});

threadGitTest("a concurrent Workbench ref writer rejects the entire older-amend publication transaction", async (context) => {
  const { repoRoot } = await createRepositoryFrom(context, THREAD_GIT_LINEAR_FIXTURE);
  const target = (await git(repoRoot, ["rev-parse", "HEAD^"])).trim();
  const racingRepository = new RacingGitRepository(repoRoot);
  const headBefore = await racingRepository.currentHead();
  await write(repoRoot, "selected.txt", "amend blocked by race\n");
  const worktreeBefore = await fs.readFile(path.join(repoRoot, "selected.txt"));
  const indexBefore = await git(repoRoot, ["diff", "--cached", "--binary"]);

  await assert.rejects(new WorkbenchGitHistoryRewriter(racingRepository).amend({
    message: "must not publish",
    paths: ["selected.txt"],
    target,
  }));

  assert.equal(racingRepository.raced, true);
  assert.equal(await racingRepository.currentHead(), headBefore);
  assert.deepEqual(await fs.readFile(path.join(repoRoot, "selected.txt")), worktreeBefore);
  assert.equal(await git(repoRoot, ["diff", "--cached", "--binary"]), indexBefore);
  assert.equal(await racingRepository.readRef("refs/worktree/workbench/commit-rewrites"), null);
  assert.notEqual(await racingRepository.readRef(GIT_STATE_GENERATION_REF), null);
});

threadGitTest("older amendment rejects pushed targets and merge-containing descendant ranges without publication", async (context) => {
  const pushed = await createRepositoryFrom(context, HISTORY_PUSHED_READY_FIXTURE);
  await write(pushed.repoRoot, "selected.txt", "must remain local\n");
  const pushedOwner = await WorkbenchThreadGit.create({
    cwd: pushed.repoRoot,
    storageRootPath: pushed.storageRootPath,
    threadId: "pushed-thread",
  });
  await pushedOwner.add(["selected.txt"]);
  const pushedHead = (await git(pushed.repoRoot, ["rev-parse", "HEAD"])).trim();
  const pushedWorktree = await fs.readFile(path.join(pushed.repoRoot, "selected.txt"));
  await assert.rejects(pushedOwner.commit("reject pushed", pushed.state.target), /already present on remote refs/u);
  assert.equal((await git(pushed.repoRoot, ["rev-parse", "HEAD"])).trim(), pushedHead);
  assert.deepEqual(await fs.readFile(path.join(pushed.repoRoot, "selected.txt")), pushedWorktree);

  const merged = await createRepositoryFrom(context, HISTORY_MERGE_READY_FIXTURE);
  await write(merged.repoRoot, "selected.txt", "must reject merge range\n");
  const mergedOwner = await WorkbenchThreadGit.create({
    cwd: merged.repoRoot,
    storageRootPath: merged.storageRootPath,
    threadId: "merge-thread",
  });
  await mergedOwner.add(["selected.txt"]);
  const mergeHead = (await git(merged.repoRoot, ["rev-parse", "HEAD"])).trim();
  const mergeWorktree = await fs.readFile(path.join(merged.repoRoot, "selected.txt"));
  await assert.rejects(mergedOwner.commit("reject merge", merged.state.target), /merge commits are not supported/u);
  assert.equal((await git(merged.repoRoot, ["rev-parse", "HEAD"])).trim(), mergeHead);
  assert.deepEqual(await fs.readFile(path.join(merged.repoRoot, "selected.txt")), mergeWorktree);
});

threadGitTest("older amendment rejects a real commit object containing a signature header", async (context) => {
  const { repoRoot, state, storageRootPath } = await createRepositoryFrom(context, HISTORY_SIGNED_READY_FIXTURE);
  const repository = new WorkbenchGitRepository(repoRoot);
  await write(repoRoot, "selected.txt", "must reject signature\n");
  const owner = await WorkbenchThreadGit.create({ cwd: repoRoot, storageRootPath, threadId: "signed-thread" });
  await owner.add(["selected.txt"]);

  await assert.rejects(owner.commit("reject signature", state.signedCommit), /signed commits are not supported/u);

  assert.equal(await repository.currentHead(), state.signedCommit);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "must reject signature\n");
});

test("thread-owned Git operations", { concurrency: 4 }, async (context) => {
  await Promise.all(threadGitCases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
