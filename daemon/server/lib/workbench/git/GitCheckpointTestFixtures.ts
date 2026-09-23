/*
 * Exports:
 * - CHECKPOINT_OPERATIONS_FIXTURE: prepare shared repository states for the checkpoint assertion battery.
 * - CheckpointFixtureState: locate prepared branches and their checkpoint/proposal identities.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { GitTestFixtureSpec } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";

export const CHECKPOINT_OPERATIONS_FIXTURE = {
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
  name: "checkpoint-shared-states-v4",
  revision: 4,
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const controller = new WorkbenchGitCheckpointController();
    const threadId = "thread-one";
    const newerThreadId = "thread-newer";
    const cleanThreadId = "thread-clean";
    const write = async (root: string, file: string, content: string) => {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    };
    const fork = async (name: string, source: string) => {
      // Loose checkpoint refs already have long names on Windows.
      const relativeRoot = `r/${name}`;
      const root = path.join(bundleRoot, relativeRoot);
      await fs.cp(source, root, { errorOnExist: true, force: false, recursive: true });
      return { relativeRoot, root };
    };
    const planAndStart = async (cwd: string, owner: string, paths: string[], intentName: string) => {
      const plan = await controller.createPlan({ cwd, threadId: owner, paths, intentName });
      return await controller.startArc({ cwd, threadId: owner, checkpointCommit: plan.checkpointCommit });
    };
    const propose = async (cwd: string, owner: string, title: string, paths?: string[], description = "") => (
      await controller.createProposal({ cwd, threadId: owner, title, paths, description })
    );

    await write(repositoryRoot, "later-claim.txt", "captured before plan\n");
    const plan = await controller.createPlan({
      cwd: repositoryRoot, threadId, paths: ["selected.txt"], intentName: "Update selected",
    });
    const originalTree = (await runGit(["rev-parse", `${plan.checkpointCommit}^{tree}`])).trim();
    const originalParent = (await runGit(["rev-parse", `${plan.checkpointCommit}^`])).trim();
    const restore = await fork("r", repositoryRoot);
    await write(restore.root, "selected.txt", "selected lint change\n");
    await fs.rm(path.join(restore.root, "deleted.txt"));
    await write(restore.root, "created.txt", "created by lint\n");
    await write(restore.root, "unrelated.txt", "unrelated staged\n");
    await runGit(["add", "--", "unrelated.txt"], { cwd: restore.root });
    await write(restore.root, "unrelated.txt", "unrelated worktree\n");

    await controller.startArc({ cwd: repositoryRoot, threadId, checkpointCommit: plan.checkpointCommit });
    const released = await controller.removeFromArc({ cwd: repositoryRoot, threadId, paths: ["selected.txt"] });
    const active = await controller.startArc({ cwd: repositoryRoot, threadId, checkpointCommit: plan.checkpointCommit });
    const planning = await fork("p", repositoryRoot);
    await write(planning.root, "selected.txt", "already dirty\n");
    const additions = await fork("a", repositoryRoot);
    const cleanRelease = await fork("c", repositoryRoot);
    const stash = await fork("s", repositoryRoot);
    const stashPlan = await fork("sp", repositoryRoot);

    await planAndStart(repositoryRoot, newerThreadId, ["deleted.txt"], "Include newer proposal work");
    await planAndStart(repositoryRoot, cleanThreadId, ["literal[1].txt"], "Expire a clean proposal");
    const frozen = await fork("f", repositoryRoot);
    const rebase = await fork("h", repositoryRoot);

    // These branches consume the same pending proposal instead of recreating it.
    await write(repositoryRoot, "selected.txt", "staged dirty release\n");
    await runGit(["add", "--", "selected.txt"]);
    await write(repositoryRoot, "selected.txt", "worktree dirty release\n");
    const sharedProposal = await propose(repositoryRoot, threadId, "Keep dirty work");
    const manual = await fork("m", repositoryRoot);

    await write(repositoryRoot, "literal[1].txt", "proposed clean release\n");
    const unclaimedProposal = await propose(repositoryRoot, cleanThreadId, "Unclaim this proposal", ["literal[1].txt"]);
    await runGit(["restore", "--", "literal[1].txt"]);
    const releaseRestore = await fork("u", repositoryRoot);
    const commitThreadId = "proposal-after-unclaim";
    await planAndStart(repositoryRoot, commitThreadId, ["literal1.txt"], "Commit after unclaim");
    await write(repositoryRoot, "literal1.txt", "proposal preserved after unclaim\n");
    const commitProposal = await propose(repositoryRoot, commitThreadId, "Commit preserved proposal");
    const dirtyRelease = { relativeRoot: "repo", root: repositoryRoot };
    const futurePlan = await controller.createPlan({
      cwd: dirtyRelease.root, threadId, paths: ["selected.txt"], intentName: "Keep the inactive plan",
    });

    await write(frozen.root, ".git/info/exclude", ".workbench/\n");
    for (const owner of [threadId, newerThreadId, cleanThreadId]) {
      await write(frozen.root, `.workbench/transcripts/codex/threads/${Buffer.from(owner, "utf8").toString("base64url")}/thread.json`, "{}\n");
    }
    await controller.addToArc({ cwd: frozen.root, threadId, paths: ["unrelated.txt"] });
    await write(frozen.root, "selected.txt", "proposed version\n");
    await write(frozen.root, "deleted.txt", "proposed newer-path version\n");
    await write(frozen.root, "literal[1].txt", "proposed clean-path version\n");
    const originalProposal = await propose(frozen.root, threadId, "Commit selected", ["selected.txt", "unrelated.txt"], "Frozen proposal");
    const currentProposal = await propose(frozen.root, threadId, "Commit selected replacement", ["selected.txt", "unrelated.txt"], "Replacement proposal");
    const newerProposal = await propose(frozen.root, newerThreadId, "Commit newer selected", ["deleted.txt"]);
    const cleanProposal = await propose(frozen.root, cleanThreadId, "Expire clean selected", ["literal[1].txt"]);

    const rootCommit = (await runGit(["rev-parse", "HEAD"], { cwd: rebase.root })).trim();
    const replacementThreadId = "thread-replacement";
    await planAndStart(rebase.root, replacementThreadId, ["unrelated.txt"], "Rebase across replacement history");
    await write(rebase.root, "selected.txt", "proposed version\n");
    await write(rebase.root, "deleted.txt", "conflicting proposal version\n");
    await write(rebase.root, "literal[1].txt", "alternate-branch proposal version\n");
    await write(rebase.root, "unrelated.txt", "replacement proposal version\n");
    await write(rebase.root, "before-proposal.txt", "committed before proposal\n");
    await runGit(["add", "--", "before-proposal.txt"], { cwd: rebase.root });
    await runGit(["commit", "-m", "advance before proposal"], { cwd: rebase.root });
    const compatibleProposal = await propose(rebase.root, threadId, "Commit selected", ["selected.txt"]);
    const conflictProposal = await propose(rebase.root, newerThreadId, "Conflict selected path", ["deleted.txt"]);
    const incompatibleProposal = await propose(rebase.root, cleanThreadId, "Incompatible history", ["literal[1].txt"]);
    const replacementProposal = await propose(rebase.root, replacementThreadId, "Commit replacement-safe work");

    const branches = [restore, planning, additions, cleanRelease, stash, stashPlan, manual, releaseRestore, frozen, rebase];
    for (const branch of branches) await runGit(["fsck", "--strict"], { cwd: branch.root });
    return {
      additions: {
        root: additions.relativeRoot,
        originalCheckpoint: plan.checkpointCommit, originalParent, originalTree,
        releasedScopePaths: released.scopePaths,
      },
      cleanRelease: { root: cleanRelease.relativeRoot, threadId },
      dirtyRelease: {
        root: dirtyRelease.relativeRoot, threadId, dirtyArcCheckpoint: active.checkpointCommit,
        futurePlanCheckpoint: futurePlan.checkpointCommit, proposalId: sharedProposal.proposalId,
        commitThreadId, commitProposalId: commitProposal.proposalId,
      },
      frozen: {
        root: frozen.relativeRoot, threadId, newerThreadId, cleanThreadId,
        originalProposalId: originalProposal.proposalId, currentProposalId: currentProposal.proposalId,
        newerProposalId: newerProposal.proposalId, cleanProposalId: cleanProposal.proposalId,
      },
      manual: { root: manual.relativeRoot, threadId, proposalId: sharedProposal.proposalId },
      planning: { root: planning.relativeRoot, ownerThreadId: threadId },
      rebase: {
        root: rebase.relativeRoot, compatibleThreadId: threadId, conflictThreadId: newerThreadId,
        incompatibleThreadId: cleanThreadId, replacementThreadId, rootCommit,
        compatibleProposalId: compatibleProposal.proposalId, conflictProposalId: conflictProposal.proposalId,
        incompatibleProposalId: incompatibleProposal.proposalId, replacementProposalId: replacementProposal.proposalId,
      },
      releaseRestore: {
        root: releaseRestore.relativeRoot, restoreThreadId: threadId, unclaimThreadId: cleanThreadId,
        restorePlanCheckpoint: plan.checkpointCommit, restoredProposalId: sharedProposal.proposalId,
        unclaimedProposalId: unclaimedProposal.proposalId,
      },
      restore: { root: restore.relativeRoot, checkpointCommit: plan.checkpointCommit },
      stash: { root: stash.relativeRoot, threadId },
      stashPlan: { root: stashPlan.relativeRoot, threadId },
    };
  },
} satisfies GitTestFixtureSpec<object>;

export type CheckpointFixtureState = Awaited<ReturnType<typeof CHECKPOINT_OPERATIONS_FIXTURE.prepare>>;
