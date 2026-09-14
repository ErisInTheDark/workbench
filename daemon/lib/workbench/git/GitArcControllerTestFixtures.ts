/*
 * Exports:
 * - CONTROLLER_BASE_FIXTURE: basic two-file controller repository.
 * - CONTROLLER_PARTIAL_READY_FIXTURE: existing active two-file fixture for other consumers.
 * - CONTROLLER_OPERATIONS_FIXTURE: shared prepared histories for the controller battery.
 * - ControllerFixtureState: branch paths and prepared checkpoint/proposal identities.
 */
import fs from "node:fs/promises";
import path from "node:path";

import GitArcRegistry from "./GitArcRegistry";
import type { GitTestFixtureSpec } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

export const CONTROLLER_BASE_FIXTURE = {
  commits: [{ files: { "one.txt": "one\n", "two.txt": "two\n" }, message: "base" }],
  name: "checkpoint-controller-base",
} satisfies GitTestFixtureSpec;

async function write(root: string, file: string, content: string | Uint8Array) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function preparePartial(repositoryRoot: string) {
  const repository = await WorkbenchGitRepository.open(repositoryRoot);
  const controller = new WorkbenchGitCheckpointController();
  await write(repositoryRoot, `.workbench/transcripts/codex/threads/${Buffer.from("partial-thread").toString("base64url")}/thread.json`, "{}\n");
  const plan = await controller.createPlan({
    cwd: repositoryRoot, harness: "codex", intentName: "change both files",
    paths: ["one.txt", "two.txt"], threadId: "partial-thread",
  });
  await controller.startArc({
    checkpointCommit: plan.checkpointCommit, cwd: repositoryRoot, harness: "codex", threadId: "partial-thread",
  });
  return { planCheckpoint: plan.checkpointCommit, repositoryHead: await repository.currentHead() };
}

export const CONTROLLER_PARTIAL_READY_FIXTURE = {
  commits: CONTROLLER_BASE_FIXTURE.commits,
  name: "controller-partial-ready",
  prepare: async ({ repositoryRoot }) => await preparePartial(repositoryRoot),
  revision: 1,
} satisfies GitTestFixtureSpec<{ planCheckpoint: string; repositoryHead: string }>;

