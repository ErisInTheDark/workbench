/*
 * Exports:
 * - HISTORY_LINEAR_FIXTURE: shared three-commit history for ordered rewrite checks.
 * - HISTORY_ARC_READY_FIXTURE: two pending amendments with a descendant and active sibling.
 * - HISTORY_CONFLICT_READY_FIXTURE: conflicting descendant with a retained checkpoint witness.
 * - HISTORY_ROOT_READY_FIXTURE: accepted parentless proposal with its claim reacquired.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { GitTestFixtureSpec } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

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
  revision: 2,
  prepare: async ({ repositoryRoot, runGit }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    const identity = { cwd: repositoryRoot, harness: "codex" as const, threadId: "amend-thread" };
    const transcriptDirectory = path.join(repositoryRoot, ".workbench", "transcripts", "codex", "threads", Buffer.from(identity.threadId).toString("base64url"));
    await fs.mkdir(transcriptDirectory, { recursive: true });
    await fs.writeFile(path.join(transcriptDirectory, "thread.json"), "{}\n", "utf8");
    const writeSelected = (contents: string) => fs.writeFile(path.join(repositoryRoot, "selected.txt"), contents, "utf8");
    const plan = await controller.createPlan({ ...identity, intentName: "amend lifecycle", paths: ["selected.txt"] });
    await controller.startArc({ ...identity, checkpointCommit: plan.checkpointCommit });
    await writeSelected("first proposal\n");
    const first = await controller.createProposal({ ...identity, description: "Original description", title: "Original title" });
    const firstCommit = await controller.commitProposal({
      ...identity, description: first.description, includeNewer: false, proposalId: first.proposalId, title: first.title,
    });
    const oldHead = firstCommit.committedSha!;
    const originalParent = await repository.resolveParent(oldHead);
    await writeSelected("first proposal\nincidental sibling snapshot\n");
    const siblingIdentity = { ...identity, threadId: "sibling-thread" };
    const siblingPlan = await controller.createPlan({ ...siblingIdentity, intentName: "sibling plan", paths: ["later.txt"] });
    await writeSelected("first proposal\n");
    await controller.startArc({ ...siblingIdentity, checkpointCommit: siblingPlan.checkpointCommit });
    await controller.editArcClaims({ ...identity, inherit: true, addPaths: ["selected.txt"] });

    await fs.writeFile(path.join(repositoryRoot, "descendant.txt"), "later descendant\n", "utf8");
    await runGit(["add", "descendant.txt"]);
    await runGit(["commit", "--quiet", "-m", "later descendant"]);
    const originalDescendant = await repository.currentHead();
    await writeSelected("first proposal\nfirst amendment\n");
    const amendment = await controller.createProposal({
      ...identity, amend: true, amendProposalId: first.proposalId, description: "", title: "",
    });
    await writeSelected("first proposal\nfirst amendment\nsecond amendment\n");
    const second = await controller.createProposal({
      ...identity, amend: true, amendProposalId: first.proposalId, description: "", title: "second pending amend",
    });
    return {
      amendmentProposalId: amendment.proposalId,
      amendmentSourceCheckpoint: amendment.sourceCheckpoint,
      secondProposalId: second.proposalId,
      firstProposalId: first.proposalId,
      oldHead,
      originalDescendant,
      originalParent,
      originalPlanCheckpoint: plan.checkpointCommit,
      siblingPlanCheckpoint: siblingPlan.checkpointCommit,
    };
  },
} satisfies GitTestFixtureSpec<object>;

export const HISTORY_CONFLICT_READY_FIXTURE = {
  commits: HISTORY_LINEAR_FIXTURE.commits,
  name: "history-conflict-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const target = (await runGit(["rev-parse", "HEAD^"])).trim();
    await fs.writeFile(path.join(repositoryRoot, "selected.txt"), "descendant edit\n", "utf8");
    await runGit(["add", "selected.txt"]);
    await runGit(["commit", "--quiet", "-m", "conflicting descendant"]);
    await new WorkbenchGitCheckpointController().createPlan({
      cwd: repositoryRoot, intentName: "rollback witness", paths: ["later.txt"], threadId: "witness-thread",
    });
    return { target };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ target: string }>;

export const HISTORY_ROOT_READY_FIXTURE = {
  commits: [],
  name: "history-root-ready",
  revision: 1,
  prepare: async ({ repositoryRoot }) => {
    const controller = new WorkbenchGitCheckpointController();
    const identity = { cwd: repositoryRoot, threadId: "initial" };
    await controller.createAndStartPlan({ ...identity, intentName: "initial", paths: ["one.txt"] });
    await fs.writeFile(path.join(repositoryRoot, "one.txt"), "first\n", "utf8");
    const proposal = await controller.createProposal({ ...identity, title: "first", description: "" });
    const accepted = await controller.commitProposal({
      ...identity, proposalId: proposal.proposalId, title: "first", description: "", includeNewer: false,
    });
    await controller.editArcClaims({ ...identity, inherit: true, addPaths: ["one.txt"] });
    return { proposalId: proposal.proposalId, committedSha: accepted.committedSha };
  },
} satisfies GitTestFixtureSpec<object>;
