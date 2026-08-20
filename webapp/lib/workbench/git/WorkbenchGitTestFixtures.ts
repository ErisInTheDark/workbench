/*
 * Exports:
 * - Workbench Git fixture specs: immutable real-Git base graphs and prepared lifecycle scenarios used by amendment/controller tests. Keywords: git, fixture, amend, arc, proposal, remote.
 * - partitionWorkbenchGitTestFiles: separate nested Git, ordinary Git, and non-Git suites while preserving stable group order. Keywords: test runner, scheduling, git, fixture.
 * - prewarmWorkbenchGitTestFixtures: prepare only the cached scenarios required by selected test files before Node starts their timers. Keywords: test runner, cache, prewarm.
 */
import fs from "node:fs/promises";
import path from "node:path";

import GitArcRegistry from "./GitArcRegistry";
import GitTestFixtureCache, { type GitTestFixturePrepareContext, type GitTestFixtureSpec } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  type ArcOutcome,
  outcomeRef,
  proposalMessage,
  type ProposalMetadata,
} from "./git-arc-storage";

const LINEAR_COMMITS = [
  {
    files: {
      "later.txt": "later base\n",
      "ordinary.txt": "ordinary base\n",
      "selected.txt": "selected base\n",
    },
    message: "base",
  },
  { files: { "selected.txt": "selected target\n" }, message: "target" },
  { files: { "later.txt": "later descendant\n" }, message: "descendant" },
];

const CONTROLLER_COMMITS = [{
  files: { "one.txt": "one\n", "two.txt": "two\n" },
  message: "base",
}];

