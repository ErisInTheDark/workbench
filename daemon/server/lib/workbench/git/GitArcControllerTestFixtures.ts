/*
 * Exports:
 * - CONTROLLER_BASE_FIXTURE: basic two-file controller repository.
 * - CONTROLLER_PARTIAL_READY_FIXTURE: existing active two-file fixture for other consumers.
 * - CONTROLLER_OPERATIONS_FIXTURE: shared prepared histories for the controller battery.
 * - ControllerFixtureState: branch paths and prepared checkpoint/proposal identities.
 * - STACK_OPERATIONS_FIXTURE/StackFixtureState: prepared stack layer branches and their proposal identities.
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
  revision: 2,
} satisfies GitTestFixtureSpec<{ planCheckpoint: string; repositoryHead: string }>;

export const CONTROLLER_OPERATIONS_FIXTURE = {
  commits: CONTROLLER_BASE_FIXTURE.commits,
  name: "controller-shared-states",
  revision: 9,
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
      amend: true, amendProposalId: firstProposal.proposalId, paths: ["one.txt"],
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

export const STACK_OPERATIONS_FIXTURE = {
  commits: CONTROLLER_BASE_FIXTURE.commits,
  name: "stack-shared-states",
  revision: 7,
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const controller = new WorkbenchGitCheckpointController();
    const fork = async (name: string, source = repositoryRoot) => {
      const root = path.join(bundleRoot, `r/${name}`);
      await fs.cp(source, root, { recursive: true, errorOnExist: true, force: false });
      return root;
    };
    const propose = async (cwd: string, threadId: string, file: string, content: string, title: string) => {
      await write(cwd, file, content);
      return (await controller.createProposal({ cwd, threadId, paths: [file], title, description: "" })).proposalId;
    };
    const relative = (root: string) => path.relative(bundleRoot, root);

    // owner: "first" sealed in "layer one"; other: unrelated live claims that could adopt owner.
    const sealed = await fork("sealed");
    await controller.createAndStartPlan({ cwd: sealed, threadId: "owner", intentName: "stacked work", paths: ["one.txt"] });
    await controller.createAndStartPlan({ cwd: sealed, threadId: "other", intentName: "other work", paths: ["two.txt"] });
    const lower = await propose(sealed, "owner", "one.txt", "first\n", "first");
    await controller.stackArc({ cwd: sealed, threadId: "owner", title: "layer one" });

    // stacked: "second" pending on top of the sealed layer.
    const stacked = await fork("stacked", sealed);
    const upper = await propose(stacked, "owner", "one.txt", "second\n", "second");

    // broken: someone else commits the sealed path before the layer lands.
    const broken = await fork("broken", stacked);
    await write(broken, "one.txt", "someone else\n");
    await runGit(["commit", "--quiet", "-am", "outside"], { cwd: broken });

    // amended: an amend of committed work sealed, with "stacked" pending above it.
    const amended = await fork("amended");
    await controller.createAndStartPlan({ cwd: amended, threadId: "owner", intentName: "stacked amend", paths: ["one.txt"] });
    const original = await propose(amended, "owner", "one.txt", "first\n", "first");
    // Still-dirty claims keep the arc active after the original lands.
    await write(amended, "one.txt", "amended\n");
    await controller.commitProposal({ cwd: amended, threadId: "owner", proposalId: original, title: "first", description: "", includeNewer: false });
    const amendment = (await controller.createProposal({
      cwd: amended, threadId: "owner", amend: true, amendProposalId: original, paths: ["one.txt"],
      title: "first amended", description: "", freshTitle: "first follow-up",
    })).proposalId;
    await controller.stackArc({ cwd: amended, threadId: "owner", title: "amend layer" });
    const amendedUpper = await propose(amended, "owner", "one.txt", "stacked\n", "stacked");

    // transfer: the child received three.txt on parent layer one; the parent then sealed two.txt in layer two.
    const transfer = await fork("transfer");
    await controller.createAndStartPlan({ cwd: transfer, threadId: "parent", intentName: "parent work", paths: ["one.txt", "two.txt", "three.txt"] });
    const transferLower = await propose(transfer, "parent", "one.txt", "parent one\n", "parent one");
    await controller.stackArc({ cwd: transfer, threadId: "parent", title: "layer one" });
    await write(transfer, "three.txt", "child start\n");
    await (await controller.prepareReleaseToChild({
      cwd: transfer, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["three.txt"],
    })).apply();
    const transferUpper = await propose(transfer, "parent", "two.txt", "parent two\n", "parent two");
    await controller.stackArc({ cwd: transfer, threadId: "parent", title: "layer two" });

    // sibling: "first" sealed in "layer one"; then an outside commit changes the unsealed, unclaimed two.txt.
    const sibling = await fork("sibling");
    await controller.createAndStartPlan({ cwd: sibling, threadId: "owner", intentName: "stacked work", paths: ["one.txt"] });
    const siblingLower = await propose(sibling, "owner", "one.txt", "first\n", "first");
    await controller.stackArc({ cwd: sibling, threadId: "owner", title: "layer one" });
    await write(sibling, "two.txt", "sibling\n");
    await runGit(["commit", "--quiet", "-m", "sibling", "--", "two.txt"], { cwd: sibling });

    for (const root of [sealed, stacked, broken, amended, transfer, sibling]) await runGit(["fsck", "--strict"], { cwd: root });
    return {
      sealed: { root: relative(sealed), lower },
      stacked: { root: relative(stacked), lower, upper },
      broken: { root: relative(broken), upper },
      amended: { root: relative(amended), amendment, upper: amendedUpper },
      transfer: { root: relative(transfer), lower: transferLower, upper: transferUpper },
      sibling: { root: relative(sibling), lower: siblingLower },
    };
  },
} satisfies GitTestFixtureSpec<object>;

export type StackFixtureState = Awaited<ReturnType<typeof STACK_OPERATIONS_FIXTURE.prepare>>;
