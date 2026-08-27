/*
 * Exports:
 * - No production exports; bounded concurrent regression wards cover linear plumbing amendments, conflict rollback, and checkpoint SHA remapping. Keywords: git, amend, history, arc, concurrency, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import GitCheckpointStore from "./GitCheckpointStore";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchThreadGit from "./WorkbenchThreadGit";
import {
  HISTORY_ARC_READY_FIXTURE,
  HISTORY_CONFLICT_READY_FIXTURE,
  HISTORY_LINEAR_FIXTURE,
} from "./WorkbenchGitTestFixtures";
import { type ArcOutcome, outcomeRef } from "./git-arc-storage";

const execFileAsync = promisify(execFile);
const fixtureCache = new GitTestFixtureCache();
const historyCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];

function historyTest(name: string, run: (context: TestContext) => Promise<void>) {
  historyCases.push({ name, run });
}

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
}

async function write(root: string, file: string, contents: string) {
  await fs.writeFile(path.join(root, file), contents, "utf8");
}

async function repository(context: TestContext) {
  const { dispose, root, storageRootPath } = await fixtureCache.copy(HISTORY_LINEAR_FIXTURE);
  context.after(dispose);
  const target = (await git(root, ["rev-parse", "HEAD^"])).trim();
  return { root, storage: storageRootPath, target };
}

async function arcRepository(context: TestContext) {
  const { dispose, root, state } = await fixtureCache.copy(HISTORY_ARC_READY_FIXTURE);
  context.after(dispose);
  const repository = await WorkbenchGitRepository.open(root);
  return { repository, root, state };
}

historyTest("amends an older linear commit without changing worktree files or unrelated staged entries", async (context) => {
  const { root, storage, target } = await repository(context);
  const oldHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await write(root, "selected.txt", "amended\n");
  await write(root, "later.txt", "staged but unrelated\n");
  await git(root, ["add", "later.txt"]);
  const beforeSelected = await fs.readFile(path.join(root, "selected.txt"));
  const beforeLater = await fs.readFile(path.join(root, "later.txt"));
  const owner = await WorkbenchThreadGit.create({ cwd: root, storageRootPath: storage, threadId: "thread-one" });
  await owner.add(["selected.txt"]);

  const result = await owner.commit("amended target", target);

  assert.notEqual(result.commit, oldHead);
  assert.equal(result.rewrittenCommitCount, 2);
  assert.equal(await git(root, ["show", `${result.amendedCommit}:selected.txt`]), "amended\n");
  assert.equal(await git(root, ["show", "HEAD:selected.txt"]), "amended\n");
  assert.equal((await git(root, ["show", "-s", "--format=%s", "HEAD"])).trim(), "descendant");
  assert.deepEqual(await fs.readFile(path.join(root, "selected.txt")), beforeSelected);
  assert.deepEqual(await fs.readFile(path.join(root, "later.txt")), beforeLater);
  assert.equal((await git(root, ["diff", "--cached", "--name-only"])).trim(), "later.txt");
});

historyTest("rewrites only an older commit message without normalizing the worktree or index", async (context) => {
  const { root, target } = await repository(context);
  const repositoryOwner = await WorkbenchGitRepository.open(root);
  await write(root, "selected.txt", "unstaged and unrelated\n");
  await write(root, "later.txt", "staged and unrelated\n");
  await git(root, ["add", "later.txt"]);
  const worktreeBefore = await git(root, ["diff", "--binary"]);
  const indexBefore = await git(root, ["diff", "--cached", "--binary"]);

  const result = await new WorkbenchGitHistoryRewriter(repositoryOwner).amend({
    message: "replacement message",
    messageOnly: true,
    paths: [],
    target,
  });

  assert.equal((await git(root, ["show", "-s", "--format=%s", result.amendedCommit])).trim(), "replacement message");
  assert.equal((await git(root, ["show", "-s", "--format=%s", "HEAD"])).trim(), "descendant");
  assert.equal(await git(root, ["diff", "--binary"]), worktreeBefore);
  assert.equal(await git(root, ["diff", "--cached", "--binary"]), indexBefore);
});

historyTest("a descendant conflict leaves branch, worktree, index, refs, and selection unchanged", async (context) => {
  const { dispose, root, state, storageRootPath: storage } = await fixtureCache.copy(HISTORY_CONFLICT_READY_FIXTURE);
  context.after(dispose);
  const { target } = state;
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await write(root, "selected.txt", "amend edit\n");
  await write(root, "later.txt", "unrelated staged\n");
  await git(root, ["add", "later.txt"]);
  const worktreeBefore = await fs.readFile(path.join(root, "selected.txt"));
  const indexBefore = await git(root, ["diff", "--cached", "--binary"]);
  const refsBefore = await git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/worktree"]);
  const owner = await WorkbenchThreadGit.create({ cwd: root, storageRootPath: storage, threadId: "thread-one" });
  await owner.add(["selected.txt"]);
  await assert.rejects(owner.commit("conflict", target), /conflicts/u);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), head);
  assert.deepEqual(await fs.readFile(path.join(root, "selected.txt")), worktreeBefore);
  assert.equal(await git(root, ["diff", "--cached", "--binary"]), indexBefore);
  assert.equal(await git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/worktree"]), refsBefore);
  await write(root, "later.txt", "retry selection\n");
  assert.deepEqual((await owner.add(["later.txt"])).selectedPaths, ["later.txt", "selected.txt"]);
});

historyTest("arc proposal amend remaps sibling state, completed proposals, and a pending deep amend", async (context) => {
  const { repository, root, state } = await arcRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const { firstProposalId, oldHead, originalParent, siblingPlanCheckpoint } = state;
  await write(root, "descendant.txt", "later descendant\n");
  await git(root, ["add", "descendant.txt"]);
  await git(root, ["commit", "--quiet", "-m", "later descendant"]);
  const originalDescendant = await repository.currentHead();
  const originalDescendantPatch = await git(root, ["show", "--format=", "--binary", "--no-renames", originalDescendant]);

  await write(root, "selected.txt", "first proposal\nfirst amendment\n");
  const amendment = await controller.createProposal({
    amend: true,
    amendProposalId: firstProposalId,
    cwd: root,
    description: "",
    harness: "codex",
    threadId: "amend-thread",
    title: "",
  });
  const amendmentPreview = await controller.getProposal({
    cwd: root,
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "amend-thread",
  });
  assert.equal(amendmentPreview.title, "Original title");
  assert.equal(amendmentPreview.description, "Original description");
  await write(root, "selected.txt", "first proposal\nfirst amendment\nsecond amendment\n");
  const second = await controller.createProposal({
    amend: true,
    amendProposalId: firstProposalId,
    cwd: root,
    description: "",
    harness: "codex",
    threadId: "amend-thread",
    title: "second pending amend",
  });
  const secondBefore = await controller.getProposal({
    cwd: root,
    harness: "codex",
    includeNewer: false,
    proposalId: second.proposalId,
    threadId: "amend-thread",
  });
  assert.equal(secondBefore.status, "proposed");
  assert.equal(secondBefore.amendTargetSha, oldHead);
  const store = new GitCheckpointStore(repository);
  const secondStoredBefore = await store.readProposal("codex", "amend-thread", second.proposalId);

  const amended = await controller.commitProposal({
    cwd: root,
    description: amendmentPreview.description,
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "amend-thread",
    title: amendmentPreview.title,
  });
  assert.notEqual(amended.committedSha, oldHead);
  assert.equal(await repository.resolveParent(amended.committedSha!), originalParent);
  assert.equal(
    await fs.readFile(path.join(root, "selected.txt"), "utf8"),
    "first proposal\nfirst amendment\nsecond amendment\n",
  );
  const firstRewrittenDescendant = await repository.currentHead();
  assert.equal(
    await git(root, ["show", "--format=", "--binary", "--no-renames", firstRewrittenDescendant]),
    originalDescendantPatch,
  );
  const superseded = await controller.getProposal({
    cwd: root,
    harness: "codex",
    includeNewer: false,
    proposalId: firstProposalId,
    threadId: "amend-thread",
  });
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.committedSha, amended.committedSha);
  assert.equal(superseded.supersededByProposalId, amendment.proposalId);
  assert.equal(superseded.supersededBySha, amended.committedSha);
  assert.equal(await repository.readRef(outcomeRef("codex", "amend-thread", amendment.sourceCheckpoint)), null);
  const outcomeNamespace = "refs/worktree/agents/codex/amend-thread/arc-outcomes";
  const amendedOutcomes = (await Promise.all((await repository.listRefs(outcomeNamespace)).map(async (ref) => {
    const blob = await repository.readRef(ref);
    return blob ? { outcome: JSON.parse(await repository.readBlob(blob)) as ArcOutcome, ref } : null;
  }))).filter((entry): entry is { outcome: ArcOutcome; ref: string } => entry !== null)
    .filter(({ outcome }) => outcome.proposalId === amendment.proposalId);
  assert.equal(amendedOutcomes.length, 1);
  const { outcome: amendedOutcome, ref: amendedOutcomeRef } = amendedOutcomes[0]!;
  assert.equal(amendedOutcome.committedSha, amended.committedSha);
  assert.notEqual(amendedOutcome.sourceCheckpoint, amendment.sourceCheckpoint);
  assert.equal(amendedOutcomeRef, outcomeRef("codex", "amend-thread", amendedOutcome.sourceCheckpoint));

  const activeClaimsAfterFirst = await controller.listActiveClaims({ cwd: root });
  const amendAfterFirst = activeClaimsAfterFirst.find(({ threadId }) => threadId === "amend-thread");
  assert.ok(amendAfterFirst);
  assert.equal(amendedOutcome.successorCheckpoint, amendAfterFirst.checkpointCommit);
  const siblingAfterFirst = activeClaimsAfterFirst
    .find(({ threadId }) => threadId === "sibling-thread");
  assert.ok(siblingAfterFirst);
  assert.notEqual(siblingAfterFirst.checkpointCommit, siblingPlanCheckpoint);

  const secondAfterFirst = await controller.getProposal({
    cwd: root,
    harness: "codex",
    includeNewer: false,
    proposalId: second.proposalId,
    threadId: "amend-thread",
  });
  const secondStoredAfterFirst = await store.readProposal("codex", "amend-thread", second.proposalId);
  assert.equal(secondAfterFirst.status, "proposed");
  assert.equal(secondAfterFirst.amendTargetSha, amended.committedSha);
  assert.equal(secondStoredAfterFirst.metadata.liveBaseCommit, firstRewrittenDescendant);
  assert.notEqual(secondStoredAfterFirst.metadata.sourceCheckpoint, secondStoredBefore.metadata.sourceCheckpoint);
  assert.notEqual(secondStoredAfterFirst.proposalCommit, secondStoredBefore.proposalCommit);

  const secondCommitted = await controller.commitProposal({
    cwd: root,
    description: secondAfterFirst.description,
    harness: "codex",
    includeNewer: false,
    proposalId: second.proposalId,
    threadId: "amend-thread",
    title: secondAfterFirst.title,
  });
  assert.ok(secondCommitted.committedSha);
  assert.notEqual(secondCommitted.committedSha, amended.committedSha);
  assert.equal(
    await git(root, ["show", `${secondCommitted.committedSha}:selected.txt`]),
    "first proposal\nfirst amendment\nsecond amendment\n",
  );
  const finalDescendant = await repository.currentHead();
  assert.equal((await git(root, ["show", "-s", "--format=%s", finalDescendant])).trim(), "later descendant");
  assert.equal(
    await git(root, ["show", "--format=", "--binary", "--no-renames", finalDescendant]),
    originalDescendantPatch,
  );
  const firstAfterSecond = await controller.getProposal({
    cwd: root,
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "amend-thread",
  });
  assert.equal(firstAfterSecond.status, "superseded");
  assert.equal(firstAfterSecond.supersededByProposalId, second.proposalId);
  assert.equal(firstAfterSecond.supersededBySha, secondCommitted.committedSha);

  const activeSibling = (await controller.listActiveClaims({ cwd: root }))
    .find(({ threadId }) => threadId === "sibling-thread");
  assert.ok(activeSibling);
  assert.notEqual(activeSibling.checkpointCommit, siblingAfterFirst.checkpointCommit);
  const remappedRefs = await repository.refsPointingAt(
    activeSibling.checkpointCommit,
    "refs/worktree/agents/codex/sibling-thread/checkpoints",
  );
  assert.equal(remappedRefs.length, 1);
  assert.equal(await repository.readRef(remappedRefs[0]!), activeSibling.checkpointCommit);
  const startedSibling = await controller.continueArc({
    checkpointCommit: siblingPlanCheckpoint,
    cwd: root,
    harness: "codex",
    threadId: "sibling-thread",
  });
  assert.notEqual(startedSibling.checkpointCommit, siblingPlanCheckpoint);
  assert.equal(await repository.resolveParent(startedSibling.checkpointCommit), finalDescendant);
  assert.equal(
    (await controller.listActiveClaims({ cwd: root })).some(({ threadId }) => threadId === "amend-thread"),
    false,
  );
});

historyTest("index locks leave targeted amendments unpublished and retryable", async (context) => {
  const { root, target } = await repository(context);
  const gitRepository = await WorkbenchGitRepository.open(root);
  const rewriter = new WorkbenchGitHistoryRewriter(gitRepository);
  await write(root, "selected.txt", "locked amendment\n");
  const headBefore = await gitRepository.currentHead();
  const indexBefore = await git(root, ["diff", "--cached", "--binary"]);
  const lockPath = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index.lock"])).trim());
  await fs.writeFile(lockPath, "locked\n", "utf8");
  context.after(async () => { await fs.rm(lockPath, { force: true }); });

  await assert.rejects(rewriter.amend({
    message: "locked amendment",
    paths: ["selected.txt"],
    target,
  }), /index\.lock/u);
  assert.equal(await gitRepository.currentHead(), headBefore);
  assert.equal(await fs.readFile(path.join(root, "selected.txt"), "utf8"), "locked amendment\n");
  assert.equal(await git(root, ["diff", "--cached", "--binary"]), indexBefore);

  await fs.rm(lockPath, { force: true });
  const committed = await rewriter.amend({
    message: "locked amendment",
    paths: ["selected.txt"],
    target,
  });
  assert.notEqual(committed.commit, headBefore);
  assert.equal(await git(root, ["status", "--short", "--", "selected.txt"]), "");
});

test("Git history rewrites", { concurrency: 3 }, async (context) => {
  await Promise.all(historyCases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