async function write(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createTranscript(
  repositoryRoot: string,
  harness: "codex" | "copilot" | "opencode",
  threadId: string,
) {
  const threadDirectory = path.join(
    repositoryRoot,
    ".workbench",
    "transcripts",
    harness,
    "threads",
    Buffer.from(threadId, "utf8").toString("base64url"),
  );
  await fs.mkdir(threadDirectory, { recursive: true });
  await fs.writeFile(path.join(threadDirectory, "thread.json"), "{}\n", "utf8");
}

async function targetAndHead(repositoryRoot: string, runGit: GitTestFixturePrepareContext["runGit"]) {
  return {
    head: (await runGit(["rev-parse", "HEAD"])).trim(),
    target: (await runGit(["rev-parse", "HEAD^"])).trim(),
  };
}

export const THREAD_GIT_BASE_FIXTURE = {
  commits: [{
    files: {
      "nested/one.txt": "one base\n",
      "nested/two.txt": "two base\n",
      "ordinary.txt": "ordinary base\n",
      "selected.txt": "selected base\n",
    },
    message: "base",
  }],
  name: "thread-git-base",
} satisfies GitTestFixtureSpec;

export const CHECKPOINT_OPERATIONS_BASE_FIXTURE = {
  commits: [{
    files: {
      "deleted.txt": "deleted checkpoint\n",
      "literal[1].txt": "literal checkpoint\n",
      "literal1.txt": "neighbor checkpoint\n",
      "selected.txt": "selected checkpoint\n",
      "unrelated.txt": "unrelated checkpoint\n",
    },
    message: "base",
  }],
  name: "checkpoint-operations-base",
} satisfies GitTestFixtureSpec;

export const CHECKPOINT_ADDITIONS_READY_FIXTURE = {
  commits: CHECKPOINT_OPERATIONS_BASE_FIXTURE.commits,
  name: "checkpoint-additions-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    await write(repositoryRoot, "later-claim.txt", "captured before plan\n");
    const controller = new WorkbenchGitCheckpointController();
    const original = await controller.createPlan({
      cwd: repositoryRoot,
      intentName: "Update selected",
      paths: ["selected.txt"],
      threadId: "thread-one",
    });
    await controller.startArc({ checkpointCommit: original.checkpointCommit, cwd: repositoryRoot, threadId: "thread-one" });
    const originalTree = (await runGit(["rev-parse", `${original.checkpointCommit}^{tree}`])).trim();
    const originalParent = (await runGit(["rev-parse", `${original.checkpointCommit}^`])).trim();
    const released = await controller.removeFromArc({ cwd: repositoryRoot, paths: ["selected.txt"], threadId: "thread-one" });
    await controller.startArc({ checkpointCommit: original.checkpointCommit, cwd: repositoryRoot, threadId: "thread-one" });
    return {
      originalCheckpoint: original.checkpointCommit,
      originalParent,
      originalTree,
      releasedScopePaths: released.scopePaths,
    };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{
  originalCheckpoint: string;
  originalParent: string;
  originalTree: string;
  releasedScopePaths: string[];
}>;

export const CHECKPOINT_RELEASE_READY_FIXTURE = {
  commits: CHECKPOINT_OPERATIONS_BASE_FIXTURE.commits,
  name: "checkpoint-release-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const controller = new WorkbenchGitCheckpointController();
    const restoreThreadId = "thread-release-restore";
    const restorePlan = await controller.createPlan({
      cwd: repositoryRoot,
      intentName: "Restore proposed work",
      paths: ["selected.txt"],
      threadId: restoreThreadId,
    });
    await controller.startArc({ checkpointCommit: restorePlan.checkpointCommit, cwd: repositoryRoot, threadId: restoreThreadId });
    await write(repositoryRoot, "selected.txt", "proposed restore work\n");
    const restoredProposal = await controller.createProposal({
      cwd: repositoryRoot,
      description: "",
      paths: ["selected.txt"],
      threadId: restoreThreadId,
      title: "Restore this proposal",
    });

    const unclaimThreadId = "thread-release-clean";
    const unclaimPlan = await controller.createPlan({
      cwd: repositoryRoot,
      intentName: "Unclaim proposed work",
      paths: ["literal[1].txt"],
      threadId: unclaimThreadId,
    });
    await controller.startArc({ checkpointCommit: unclaimPlan.checkpointCommit, cwd: repositoryRoot, threadId: unclaimThreadId });
    await write(repositoryRoot, "literal[1].txt", "proposed clean release\n");
    const unclaimedProposal = await controller.createProposal({
      cwd: repositoryRoot,
      description: "",
      paths: ["literal[1].txt"],
      threadId: unclaimThreadId,
      title: "Unclaim this proposal",
    });
    await runGit(["restore", "--", "literal[1].txt"]);
    return {
      restorePlanCheckpoint: restorePlan.checkpointCommit,
      restoredProposalId: restoredProposal.proposalId,
      unclaimedProposalId: unclaimedProposal.proposalId,
    };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{
  restorePlanCheckpoint: string;
  restoredProposalId: string;
  unclaimedProposalId: string;
}>;

export const CHECKPOINT_DIRTY_CLAIM_READY_FIXTURE = {
  commits: CHECKPOINT_OPERATIONS_BASE_FIXTURE.commits,
  name: "checkpoint-dirty-claim-ready",
  prepare: async ({ repositoryRoot }) => {
    const controller = new WorkbenchGitCheckpointController();
    const owner = await controller.createPlan({
      cwd: repositoryRoot,
      intentName: "Own selected",
      paths: ["selected.txt"],
      threadId: "owner-thread",
    });
    await controller.startArc({ checkpointCommit: owner.checkpointCommit, cwd: repositoryRoot, threadId: "owner-thread" });
    await write(repositoryRoot, "selected.txt", "already dirty\n");
    return {};
  },
} satisfies GitTestFixtureSpec;

export const CHECKPOINT_PROPOSAL_READY_FIXTURE = {
  commits: CHECKPOINT_OPERATIONS_BASE_FIXTURE.commits,
  name: "checkpoint-proposal-ready",
  prepare: async ({ repositoryRoot }) => {
    const controller = new WorkbenchGitCheckpointController();
    const plans = [
      { intentName: "Freeze proposal files", paths: ["selected.txt", "unrelated.txt"], threadId: "thread-frozen" },
      { intentName: "Include newer proposal work", paths: ["deleted.txt"], threadId: "thread-newer" },
      { intentName: "Expire a clean proposal", paths: ["literal[1].txt"], threadId: "thread-clean" },
    ];
    await write(repositoryRoot, ".git/info/exclude", ".workbench/\n");
    for (const { intentName, paths, threadId } of plans) {
      await createTranscript(repositoryRoot, "codex", threadId);
      const plan = await controller.createPlan({ cwd: repositoryRoot, intentName, paths, threadId });
      await controller.startArc({ checkpointCommit: plan.checkpointCommit, cwd: repositoryRoot, threadId });
    }
    await write(repositoryRoot, "selected.txt", "proposed version\n");
    await write(repositoryRoot, "deleted.txt", "proposed newer-path version\n");
    await write(repositoryRoot, "literal[1].txt", "proposed clean-path version\n");
    return {};
  },
} satisfies GitTestFixtureSpec;

export const PATH_MOVER_BASE_FIXTURE = {
  commits: [{ files: { "src/one.test.ts": "one\n" }, message: "initial" }],
  name: "path-mover-base",
} satisfies GitTestFixtureSpec;

export const PATH_MOVER_ARC_READY_FIXTURE = {
  commits: PATH_MOVER_BASE_FIXTURE.commits,
  name: "path-mover-arc-ready",
  prepare: async ({ repositoryRoot }) => {
    const controller = new WorkbenchGitCheckpointController();
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "move one file",
      paths: ["src"],
      threadId: "move-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "move-thread",
    });
    return {};
  },
} satisfies GitTestFixtureSpec;

export const THREAD_GIT_LINEAR_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "thread-git-linear",
} satisfies GitTestFixtureSpec;

