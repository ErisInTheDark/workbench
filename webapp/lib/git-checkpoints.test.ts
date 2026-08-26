/*
 * Exports:
 * - No production exports; bounded concurrent Node tests cover full checkpoints, arc claims, proposals, commit isolation, and restore. Keywords: git, checkpoint, arc, proposal, restore, concurrency, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import WorkbenchGitCheckpointController from "./workbench/git/WorkbenchGitCheckpointController";
import GitTestFixtureCache from "./workbench/git/GitTestFixtureCache";
import {
  CHECKPOINT_ADDITIONS_READY_FIXTURE,
  CHECKPOINT_DIRTY_CLAIM_READY_FIXTURE,
  CHECKPOINT_OPERATIONS_BASE_FIXTURE,
  CHECKPOINT_PROPOSAL_READY_FIXTURE,
  CHECKPOINT_REBASE_READY_FIXTURE,
  CHECKPOINT_RELEASE_READY_FIXTURE,
} from "./workbench/git/WorkbenchGitTestFixtures";

const execFileAsync = promisify(execFile);
const checkpointCases: Array<{ name: string; priority: number; run: (context: TestContext) => Promise<void> }> = [];
const controller = new WorkbenchGitCheckpointController();
const fixtureCache = new GitTestFixtureCache();
const createGitPlan = controller.createPlan.bind(controller);
const addToGitPlan = controller.addToPlan.bind(controller);
const startGitArc = controller.startArc.bind(controller);
const continueGitArc = controller.continueArc.bind(controller);
const addToGitArc = controller.addToArc.bind(controller);
const removeFromGitArc = controller.removeFromArc.bind(controller);
const releaseGitArc = controller.releaseArc.bind(controller);
const compareGitCheckpoint = controller.compare.bind(controller);
const diffGitCheckpoint = controller.diff.bind(controller);
const createGitCheckpointProposal = controller.createProposal.bind(controller);
const readGitCheckpointProposal = controller.getProposal.bind(controller);
const commitGitCheckpointProposal = controller.commitProposal.bind(controller);
const restoreGitCheckpoint = async ({
  checkpointCommit,
  confirmRestore,
  cwd,
  threadId,
}: {
  checkpointCommit: string;
  confirmRestore: boolean;
  cwd: string;
  threadId: string;
}) => await controller.restore({ checkpointCommit, confirmRestore, cwd, threadId });
const restoreGitCheckpointPaths = async ({
  checkpointCommit,
  cwd,
  filePaths,
  threadId,
}: {
  checkpointCommit: string;
  cwd: string;
  filePaths: string[];
  threadId: string;
}) => await controller.restore({ checkpointCommit, cwd, paths: filePaths, threadId });
function checkpointTest(name: string, priority: number, run: (context: TestContext) => Promise<void>) {
  checkpointCases.push({ name, priority, run });
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
  const fixture = await fixtureCache.copy(CHECKPOINT_OPERATIONS_BASE_FIXTURE);
  context.after(fixture.dispose);
  return { repoRoot: fixture.root, testRoot: fixture.temporaryRoot };
}

checkpointTest("restores only selected checkpoint paths while preserving the ordinary index and unrelated worktree changes", 5, async (context) => {
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

  const historical = await createGitPlan({
    cwd: repoRoot,
    intentName: "Historical full restore",
    paths: ["deleted.txt"],
    threadId: "thread-one",
  });
  await startGitArc({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  await write(repoRoot, "selected.txt", "active claimed work\n");
  await assert.rejects(controller.restore({
    checkpointCommit: historical.checkpointCommit,
    confirmRestore: true,
    cwd: repoRoot,
    threadId: "thread-one",
  }), /owns a different active Git arc/u);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "active claimed work\n");
  const released = await controller.restore({
    checkpointCommit: checkpoint.checkpointCommit,
    confirmRestore: true,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(released.restoredPaths, ["selected.txt"]);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "selected checkpoint\n");
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "unrelated worktree\n");
  assert.equal(await git(repoRoot, ["show", ":unrelated.txt"]), "unrelated staged\n");
  assert.equal(await controller.findActiveClaim({ cwd: repoRoot, threadId: "thread-one" }), null);
  await assert.rejects(controller.continueArc({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  }), /restored or unclaimed without a commit/u);

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

checkpointTest("plans accept dirty claimed paths, reject mystery dirt, and snapshot the full worktree", 3, async (context) => {
  const fixture = await fixtureCache.copy(CHECKPOINT_DIRTY_CLAIM_READY_FIXTURE);
  context.after(fixture.dispose);
  const repoRoot = fixture.root;
  const future = await createGitPlan({
    cwd: repoRoot,
    intentName: "Update selected",
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(future.scopePaths, ["selected.txt"]);

  await git(repoRoot, ["restore", "--", "selected.txt"]);
  await removeFromGitArc({ cwd: repoRoot, paths: ["selected.txt"], threadId: "owner-thread" });
  await write(repoRoot, "unrelated.txt", "unrelated dirty at checkpoint\n");
  await write(repoRoot, "untracked-at-checkpoint.txt", "untracked checkpoint content\n");
  const checkpoint = await createGitPlan({
    cwd: repoRoot,
    intentName: "Update selected",
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(checkpoint.preservedDriftPaths, ["selected.txt"]);
  assert.equal(checkpoint.preservedDriftPathCount, 1);
  await assert.rejects(startGitArc({
    checkpointCommit: checkpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  }), /stored plan no longer matches[\s\S]*selected\.txt/u);
  const refreshedCheckpoint = await addToGitPlan({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(refreshedCheckpoint.preservedDriftPaths, []);
  assert.equal(refreshedCheckpoint.preservedDriftPathCount, 0);
  const started = await startGitArc({
    checkpointCommit: refreshedCheckpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  await addToGitArc({
    cwd: repoRoot,
    paths: ["planned-new.tsx"],
    threadId: "thread-one",
  });
  assert.equal(await git(repoRoot, ["show", `${refreshedCheckpoint.checkpointCommit}:unrelated.txt`]), "unrelated dirty at checkpoint\n");
  assert.equal(
    await git(repoRoot, ["show", `${refreshedCheckpoint.checkpointCommit}:untracked-at-checkpoint.txt`]),
    "untracked checkpoint content\n",
  );
  await write(repoRoot, "selected.txt", "implementation\n");
  await write(repoRoot, "unrelated.txt", "later unrelated change\n");
  const arcComparison = await compareGitCheckpoint({
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.deepEqual(arcComparison.changes.map((change) => change.path), ["selected.txt"]);
  const explicitPlanComparison = await compareGitCheckpoint({
    checkpointCommit: refreshedCheckpoint.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.equal(explicitPlanComparison.checkpointCommit, refreshedCheckpoint.checkpointCommit);
  assert.deepEqual(explicitPlanComparison.changes.map((change) => change.path), ["selected.txt"]);
  await assert.rejects(compareGitCheckpoint({
    checkpointCommit: started.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  }));
  const comparison = await compareGitCheckpoint({
    cwd: repoRoot,
    paths: ["selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["selected.txt", "unrelated.txt"]);
  const implicitDiff = await diffGitCheckpoint({
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.match(implicitDiff.diff, /implementation/u);
  const proposal = await createGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "thread-one",
    title: "Commit selected work",
  });
  assert.deepEqual(proposal.paths, ["selected.txt"]);
  assert.equal("changes" in proposal, false);
});

checkpointTest("plans reject dirty unclaimed paths unless adoption is explicit", 1, async (context) => {
  const { repoRoot } = await createRepository(context);
  await write(repoRoot, "selected.txt", "mystery dirt\n");
  await assert.rejects(createGitPlan({
    cwd: repoRoot, intentName: "reject mystery dirt", paths: ["selected.txt"], threadId: "mystery",
  }), /clean against HEAD|adopt/u);
});

checkpointTest("releasing a proposed arc makes the proposal unavailable", 2, async (context) => {
  const fixture = await fixtureCache.copy(CHECKPOINT_RELEASE_READY_FIXTURE);
  context.after(fixture.dispose);
  const repoRoot = fixture.root;
  const restoreThreadId = "thread-release-restore";
  await controller.restore({
    checkpointCommit: fixture.state.restorePlanCheckpoint,
    confirmRestore: true,
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: restoreThreadId,
  });
  assert.equal(await controller.findActiveClaim({ cwd: repoRoot, threadId: restoreThreadId }), null);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), "selected checkpoint\n");
  const unavailableAfterRestore = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: fixture.state.restoredProposalId,
    threadId: restoreThreadId,
  });
  assert.equal(unavailableAfterRestore.status, "unavailable");
  assert.match(unavailableAfterRestore.unavailableReason ?? "", /restored and unclaimed/u);

  const unclaimThreadId = "thread-release-clean";
  const released = await removeFromGitArc({ cwd: repoRoot, paths: ["literal[1].txt"], threadId: unclaimThreadId });
  assert.deepEqual(released.scopePaths, []);
  assert.equal(await controller.findActiveClaim({ cwd: repoRoot, threadId: unclaimThreadId }), null);
  const unavailableAfterUnclaim = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: fixture.state.unclaimedProposalId,
    threadId: unclaimThreadId,
  });
  assert.equal(unavailableAfterUnclaim.status, "unavailable");
  assert.match(unavailableAfterUnclaim.unavailableReason ?? "", /unclaimed without committing/u);

  const cleanPlan = await createGitPlan({
    cwd: repoRoot,
    intentName: "Release clean claims",
    paths: ["selected.txt"],
    threadId: "release-thread",
  });
  await startGitArc({ checkpointCommit: cleanPlan.checkpointCommit, cwd: repoRoot, threadId: "release-thread" });
  const cleanRelease = await releaseGitArc({ cwd: repoRoot, disown: false, threadId: "release-thread" });
  assert.deepEqual(cleanRelease.releasedClaims, ["selected.txt"]);
  assert.deepEqual(cleanRelease.scopePaths, []);
  assert.equal((await controller.findLifecycleState({ cwd: repoRoot, threadId: "release-thread" }))?.phase, "resolved");

  const dirtyPlan = await createGitPlan({
    cwd: repoRoot,
    intentName: "Release dirty claims",
    paths: ["selected.txt"],
    threadId: "release-thread",
  });
  const dirtyArc = await startGitArc({ checkpointCommit: dirtyPlan.checkpointCommit, cwd: repoRoot, threadId: "release-thread" });
  await write(repoRoot, "selected.txt", "staged dirty release\n");
  await git(repoRoot, ["add", "--", "selected.txt"]);
  await write(repoRoot, "selected.txt", "worktree dirty release\n");
  const proposal = await createGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    paths: ["selected.txt"],
    threadId: "release-thread",
    title: "Keep dirty work",
  });
  const futurePlan = await createGitPlan({
    cwd: repoRoot,
    intentName: "Keep the inactive plan",
    paths: ["selected.txt"],
    threadId: "release-thread",
  });
  const statusBefore = await git(repoRoot, ["status", "--short", "--", "selected.txt"]);
  const indexBefore = await git(repoRoot, ["show", ":selected.txt"]);
  const worktreeBefore = await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8");

  await assert.rejects(
    releaseGitArc({ cwd: repoRoot, disown: false, threadId: "release-thread" }),
    /Arc release paths must be clean against HEAD: selected\.txt/u,
  );
  assert.equal((await controller.findPlanState({ cwd: repoRoot, threadId: "release-thread" }))?.checkpointCommit, futurePlan.checkpointCommit);

  const disowned = await releaseGitArc({ cwd: repoRoot, disown: true, threadId: "release-thread" });
  assert.deepEqual(disowned.releasedClaims, ["selected.txt"]);
  assert.equal((await controller.findPlanState({ cwd: repoRoot, threadId: "release-thread" }))?.checkpointCommit, futurePlan.checkpointCommit);
  const releasedLifecycle = await controller.findLifecycleState({ cwd: repoRoot, threadId: "release-thread" });
  assert.equal(releasedLifecycle?.checkpointCommit, dirtyArc.checkpointCommit);
  assert.deepEqual(releasedLifecycle?.claimedPaths, []);
  assert.equal(releasedLifecycle?.phase, "resolved");
  assert.equal(await git(repoRoot, ["status", "--short", "--", "selected.txt"]), statusBefore);
  assert.equal(await git(repoRoot, ["show", ":selected.txt"]), indexBefore);
  assert.equal(await fs.readFile(path.join(repoRoot, "selected.txt"), "utf8"), worktreeBefore);
  const unavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "release-thread",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.unavailableReason ?? "", /released without committing/u);
});

checkpointTest("arc additions preserve claimed baselines while advancing unclaimed paths to current HEAD", 6, async (context) => {
  const fixture = await fixtureCache.copy(CHECKPOINT_ADDITIONS_READY_FIXTURE);
  context.after(fixture.dispose);
  const repoRoot = fixture.root;
  const { originalCheckpoint, originalParent, originalTree, releasedScopePaths } = fixture.state;
  assert.deepEqual(releasedScopePaths, []);
  await write(repoRoot, "selected.txt", "first implementation\n");
  await assert.rejects(addToGitArc({
    cwd: repoRoot,
    paths: [],
    threadId: "thread-one",
  }), /requires at least one additional clean path/u);
  const continuation = await continueGitArc({
    checkpointCommit: originalCheckpoint,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.deepEqual(continuation.scopePaths, ["selected.txt"]);
  assert.equal(
    await git(repoRoot, ["show", `${continuation.checkpointCommit}:selected.txt`]),
    await git(repoRoot, ["show", `${originalCheckpoint}:selected.txt`]),
  );
  assert.equal(
    (await git(repoRoot, ["ls-tree", "-r", "--name-only", continuation.checkpointCommit]))
      .split(/\r?\n/u)
      .includes("later-claim.txt"),
    false,
  );
  assert.equal((await git(repoRoot, ["rev-parse", `${continuation.checkpointCommit}^`])).trim(), originalParent);

  await write(repoRoot, "head-only.txt", "compatible committed change\n");
  await git(repoRoot, ["add", "--", "head-only.txt", "later-claim.txt"]);
  await git(repoRoot, ["commit", "-m", "advance unrelated head"]);
  const compatibleHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const compatibleContinuation = await continueGitArc({
    checkpointCommit: continuation.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  });
  assert.equal(await git(repoRoot, ["show", `${compatibleContinuation.checkpointCommit}:head-only.txt`]), "compatible committed change\n");
  const amended = await addToGitArc({
    cwd: repoRoot,
    paths: ["literal[1].txt", "planned-new.tsx", "later-claim.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(amended.scopePaths, ["later-claim.txt", "literal[1].txt", "planned-new.tsx", "selected.txt", "unrelated.txt"]);
  assert.notEqual((await git(repoRoot, ["rev-parse", `${amended.checkpointCommit}^{tree}`])).trim(), originalTree);
  assert.equal((await git(repoRoot, ["rev-parse", `${compatibleContinuation.checkpointCommit}^`])).trim(), compatibleHead);
  assert.equal((await git(repoRoot, ["rev-parse", `${amended.checkpointCommit}^`])).trim(), compatibleHead);
  await write(repoRoot, "planned-new.tsx", "export default function PlannedNew() {}\n");
  await write(repoRoot, "later-claim.txt", "implementation after claim\n");
  const comparison = await compareGitCheckpoint({
    cwd: repoRoot,
    paths: ["planned-new.tsx", "selected.txt", "unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(comparison.changes.map((change) => change.path), ["planned-new.tsx", "selected.txt"]);
  assert.equal(comparison.changes.find((change) => change.path === "planned-new.tsx")?.kind.type, "add");

  await write(repoRoot, "unrelated.txt", "dirty before remove\n");
  await assert.rejects(removeFromGitArc({
    cwd: repoRoot,
    paths: ["unrelated.txt"],
    threadId: "thread-one",
  }), /Arc remove paths must be clean against HEAD: unrelated\.txt/u);
  await git(repoRoot, ["restore", "--", "unrelated.txt"]);
  const reduced = await removeFromGitArc({
    cwd: repoRoot,
    paths: ["unrelated.txt"],
    threadId: "thread-one",
  });
  assert.deepEqual(reduced.scopePaths, ["later-claim.txt", "literal[1].txt", "planned-new.tsx", "selected.txt"]);
  assert.equal(await git(repoRoot, ["show", `${reduced.checkpointCommit}:head-only.txt`]), "compatible committed change\n");
  assert.equal((await git(repoRoot, ["rev-parse", `${reduced.checkpointCommit}^`])).trim(), compatibleHead);
  assert.equal(await fs.readFile(path.join(repoRoot, "unrelated.txt"), "utf8"), "unrelated checkpoint\n");
  await assert.rejects(removeFromGitArc({
    cwd: repoRoot,
    paths: ["literal1.txt"],
    threadId: "thread-one",
  }), /must exactly match claimed entries: literal1\.txt/u);

  await assert.rejects(addToGitArc({
    cwd: repoRoot,
    paths: ["selected.txt"],
    threadId: "thread-one",
  }), /already covered/u);

  await write(repoRoot, "deleted.txt", "dirty amendment path\n");
  await assert.rejects(addToGitArc({
    cwd: repoRoot,
    paths: ["deleted.txt"],
    threadId: "thread-one",
  }), /Plan paths must be clean against HEAD: deleted\.txt/u);
  await git(repoRoot, ["restore", "--", "deleted.txt"]);

  await write(repoRoot, "literal1.txt", "committed after checkpoint\n");
  await git(repoRoot, ["add", "--", "literal1.txt"]);
  await git(repoRoot, ["commit", "-m", "change later planned path"]);
  const laterBaseline = await addToGitArc({
    cwd: repoRoot,
    paths: ["literal1.txt"],
    threadId: "thread-one",
  });
  assert.equal(await git(repoRoot, ["show", `${laterBaseline.checkpointCommit}:literal1.txt`]), "committed after checkpoint\n");

  await git(repoRoot, ["add", "--", "selected.txt"]);
  await git(repoRoot, ["commit", "-m", "commit claimed path"]);
  await assert.rejects(continueGitArc({
    checkpointCommit: laterBaseline.checkpointCommit,
    cwd: repoRoot,
    threadId: "thread-one",
  }), /Claimed paths no longer match the arc baseline.*selected\.txt/u);
  await assert.rejects(removeFromGitArc({
    cwd: repoRoot,
    paths: ["literal[1].txt"],
    threadId: "thread-one",
  }), /Retained paths no longer match the arc baseline.*selected\.txt/u);
});

checkpointTest("arc continuation retires pending proposals before extending or revising implementation", 4, async (context) => {
  const { repoRoot } = await createRepository(context);
  const threadId = "thread-proposal-correction";
  const original = await createGitPlan({
    cwd: repoRoot,
    intentName: "Correct proposed work",
    paths: ["selected.txt"],
    threadId,
  });
  await startGitArc({ checkpointCommit: original.checkpointCommit, cwd: repoRoot, threadId });
  await write(repoRoot, "selected.txt", "first proposed version\n");
  const firstProposal = await createGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    threadId,
    title: "First proposal",
  });

  const extended = await addToGitArc({ cwd: repoRoot, paths: ["unrelated.txt"], threadId });
  assert.deepEqual(extended.scopePaths, ["selected.txt", "unrelated.txt"]);
  assert.notEqual(extended.checkpointCommit, original.checkpointCommit);
  const firstUnavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: firstProposal.proposalId,
    threadId,
  });
  assert.equal(firstUnavailable.status, "unavailable");
  assert.match(firstUnavailable.unavailableReason ?? "", /Implementation continued/u);
  assert.equal((await controller.findActiveClaim({ cwd: repoRoot, threadId }))?.proposalId, null);
  const followed = await controller.continueArc({
    checkpointCommit: original.checkpointCommit,
    cwd: repoRoot,
    threadId,
  });
  assert.equal(followed.checkpointCommit, extended.checkpointCommit);

  await write(repoRoot, "unrelated.txt", "follow-up implementation\n");
  const secondProposal = await createGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    threadId,
    title: "Second proposal",
  });
  const revised = await continueGitArc({ checkpointCommit: extended.checkpointCommit, cwd: repoRoot, threadId });
  assert.deepEqual(revised.scopePaths, extended.scopePaths);
  assert.notEqual(revised.checkpointCommit, extended.checkpointCommit);
  const secondUnavailable = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: secondProposal.proposalId,
    threadId,
  });
  assert.equal(secondUnavailable.status, "unavailable");
  assert.match(secondUnavailable.unavailableReason ?? "", /Implementation continued/u);
  const active = await controller.findActiveClaim({ cwd: repoRoot, threadId });
  assert.equal(active?.checkpointCommit, revised.checkpointCommit);
  assert.equal(active?.proposalId, null);
});

checkpointTest("proposal file sets stay frozen while newer selected edits remain optional", 8, async (context) => {
  const fixture = await fixtureCache.copy(CHECKPOINT_PROPOSAL_READY_FIXTURE);
  context.after(fixture.dispose);
  const repoRoot = fixture.root;
  const frozenThreadId = "thread-frozen";
  const newerThreadId = "thread-newer";
  const cleanThreadId = "thread-clean";
  await assert.rejects(createGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    paths: ["outside.txt"],
    threadId: frozenThreadId,
    title: "Reject outside path",
  }), /must stay within the arc's claimed set: outside\.txt/u);
  const superseded = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: fixture.state.originalProposalId,
    threadId: frozenThreadId,
  });
  assert.equal(superseded.status, "proposed");
  assert.equal(superseded.supersededByProposalId, null);
  assert.equal(
    (await controller.findActiveClaim({ cwd: repoRoot, threadId: frozenThreadId }))?.proposalId,
    fixture.state.currentProposalId,
  );
  await write(repoRoot, "selected.txt", "newer version\n");
  await write(repoRoot, "deleted.txt", "newer selected version\n");
  await write(repoRoot, "unrelated.txt", "unrelated staged\n");
  await git(repoRoot, ["add", "--", "unrelated.txt"]);
  await write(repoRoot, "unrelated.txt", "unrelated worktree\n");
  const newerPreview = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: true,
    proposalId: fixture.state.currentProposalId,
    threadId: frozenThreadId,
  });
  assert.equal(newerPreview.includeNewerAvailable, true);
  assert.match(newerPreview.changes[0]?.diff ?? "", /newer version/u);
  assert.deepEqual(newerPreview.paths, ["selected.txt"]);

  const committed = await commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "Frozen proposal",
    includeNewer: false,
    proposalId: fixture.state.currentProposalId,
    threadId: frozenThreadId,
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
    proposalId: fixture.state.newerProposalId,
    threadId: newerThreadId,
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
    proposalId: fixture.state.cleanProposalId,
    threadId: cleanThreadId,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.unavailableReason ?? "", /no longer has working-tree changes/u);
});

checkpointTest("proposals rebase across compatible commits and reject selected or incompatible history", 7, async (context) => {
  const fixture = await fixtureCache.copy(CHECKPOINT_REBASE_READY_FIXTURE);
  context.after(fixture.dispose);
  const repoRoot = fixture.root;
  const { compatibleProposalId, conflictProposalId, incompatibleProposalId, rootCommit } = fixture.state;
  const compatibleThreadId = "thread-compatible";
  const conflictThreadId = "thread-conflict";
  const incompatibleThreadId = "thread-incompatible";
  await write(repoRoot, "head-moved.txt", "new head\n");
  await git(repoRoot, ["add", "--", "head-moved.txt"]);
  await git(repoRoot, ["commit", "-m", "move head"]);
  const rebasedHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const rebased = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: compatibleProposalId,
    threadId: compatibleThreadId,
  });
  assert.equal(rebased.status, "proposed");
  assert.equal(rebased.baseCommit, rebasedHead);
  assert.deepEqual(rebased.changes.map((change) => change.path), ["selected.txt"]);

  const committed = await commitGitCheckpointProposal({
    cwd: repoRoot,
    description: "",
    includeNewer: false,
    proposalId: compatibleProposalId,
    threadId: compatibleThreadId,
    title: "Commit selected",
  });
  assert.equal(committed.status, "committed");
  assert.equal((await git(repoRoot, ["rev-parse", "HEAD^"])).trim(), rebasedHead);
  assert.equal(await git(repoRoot, ["show", "HEAD:selected.txt"]), "proposed version\n");

  await write(repoRoot, "deleted.txt", "committed elsewhere\n");
  await git(repoRoot, ["add", "--", "deleted.txt"]);
  await git(repoRoot, ["commit", "-m", "commit selected elsewhere"]);
  const conflicted = await readGitCheckpointProposal({
    cwd: repoRoot,
    includeNewer: false,
    proposalId: conflictProposalId,
    threadId: conflictThreadId,
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
    proposalId: incompatibleProposalId,
    threadId: incompatibleThreadId,
  });
  assert.equal(incompatible.status, "unavailable");
  assert.match(incompatible.unavailableReason ?? "", /HEAD moved incompatibly/u);
});

test("Git checkpoint controller operations", { concurrency: true }, async (context) => {
  const scheduledCases = [...checkpointCases].sort((left, right) => right.priority - left.priority);
  await Promise.all(scheduledCases.map(async ({ name, run }) => (
    await context.test(name, { concurrency: true }, run)
  )));
});