export const CONTROLLER_OPERATIONS_FIXTURE = {
  commits: CONTROLLER_BASE_FIXTURE.commits,
  name: "controller-shared-states",
  revision: 8,
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const controller = new WorkbenchGitCheckpointController();
    const registry = { root: repositoryRoot, relativeRoot: "repo" };
    const fork = async (name: string, source = repositoryRoot) => {
      const relativeRoot = `r/${name}`;
      const root = path.join(bundleRoot, relativeRoot);
      await fs.cp(source, root, { recursive: true, errorOnExist: true, force: false });
      return { root, relativeRoot };
    };
    const propose = async (cwd: string, paths: string[], title: string) => (
      await controller.createProposal({ cwd, harness: "codex", threadId: "partial-thread", paths, title, description: "" })
    );
    const empty = await fork("e");
    const legacy = await fork("l");
    const legacyRepository = new WorkbenchGitRepository(legacy.root);
    const legacyHead = await legacyRepository.currentHead();
    const legacyCommit = await legacyRepository.createCommitFromTree(await legacyRepository.resolveTree(legacyHead), legacyHead, [
      "workbench-git-checkpoint-v1",
      JSON.stringify({ amendedFrom: null, intentName: "legacy plan", kind: "arc", scopePaths: ["two.txt"], version: 2 }),
      "",
    ].join("\n"));
    await legacyRepository.updateRef(`refs/worktree/agents/legacy-thread/checkpoints/legacy-${legacyCommit.slice(0, 7)}`, legacyCommit);

    const diagnostics = await fork("d");
    await write(diagnostics.root, "nested/base.txt", "base\n");
    await write(diagnostics.root, "nested/data.bin", new Uint8Array([0, 1]));
    await runGit(["add", "nested"], { cwd: diagnostics.root });
    await runGit(["commit", "--quiet", "-m", "prepare nested plan"], { cwd: diagnostics.root });
    const diagnosticRepository = new WorkbenchGitRepository(diagnostics.root);
    const planHead = await diagnosticRepository.currentHead();
    const comparisonPlan = await controller.createPlan({
      cwd: diagnostics.root, harness: "codex", threadId: "comparison-thread",
      intentName: "inspect scoped drift", paths: ["one.txt", "two.txt", "nested"],
    });
    await write(diagnostics.root, "unrelated.txt", "unrelated\n".repeat(3_000));
    await runGit(["add", "unrelated.txt"], { cwd: diagnostics.root });
    await runGit(["commit", "--quiet", "-m", "unrelated housekeeping"], { cwd: diagnostics.root });
    await write(diagnostics.root, "one.txt", "committed\npatch-only-secret\n");
    await runGit(["add", "one.txt"], { cwd: diagnostics.root });
    await runGit(["commit", "--quiet", "-m", "change planned one"], { cwd: diagnostics.root });
    const relevantCommit = await diagnosticRepository.currentHead();
    await write(diagnostics.root, "one.txt", "committed\npatch-only-secret\ndirty\n");
    await fs.unlink(path.join(diagnostics.root, "two.txt"));
    await write(diagnostics.root, "nested/base.txt", "changed\n");
    await write(diagnostics.root, "nested/data.bin", new Uint8Array([0, 2]));
    const addedPaths = Array.from({ length: 24 }, (_, index) => `nested/added-${index}.txt`);
    await Promise.all(addedPaths.map((file) => write(diagnostics.root, file, "added\n")));

    const workspace = await fork("w");
    await controller.createAndStartPlan({
      cwd: workspace.root, harness: "codex", threadId: "adopt-thread", intentName: "adopt workspace work", paths: ["one.txt"],
    });
    const adoption = await fork("a", workspace.root);
    const remote = await fork("r", workspace.root);
    await controller.addToArc({ cwd: workspace.root, harness: "codex", threadId: "adopt-thread", paths: ["nested"] });
    await new GitArcRegistry(new WorkbenchGitRepository(workspace.root)).claim({
      checkpointCommit: await new WorkbenchGitRepository(workspace.root).currentHead(),
      claimedPaths: ["sibling.txt"], harness: "codex", intentDescription: "",
      intentName: "Sibling owner", proposalId: null, threadId: "sibling-thread",
    });

    await write(adoption.root, "deleted.txt", "delete me\n");
    await write(adoption.root, "ignored-delete/environment.toml", "ignore and delete me\n");
    await write(adoption.root, "staged.txt", "staged base\n");
    await runGit(["add", "deleted.txt", "ignored-delete/environment.toml", "staged.txt"], { cwd: adoption.root });
    await runGit(["commit", "--quiet", "-m", "add adoption fixtures"], { cwd: adoption.root });
    await fs.rm(path.join(adoption.root, "ignored-delete/environment.toml"));
    await runGit(["add", "-u", "--", "ignored-delete/environment.toml"], { cwd: adoption.root });
    await write(adoption.root, ".gitignore", "ignored/\nignored-delete/\n");
    await runGit(["add", "--", ".gitignore"], { cwd: adoption.root });
    const ignoredPlan = await controller.createPlan({
      cwd: adoption.root, harness: "codex", threadId: "ignored-deletion-thread",
      intentName: "ignore and delete tracked file",
      paths: [".gitignore", "ignored-delete/environment.toml"],
      adoptPaths: [".gitignore", "ignored-delete/environment.toml"],
    });
    await controller.startArc({
      cwd: adoption.root, harness: "codex", threadId: "ignored-deletion-thread", checkpointCommit: ignoredPlan.checkpointCommit,
    });
    const adoptionRepository = new WorkbenchGitRepository(adoption.root);
    await new GitArcRegistry(adoptionRepository).claim({
      checkpointCommit: await adoptionRepository.currentHead(), claimedPaths: ["collision.txt"],
      harness: "opencode", intentDescription: "", intentName: "sibling collision",
      proposalId: null, threadId: "sibling-thread",
    });

    const remoteRoot = path.join(bundleRoot, "remote.git");
    await runGit(["init", "--bare", remoteRoot], { cwd: bundleRoot });
    await runGit(["remote", "add", "origin", "../../remote.git"], { cwd: remote.root });
    await runGit(["push", "--quiet", "origin", "HEAD:refs/heads/main"], { cwd: remote.root });

    const claims = await fork("c");
    await preparePartial(claims.root);
    const status = await fork("s", claims.root);
    const partial = await fork("p", claims.root);
    const replacement = await fork("x", claims.root);
    await controller.addToArc({ cwd: status.root, harness: "codex", threadId: "partial-thread", paths: ["added.txt"] });
    await write(status.root, "one.txt", "proposed content\n");
    await write(status.root, "added.txt", "proposed addition\n");
    const statusProposal = await propose(status.root, ["added.txt", "one.txt"], "change one");
    await write(partial.root, "one.txt", "committed one\n");
    const firstProposal = await propose(partial.root, ["one.txt"], "commit one");
    const retained = await fork("t", partial.root);
    await write(partial.root, "two.txt", "remaining two\n");
    const secondProposal = await propose(partial.root, ["two.txt"], "commit two");
    await write(retained.root, "two.txt", "retained two\n");
    const retainedProposal = await controller.createProposal({
      cwd: retained.root, harness: "codex", threadId: "partial-thread",
      amend: true, replaceProposalId: firstProposal.proposalId, paths: ["one.txt"],
      title: "amend one", description: "", freshTitle: "commit one separately",
    });

    await controller.addToArc({ cwd: replacement.root, harness: "codex", threadId: "partial-thread", paths: ["three.txt"] });
    await write(replacement.root, "one.txt", "replace one\n");
    await write(replacement.root, "two.txt", "rescind two\n");
    await write(replacement.root, "three.txt", "commit three\n");
    const replaceTarget = await propose(replacement.root, ["one.txt"], "replace target");
    const rescindTarget = await propose(replacement.root, ["two.txt"], "rescind target");
    const commitTarget = await propose(replacement.root, ["three.txt"], "commit target");
    const committed = await controller.commitProposal({
      cwd: replacement.root, harness: "codex", threadId: "partial-thread",
      proposalId: commitTarget.proposalId, title: "commit target", description: "", includeNewer: false,
    });
    const replacementPlan = await controller.createPlan({
      cwd: replacement.root, harness: "codex", threadId: "partial-thread",
      intentName: "replace prior proposals", paths: ["one.txt", "two.txt"],
    });
    await controller.startArc({
      cwd: replacement.root, harness: "codex", threadId: "partial-thread", checkpointCommit: replacementPlan.checkpointCommit,
    });

    for (const branch of [empty, legacy, diagnostics, workspace, adoption, remote, claims, status, partial, retained, replacement]) {
      await runGit(["fsck", "--strict"], { cwd: branch.root });
    }
    return {
      registry: { root: registry.relativeRoot },
      empty: { root: empty.relativeRoot },
      legacy: { root: legacy.relativeRoot, legacyCommit },
      diagnostics: { root: diagnostics.relativeRoot, planCheckpoint: comparisonPlan.checkpointCommit, planHead, relevantCommit, addedPaths },
      workspace: { root: workspace.relativeRoot },
      adoption: { root: adoption.relativeRoot },
      remote: { root: remote.relativeRoot },
      claims: { root: claims.relativeRoot },
      status: { root: status.relativeRoot, proposalId: statusProposal.proposalId },
      partial: { root: partial.relativeRoot, firstProposalId: firstProposal.proposalId, secondProposalId: secondProposal.proposalId },
      retained: { root: retained.relativeRoot, proposalId: retainedProposal.proposalId },
      replacement: {
        root: replacement.relativeRoot, replaceTargetProposalId: replaceTarget.proposalId,
        rescindTargetProposalId: rescindTarget.proposalId, commitTargetProposalId: commitTarget.proposalId,
        committedSha: committed.committedSha!,
      },
    };
  },
} satisfies GitTestFixtureSpec<object>;

export type ControllerFixtureState = Awaited<ReturnType<typeof CONTROLLER_OPERATIONS_FIXTURE.prepare>>;