export const CONTROLLER_BASE_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "checkpoint-controller-base",
} satisfies GitTestFixtureSpec;

export const HISTORY_LINEAR_FIXTURE = {
  commits: [
    { files: { "later.txt": "base\n", "selected.txt": "base\n" }, message: "base" },
    { files: { "selected.txt": "target\n" }, message: "target" },
    { files: { "later.txt": "descendant\n" }, message: "descendant" },
  ],
  name: "history-linear",
} satisfies GitTestFixtureSpec;

export const HISTORY_ARC_READY_FIXTURE = {
  commits: [{ files: { "later.txt": "base\n", "selected.txt": "base\n" }, message: "base" }],
  name: "history-arc-ready",
  prepare: async ({ repositoryRoot }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    await createTranscript(repositoryRoot, "codex", "amend-thread");
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "amend lifecycle",
      paths: ["selected.txt"],
      threadId: "amend-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "amend-thread",
    });
    await write(repositoryRoot, "selected.txt", "first proposal\n");
    const first = await controller.createProposal({
      cwd: repositoryRoot,
      description: "Original description",
      harness: "codex",
      threadId: "amend-thread",
      title: "Original title",
    });
    const firstCommit = await controller.commitProposal({
      cwd: repositoryRoot,
      description: first.description,
      harness: "codex",
      includeNewer: false,
      proposalId: first.proposalId,
      threadId: "amend-thread",
      title: first.title,
    });
    const oldHead = firstCommit.committedSha!;
    const originalParent = await repository.resolveParent(oldHead);
    const siblingPlan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "sibling plan",
      paths: ["later.txt"],
      threadId: "sibling-thread",
    });
    await controller.startArc({
      checkpointCommit: siblingPlan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "sibling-thread",
    });
    await controller.continueArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "amend-thread",
    });
    return {
      firstProposalId: first.proposalId,
      oldHead,
      originalParent,
      originalPlanCheckpoint: plan.checkpointCommit,
      siblingPlanCheckpoint: siblingPlan.checkpointCommit,
    };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{
  firstProposalId: string;
  oldHead: string;
  originalParent: string;
  originalPlanCheckpoint: string;
  siblingPlanCheckpoint: string;
}>;

