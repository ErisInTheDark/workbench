/* No production exports. Tests protect linear amendments, unchanged trees, conflict rollback, scoped snapshots and commit remapping. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import WorkbenchThreadGitSelectionStore from "../../../database/git/WorkbenchThreadGitSelectionStore";
import WorkbenchThreadIdentityRepository from "../../../database/thread-identity/WorkbenchThreadIdentityRepository";
import { installWorkbenchDatabaseSchema } from "../../../database/workbench-database-schema";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

import GitCheckpointStore from "./GitCheckpointStore";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import GitObjectReadSession from "./GitObjectReadSession";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchThreadGit from "./WorkbenchThreadGit";
import {
  HISTORY_ARC_READY_FIXTURE,
  HISTORY_CONFLICT_READY_FIXTURE,
  HISTORY_LINEAR_FIXTURE,
  HISTORY_ROOT_READY_FIXTURE,
} from "./WorkbenchGitTestFixtures";
import { type ArcOutcome, outcomeRef } from "workbench-shared/workbench/git/git-arc-storage";

const execFileAsync = promisify(execFile);
const fixtureCache = new GitTestFixtureCache();
const historyCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];

function historyTest(name: string, run: (context: TestContext) => Promise<void>) {
  historyCases.push({ name, run: context => GitObjectReadSession.run(() => run(context)) });
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
  const repositoryOwner = await WorkbenchGitRepository.open(root);
  const target = (await repositoryOwner.readCommitAt("HEAD^"))!.commit;
  return { repositoryOwner, root, selectionStore: selectionStore(context, root, storageRootPath), target };
}

function selectionStore(context: TestContext, root: string, storage: string) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(() => database.close());
  new WorkbenchThreadIdentityRepository(database).observe({
    native: { harness: "codex", nativeLocation: root, nativeThreadId: NativeThreadIdSchema.parse("thread-one") },
    projectId: testProjectIds.fixture, projectRoot: root,
    title: "thread-one", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const store = new WorkbenchThreadGitSelectionStore(database, storage);
  return { executeThreadGitSelection: async (command: Parameters<typeof store.execute>[0]) => store.execute(command) };
}

async function arcRepository(context: TestContext) {
  const { dispose, root, state } = await fixtureCache.copy(HISTORY_ARC_READY_FIXTURE);
  context.after(dispose);
  const repository = await WorkbenchGitRepository.open(root);
  return { repository, root, state };
}

async function checkContentAmend({ repositoryOwner, root, selectionStore, target }: Awaited<ReturnType<typeof repository>>) {
  const oldHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await write(root, "selected.txt", "amended\n");
  await write(root, "later.txt", "staged but unrelated\n");
  await git(root, ["add", "later.txt"]);
  const beforeSelected = await fs.readFile(path.join(root, "selected.txt"));
  const beforeLater = await fs.readFile(path.join(root, "later.txt"));
  const owner = await WorkbenchThreadGit.create({ cwd: root, selectionStore, threadId: "thread-one" });
  await owner.add(["selected.txt"]);

  const result = await owner.commit("amended target", target);

  assert.notEqual(result.commit, oldHead);
  assert.equal(result.rewrittenCommitCount, 2);
  assert.equal(await repositoryOwner.readBlob(`${result.amendedCommit}:selected.txt`), "amended\n");
  assert.equal(await repositoryOwner.readBlob("HEAD:selected.txt"), "amended\n");
  assert.equal((await repositoryOwner.readCommit("HEAD")).message.trim(), "descendant");
  assert.deepEqual(await fs.readFile(path.join(root, "selected.txt")), beforeSelected);
  assert.deepEqual(await fs.readFile(path.join(root, "later.txt")), beforeLater);
  assert.equal((await git(root, ["diff", "--cached", "--name-only"])).trim(), "later.txt");
  return result.amendedCommit;
}

async function checkMessageAmend({ repositoryOwner, root, target }: Awaited<ReturnType<typeof repository>>) {
  await write(root, "selected.txt", "unstaged and unrelated\n");
  await write(root, "later.txt", "staged and unrelated\n");
  await git(root, ["add", "later.txt"]);
  const worktreeBefore = await git(root, ["diff", "--binary"]);
  const indexBefore = await git(root, ["diff", "--cached", "--binary"]);
  const oldHead = await repositoryOwner.currentHead();
  const before = await repositoryOwner.readCommits([target, oldHead]);
  const controller = new WorkbenchGitCheckpointController();
  await controller.createPlan({
    cwd: root, harness: "codex", threadId: "message-plan", intentName: "selected snapshot",
    paths: ["selected.txt"], adoptPaths: ["selected.txt"],
  });

  const result = await new WorkbenchGitHistoryRewriter(repositoryOwner).amend({
    message: "replacement message",
    messageOnly: true,
    paths: [],
    target,
  });

  assert.equal((await repositoryOwner.readCommit(result.amendedCommit)).message.trim(), "replacement message");
  assert.equal((await repositoryOwner.readCommit("HEAD")).message.trim(), "descendant");
  assert.equal(await git(root, ["diff", "--binary"]), worktreeBefore);
  assert.equal(await git(root, ["diff", "--cached", "--binary"]), indexBefore);
  const after = await repositoryOwner.readCommits([result.amendedCommit, result.commit]);
  assert.equal(after.commits.get(result.amendedCommit)?.tree, before.commits.get(target)?.tree);
  assert.equal(after.commits.get(result.commit)?.tree, before.commits.get(oldHead)?.tree);
  const remappedPlan = await controller.findPlanState({ cwd: root, harness: "codex", threadId: "message-plan" });
  assert.ok(remappedPlan);
  assert.equal(await repositoryOwner.readBlob(`${remappedPlan.checkpointCommit}:selected.txt`), "unstaged and unrelated\n");
  assert.equal(await repositoryOwner.readBlob(`${remappedPlan.checkpointCommit}:later.txt`), await repositoryOwner.readBlob("HEAD:later.txt"));
}

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
  const owner = await WorkbenchThreadGit.create({ cwd: root, selectionStore: selectionStore(context, root, storage), threadId: "thread-one" });
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
  const store = new GitCheckpointStore(repository);
  const { firstProposalId, oldHead, originalParent, siblingPlanCheckpoint, originalDescendant } = state;
  const originalDescendantPatch = await git(root, ["show", "--format=", "--binary", "--no-renames", originalDescendant]);

  const amendment = { proposalId: state.amendmentProposalId, sourceCheckpoint: state.amendmentSourceCheckpoint };
  const amendmentPreview = (await store.readProposal("codex", "amend-thread", amendment.proposalId)).metadata;
  assert.equal(amendmentPreview.title, "Original title");
  assert.equal(amendmentPreview.description, "Original description");
  const lossStore = new GitArcClaimLossStore(repository);
  const lossBefore = await lossStore.read({ harness: "codex", threadId: "amend-thread" });
  assert.ok(lossBefore);
  assert.equal(lossBefore.head, oldHead);
  const second = { proposalId: state.secondProposalId };
  const secondBefore = await controller.getProposal({
    cwd: root,
    harness: "codex",
    includeNewer: false,
    proposalId: second.proposalId,
    threadId: "amend-thread",
  });
  assert.equal(secondBefore.status, "proposed");
  assert.equal(secondBefore.amendTargetSha, oldHead);
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
  const lossAfter = await lossStore.read({ harness: "codex", threadId: "amend-thread" });
  assert.ok(lossAfter);
  assert.equal(lossAfter.head, amended.committedSha);
  assert.equal(lossAfter.tree, lossBefore.tree);
  assert.equal(
    (await repository.classifyHeadMovement(lossAfter.head, lossAfter.paths, lossAfter.commit)).kind,
    "fast-forward",
  );
  assert.equal(
    await fs.readFile(path.join(root, "selected.txt"), "utf8"),
    "first proposal\nfirst amendment\nsecond amendment\n",
  );
  const firstRewrittenDescendant = await repository.currentHead();
  assert.equal(
    await git(root, ["show", "--format=", "--binary", "--no-renames", firstRewrittenDescendant]),
    originalDescendantPatch,
  );
  const superseded = (await store.readProposal("codex", "amend-thread", firstProposalId)).metadata;
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.committedSha, amended.committedSha);
  assert.equal(superseded.supersededByProposalId, amendment.proposalId);
  assert.equal(superseded.supersededBySha, amended.committedSha);
  assert.equal(await repository.readRef(outcomeRef("codex", "amend-thread", amendment.sourceCheckpoint)), null);
  const outcomeNamespace = "refs/worktree/agents/codex/amend-thread/arc-outcomes";
  const outcomeRefs = await repository.listRefs(outcomeNamespace);
  const outcomeBlobs = await repository.readBlobs(outcomeRefs);
  const amendedOutcomes = outcomeRefs.flatMap(ref => {
    const error = outcomeBlobs.errors.get(ref);
    if (error) throw new Error(error);
    const blob = outcomeBlobs.blobs.get(ref);
    return blob ? [{ outcome: JSON.parse(blob.contents) as ArcOutcome, ref }] : [];
  }).filter(({ outcome }) => outcome.proposalId === amendment.proposalId);
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
  assert.deepEqual(siblingAfterFirst.claimedPaths, ["later.txt"]);
  assert.equal(
    await repository.readBlob(`${siblingAfterFirst.checkpointCommit}:selected.txt`),
    "first proposal\nfirst amendment\n",
  );

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

  const pendingPlan = await controller.createPlan({
    cwd: root, harness: "codex", intentName: "next work", paths: ["selected.txt"], threadId: "amend-thread",
  });
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
  const retainedPlan = await controller.findPlanState({ cwd: root, harness: "codex", threadId: "amend-thread" });
  assert.ok(retainedPlan);
  assert.equal(retainedPlan.intentName, pendingPlan.intentName);
  assert.deepEqual(retainedPlan.scopePaths, pendingPlan.scopePaths);
  assert.deepEqual(await repository.listChangedPaths(pendingPlan.checkpointCommit, retainedPlan.checkpointCommit, pendingPlan.scopePaths), []);
  assert.notEqual(secondCommitted.committedSha, amended.committedSha);
  assert.equal(
    await repository.readBlob(`${secondCommitted.committedSha}:selected.txt`),
    "first proposal\nfirst amendment\nsecond amendment\n",
  );
  const finalDescendant = await repository.currentHead();
  assert.equal((await repository.readCommit(finalDescendant)).message.trim(), "later descendant");
  assert.equal(
    await git(root, ["show", "--format=", "--binary", "--no-renames", finalDescendant]),
    originalDescendantPatch,
  );
  const firstAfterSecond = (await store.readProposal("codex", "amend-thread", amendment.proposalId)).metadata;
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

async function checkIndexLock(context: TestContext, { repositoryOwner: gitRepository, root, target }: Awaited<ReturnType<typeof repository>>) {
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
  return committed.amendedCommit;
}

historyTest("linear amendments preserve state through lock retry, content and message changes", async (context) => {
  const fixture = await repository(context);
  await context.test("index locks leave targeted amendments unpublished and retryable", async () => {
    fixture.target = await checkIndexLock(context, fixture);
  });
  await context.test("content amendments preserve worktree files and unrelated staged entries", async () => {
    fixture.target = await checkContentAmend(fixture);
  });
  await context.test("message-only amendments preserve trees, worktree, index and scoped snapshots", () => checkMessageAmend(fixture));
});

historyTest("root amendments preserve parentless proposal history and accepted receipts", async (context) => {
  const fixture = await fixtureCache.copy(HISTORY_ROOT_READY_FIXTURE);
  context.after(fixture.dispose);
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: fixture.root, threadId: "initial" };
  const accepted = fixture.state;
  assert.ok(accepted.committedSha);
  await write(fixture.root, "one.txt", "amended\n");
  const amendment = await controller.createProposal({
    ...identity, amend: true, title: "amended", description: "", freshTitle: "fresh",
  });
  const amended = await controller.commitProposal({
    ...identity, proposalId: amendment.proposalId, title: "amended", description: "", includeNewer: false,
  });
  assert.ok(amended.committedSha);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  assert.deepEqual((await repository.readCommit(amended.committedSha)).parents, []);
  assert.equal(await repository.readBlob("HEAD:one.txt"), "amended\n");
  const prior = (await new GitCheckpointStore(repository).readProposal("codex", identity.threadId, accepted.proposalId)).metadata;
  assert.notEqual(prior.committedSha, accepted.committedSha);
  assert.equal(prior.committedSha, amended.committedSha);
});

test("Git history rewrites", { concurrency: 3 }, async (context) => {
  await Promise.all(historyCases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