export const HISTORY_CONFLICT_READY_FIXTURE = {
  commits: HISTORY_LINEAR_FIXTURE.commits,
  name: "history-conflict-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const { target } = await targetAndHead(repositoryRoot, runGit);
    await write(repositoryRoot, "selected.txt", "descendant edit\n");
    await runGit(["add", "selected.txt"]);
    await runGit(["commit", "--quiet", "-m", "conflicting descendant"]);
    await new WorkbenchGitCheckpointController().createPlan({
      cwd: repositoryRoot,
      intentName: "rollback witness",
      paths: ["later.txt"],
      threadId: "witness-thread",
    });
    return { target };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ target: string }>;

export const HISTORY_GLOBAL_REMAP_READY_FIXTURE = {
  commits: [
    {
      ...LINEAR_COMMITS[0],
      files: { ...LINEAR_COMMITS[0]!.files, "checkpoint.txt": "checkpoint base\n" },
    },
    ...LINEAR_COMMITS.slice(1),
  ],
  name: "history-global-remap-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    const { head: oldHead, target } = await targetAndHead(repositoryRoot, runGit);
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "metadata witness",
      paths: ["later.txt"],
      threadId: "metadata-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "metadata-thread",
    });
    const proposalMetadata: ProposalMetadata = {
      amendTargetSha: target,
      baseCommit: target,
      committedSha: target,
      description: "completed metadata witness",
      liveBaseCommit: oldHead,
      livePaths: ["later.txt"],
      mode: "commit",
      paths: ["later.txt"],
      proposalId: "synthetic-completed",
      sourceCheckpoint: plan.checkpointCommit,
      status: "superseded",
      supersededByProposalId: "replacement-proposal",
      supersededBySha: oldHead,
      title: "Completed metadata witness",
      unavailableReason: null,
      version: 2,
    };
    const proposalCommit = await repository.createCommitFromTree(
      await repository.resolveTree(oldHead),
      oldHead,
      proposalMessage(proposalMetadata),
    );
    const proposalRef = "refs/worktree/agents/codex/metadata-thread/checkpoint-proposals/synthetic-completed";
    const previousOutcomeRef = outcomeRef("codex", "metadata-thread", plan.checkpointCommit);
    const outcome: ArcOutcome = {
      committedSha: oldHead,
      proposalId: proposalMetadata.proposalId,
      sourceCheckpoint: plan.checkpointCommit,
      status: "partial",
      successorCheckpoint: plan.checkpointCommit,
      version: 1,
    };
    const outcomeBlob = await repository.writeBlob(`${JSON.stringify(outcome)}\n`);
    await repository.updateRefs([
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: proposalRef },
      { newValue: outcomeBlob, oldValue: "0".repeat(40), ref: previousOutcomeRef },
    ]);
    const checkpointPlan = await controller.createPlan({
      cwd: repositoryRoot,
      intentName: "remember me",
      paths: ["checkpoint.txt"],
      threadId: "arc-thread",
    });
    const brokenRefRelativePath = path.join(
      ".git",
      "refs",
      "worktree",
      "agents",
      "legacy-thread",
      "checkpoints",
      "legacy-11111111",
    );
    return {
      activePlanCheckpoint: plan.checkpointCommit,
      brokenRefRelativePath,
      checkpointPlanCheckpoint: checkpointPlan.checkpointCommit,
      previousOutcomeRef,
      proposalRef,
      target,
    };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{
  activePlanCheckpoint: string;
  brokenRefRelativePath: string;
  checkpointPlanCheckpoint: string;
  previousOutcomeRef: string;
  proposalRef: string;
  target: string;
}>;

export const HISTORY_PUSHED_READY_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "history-pushed-ready",
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const { target } = await targetAndHead(repositoryRoot, runGit);
    const remoteRoot = path.join(bundleRoot, "remote.git");
    await runGit(["init", "--bare", remoteRoot], { cwd: bundleRoot });
    await runGit(["remote", "add", "origin", "../remote.git"]);
    await runGit(["push", "--quiet", "origin", `${target}:refs/heads/main`]);
    return { target };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ target: string }>;

export const HISTORY_MERGE_READY_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "history-merge-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const { target } = await targetAndHead(repositoryRoot, runGit);
    await runGit(["branch", "side", target]);
    await runGit(["checkout", "--quiet", "side"]);
    await write(repositoryRoot, "side.txt", "side branch\n");
    await runGit(["add", "side.txt"]);
    await runGit(["commit", "--quiet", "-m", "side"]);
    await runGit(["checkout", "--quiet", "main"]);
    await runGit(["merge", "--quiet", "--no-ff", "side", "-m", "merge"]);
    return { target };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ target: string }>;

export const HISTORY_SIGNED_READY_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "history-signed-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const oldHead = await repository.currentHead();
    const tree = (await runGit(["rev-parse", "HEAD^{tree}"])).trim();
    const signedCommit = (await repository.runWithInput(["hash-object", "-t", "commit", "-w", "--stdin"], [
      `tree ${tree}`,
      `parent ${oldHead}`,
      "author Signed Fixture <signed@workbench.invalid> 946684900 +0000",
      "committer Signed Fixture <signed@workbench.invalid> 946684900 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " fake-signature-for-policy-test",
      " -----END PGP SIGNATURE-----",
      "",
      "signed fixture",
      "",
    ].join("\n"))).trim();
    await repository.updateRef("refs/heads/main", signedCommit, oldHead);
    return { signedCommit };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ signedCommit: string }>;

export const CONTROLLER_START_READY_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "controller-start-ready",
  prepare: async ({ repositoryRoot }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    const freshPlan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "fresh plan",
      paths: ["one.txt"],
      threadId: "fresh-thread",
    });
    const head = await repository.currentHead();
    const legacyCommit = await repository.createCommitFromTree(await repository.resolveTree(head), head, [
      "workbench-git-checkpoint-v1",
      JSON.stringify({ amendedFrom: null, intentName: "legacy plan", kind: "arc", scopePaths: ["two.txt"], version: 2 }),
      "",
    ].join("\n"));
    await repository.updateRef(`refs/worktree/agents/legacy-thread/checkpoints/legacy-${legacyCommit.slice(0, 7)}`, legacyCommit);
    return { freshPlanCheckpoint: freshPlan.checkpointCommit, legacyCommit };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ freshPlanCheckpoint: string; legacyCommit: string }>;

export const CONTROLLER_ADOPT_READY_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "controller-adopt-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    await write(repositoryRoot, "deleted.txt", "delete me\n");
    await write(repositoryRoot, "staged.txt", "staged base\n");
    await runGit(["add", "deleted.txt", "staged.txt"]);
    await runGit(["commit", "--quiet", "-m", "add adoption fixtures"]);
    const controller = new WorkbenchGitCheckpointController();
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "adopt workspace work",
      paths: ["one.txt"],
      threadId: "adopt-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "adopt-thread",
    });
    return { planCheckpoint: plan.checkpointCommit };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ planCheckpoint: string }>;

export const CONTROLLER_FAILED_ADOPT_READY_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "controller-failed-adopt-ready",
  prepare: async ({ repositoryRoot }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "atomic adoption",
      paths: ["one.txt"],
      threadId: "adopt-owner",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "adopt-owner",
    });
    await new GitArcRegistry(repository).claim({
      checkpointCommit: await repository.currentHead(),
      claimedPaths: ["collision.txt"],
      harness: "opencode",
      intentDescription: "",
      intentName: "sibling collision",
      proposalId: null,
      threadId: "sibling-thread",
    });
    return { planCheckpoint: plan.checkpointCommit };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ planCheckpoint: string }>;

export const CONTROLLER_PARTIAL_READY_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "controller-partial-ready",
  prepare: async ({ repositoryRoot }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    await createTranscript(repositoryRoot, "codex", "partial-thread");
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "change both files",
      paths: ["one.txt", "two.txt"],
      threadId: "partial-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "partial-thread",
    });
    return { planCheckpoint: plan.checkpointCommit, repositoryHead: await repository.currentHead() };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ planCheckpoint: string; repositoryHead: string }>;

export const CONTROLLER_REPLACEMENT_READY_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "controller-replacement-ready",
  prepare: async ({ repositoryRoot }) => {
    const controller = new WorkbenchGitCheckpointController();
    await createTranscript(repositoryRoot, "codex", "partial-thread");
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "change both files",
      paths: ["one.txt", "two.txt"],
      threadId: "partial-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "partial-thread",
    });
    await controller.addToArc({ cwd: repositoryRoot, harness: "codex", paths: ["three.txt"], threadId: "partial-thread" });
    await write(repositoryRoot, "one.txt", "replace one\n");
    await write(repositoryRoot, "two.txt", "rescind two\n");
    await write(repositoryRoot, "three.txt", "commit three\n");
    const replaceTarget = await controller.createProposal({
      cwd: repositoryRoot, description: "", harness: "codex", paths: ["one.txt"], threadId: "partial-thread", title: "replace target",
    });
    const rescindTarget = await controller.createProposal({
      cwd: repositoryRoot, description: "", harness: "codex", paths: ["two.txt"], threadId: "partial-thread", title: "rescind target",
    });
    const commitTarget = await controller.createProposal({
      cwd: repositoryRoot, description: "", harness: "codex", paths: ["three.txt"], threadId: "partial-thread", title: "commit target",
    });
    const committed = await controller.commitProposal({
      cwd: repositoryRoot,
      description: "",
      harness: "codex",
      includeNewer: false,
      proposalId: commitTarget.proposalId,
      threadId: "partial-thread",
      title: "commit target",
    });
    const replacementPlan = await controller.createPlan({
      cwd: repositoryRoot, harness: "codex", intentName: "replace prior proposals", paths: ["one.txt", "two.txt"], threadId: "partial-thread",
    });
    await controller.startArc({
      checkpointCommit: replacementPlan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "partial-thread",
    });
    return {
      commitTargetProposalId: commitTarget.proposalId,
      committedSha: committed.committedSha!,
      replaceTargetProposalId: replaceTarget.proposalId,
      rescindTargetProposalId: rescindTarget.proposalId,
    };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{
  commitTargetProposalId: string;
  committedSha: string;
  replaceTargetProposalId: string;
  rescindTargetProposalId: string;
}>;

export const CONTROLLER_PUSHED_AMEND_READY_FIXTURE = {
  commits: CONTROLLER_COMMITS,
  name: "controller-pushed-amend-ready",
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const remoteRoot = path.join(bundleRoot, "remote.git");
    await runGit(["init", "--bare", remoteRoot], { cwd: bundleRoot });
    await runGit(["remote", "add", "origin", "../remote.git"]);
    await runGit(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    const controller = new WorkbenchGitCheckpointController();
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "reject pushed amend",
      paths: ["one.txt"],
      threadId: "pushed-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "pushed-thread",
    });
    return { planCheckpoint: plan.checkpointCommit };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ planCheckpoint: string }>;

type GitTestFileSpec = {
  nested: boolean;
  prewarmers: Array<(cache: GitTestFixtureCache) => Promise<string>>;
};

const specsByGitTestFile = new Map<string, GitTestFileSpec>([
  ["GitArcPathMover.test.ts", { nested: false, prewarmers: [
    (cache) => cache.template(PATH_MOVER_BASE_FIXTURE),
    (cache) => cache.template(PATH_MOVER_ARC_READY_FIXTURE),
  ] }],
  ["git-checkpoints.test.ts", { nested: true, prewarmers: [
    (cache) => cache.template(CHECKPOINT_OPERATIONS_BASE_FIXTURE),
    (cache) => cache.template(CHECKPOINT_ADDITIONS_READY_FIXTURE),
    (cache) => cache.template(CHECKPOINT_DIRTY_CLAIM_READY_FIXTURE),
    (cache) => cache.template(CHECKPOINT_PROPOSAL_READY_FIXTURE),
    (cache) => cache.template(CHECKPOINT_RELEASE_READY_FIXTURE),
  ] }],
  ["WorkbenchGitRepository.test.ts", { nested: false, prewarmers: [
    (cache) => cache.template(THREAD_GIT_BASE_FIXTURE),
  ] }],
  ["WorkbenchGitHistoryRewriter.test.ts", { nested: false, prewarmers: [
    (cache) => cache.template(HISTORY_LINEAR_FIXTURE),
    (cache) => cache.template(HISTORY_CONFLICT_READY_FIXTURE),
    (cache) => cache.template(HISTORY_ARC_READY_FIXTURE),
  ] }],
  ["WorkbenchThreadGit.test.ts", { nested: false, prewarmers: [
    (cache) => cache.template(THREAD_GIT_BASE_FIXTURE),
    (cache) => cache.template(THREAD_GIT_LINEAR_FIXTURE),
    (cache) => cache.template(HISTORY_GLOBAL_REMAP_READY_FIXTURE),
    (cache) => cache.template(HISTORY_PUSHED_READY_FIXTURE),
    (cache) => cache.template(HISTORY_MERGE_READY_FIXTURE),
    (cache) => cache.template(HISTORY_SIGNED_READY_FIXTURE),
  ] }],
  ["WorkbenchGitCheckpointController.test.ts", { nested: true, prewarmers: [
    (cache) => cache.template(CONTROLLER_BASE_FIXTURE),
    (cache) => cache.template(CONTROLLER_START_READY_FIXTURE),
    (cache) => cache.template(CONTROLLER_ADOPT_READY_FIXTURE),
    (cache) => cache.template(CONTROLLER_FAILED_ADOPT_READY_FIXTURE),
    (cache) => cache.template(CONTROLLER_PARTIAL_READY_FIXTURE),
    (cache) => cache.template(CONTROLLER_REPLACEMENT_READY_FIXTURE),
    (cache) => cache.template(CONTROLLER_PUSHED_AMEND_READY_FIXTURE),
  ] }],
]);

export function partitionWorkbenchGitTestFiles(testFiles: readonly string[]) {
  const gitFiles: string[] = [];
  const nestedGitFiles: string[] = [];
  const ordinaryFiles: string[] = [];
  for (const file of testFiles) {
    const spec = specsByGitTestFile.get(path.basename(file));
    (spec?.nested ? nestedGitFiles : spec ? gitFiles : ordinaryFiles).push(file);
  }
  return { gitFiles, nestedGitFiles, ordinaryFiles };
}

export async function prewarmWorkbenchGitTestFixtures(testFiles: readonly string[]) {
  const cache = new GitTestFixtureCache();
  const requested = new Set(testFiles.map((file) => path.basename(file)));
  const prewarmers = [...requested].flatMap((file) => specsByGitTestFile.get(file)?.prewarmers ?? []);
  const uniquePrewarmers = [...new Set(prewarmers)];
  const workers = Array.from({ length: Math.min(2, uniquePrewarmers.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < uniquePrewarmers.length; index += 2) {
      await uniquePrewarmers[index]!(cache);
    }
  });
  await Promise.all(workers);
}
