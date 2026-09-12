/* No production exports. Shared-state batteries protect ownership, diagnostics, read purity, acceptance and atomic publication with real Git. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import GitArcPublishState from "./GitArcPublishState";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { GitArcProposalAlreadyCommittedError } from "workbench-shared/workbench/git/git-arc-failures";
import createGitArcStartDiagnosticError, { GitArcStartDiagnosticError } from "./git-arc-start-diagnostics";
import { GitCheckpointDirtyPathsError } from "./GitArcPlanController";
import GitArcRegistry, { GitArcCollisionError } from "./GitArcRegistry";
import GitCheckpointStore, { GitCheckpointMissingObjectError } from "./GitCheckpointStore";
import GitTestFixtureCache, { type GitTestFixtureCopy } from "./GitTestFixtureCache";
import { CONTROLLER_OPERATIONS_FIXTURE, type ControllerFixtureState } from "./GitArcControllerTestFixtures";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";

const execFileAsync = promisify(execFile);
const fixtureCache = new GitTestFixtureCache();
type ControllerFixture = GitTestFixtureCopy<ControllerFixtureState>;
type ControllerBranch<Key extends keyof ControllerFixtureState> = {
  repository: WorkbenchGitRepository;
  root: string;
  source: string;
  state: ControllerFixtureState[Key];
};
const controllerCases = new Map<keyof ControllerFixtureState, {
  name: string;
  run: (fixture: ControllerFixture, context: TestContext) => Promise<void>;
}>();

function controllerTest<Key extends keyof ControllerFixtureState>(
  key: Key,
  name: string,
  run: (fixture: ControllerBranch<Key>, context: TestContext) => Promise<void>,
) {
  controllerCases.set(key, {
    name,
    run: async (fixture, context) => {
      const state = fixture.state[key];
      const source = path.join(fixture.bundleRoot, state.root);
      await run({ repository: new WorkbenchGitRepository(source), root: fixture.bundleRoot, source, state }, context);
    },
  });
}

async function checkClaimLoss({ source }: ControllerBranch<"workspace">) {
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: source, harness: "codex" as const, threadId: "adopt-thread" };
  await fs.writeFile(path.join(source, "one.txt"), "boundary\n");
  await controller.releaseArc({ ...identity, disown: true });
  assert.deepEqual((await controller.compare(identity)).changes, []);
  await fs.writeFile(path.join(source, "one.txt"), "after boundary\n");
  await fs.writeFile(path.join(source, "two.txt"), "unrelated\n");
  const snapshot = await controller.createInspectionSnapshot(source);
  const [comparison, diff, explicitDiff] = await Promise.all([
    controller.compare(identity, snapshot),
    controller.diff(identity, snapshot),
    controller.diff({ ...identity, paths: ["one.txt"] }, snapshot),
  ]);
  assert.deepEqual(comparison.changes.map(({ path }) => path), ["one.txt"]);
  assert.match(diff.diff, /-boundary\n\+after boundary/u);
  assert.doesNotMatch(diff.diff, /unrelated/u);
  assert.equal(explicitDiff.diff, diff.diff);
}

controllerTest("status", "status and proposal reads preserve pending state, materialisation boundaries and accepted receipts", async (fixture) => {
  const { repository, source, state } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: source, harness: "codex" as const, threadId: "partial-thread" };
  const proposal = { proposalId: state.proposalId };
  const before = await repository.listRefsWithValues("refs/worktree");
  const pending = await controller.readStatus(identity);
  assert.deepEqual(pending.pending, [{ proposalId: proposal.proposalId, title: "change one" }]);
  assert.deepEqual(pending.dirtyClaims, ["one.txt"]);
  assert.deepEqual(pending.cleanClaims, ["two.txt"]);
  assert.deepEqual(await repository.listRefsWithValues("refs/worktree"), before);
  await fs.writeFile(path.join(source, "one.txt"), "one\n");
  assert.deepEqual((await controller.readStatus(identity)).pending, []);
  await fs.writeFile(path.join(source, "one.txt"), "proposed content\n");
  await checkProposalReadPurity(fixture);
  const acceptedHead = await repository.currentHead();
  const accepted = await controller.readStatus(identity);
  assert.deepEqual(accepted.accepted, [{ proposalId: proposal.proposalId, title: "change one", commitSha: acceptedHead }]);
  assert.deepEqual(accepted.recovery[0]?.comparison, []);
  assert.deepEqual(accepted.recovery[0]?.commits, []);
  await controller.createPlan({ ...identity, intentName: "next", paths: ["two.txt"] });
  assert.deepEqual((await controller.readStatus(identity)).accepted, accepted.accepted);
  await controller.startArc(identity);
  const restarted = await controller.readStatus(identity);
  assert.deepEqual(restarted.accepted, []);
  assert.deepEqual(restarted.recovery, []);
});

controllerTest("workspace", "workspace status, recent dirt and claim loss reuse one ownership history", async (fixture) => {
  const { source } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  const other = { cwd: source, harness: "codex" as const, threadId: "adopt-thread" };
  await fs.writeFile(path.join(source, "one.txt"), "other work\n");
  await fs.mkdir(path.join(source, "nested"));
  await fs.writeFile(path.join(source, "nested", "child.txt"), "owned child\n");
  await fs.rm(path.join(source, "two.txt"));
  await fs.writeFile(path.join(source, "old.txt"), "old\n");
  await fs.utimes(path.join(source, "old.txt"), new Date(0), new Date(0));
  const status = await controller.readStatus({ ...other, threadId: "no-lifecycle" });
  assert.deepEqual(status.unclaimedDirt, ["old.txt", "two.txt"]);
  assert.deepEqual(status.dirtyClaims, []);
  assert.deepEqual(status.recovery, []);
  assert.deepEqual((await controller.readStatus(other)).dirtyClaims, ["nested", "one.txt"]);
  await checkRecentWorkspaceDirt(fixture);
  await checkClaimLoss(fixture);
});

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

async function advanceHead(repository: WorkbenchGitRepository, message: string) {
  const head = await repository.currentHead();
  const headRef = await repository.symbolicHead();
  assert.ok(headRef);
  const commit = await repository.createCommitFromTree(await repository.resolveTree(head), head, message);
  await repository.updateRefs([{ newValue: commit, oldValue: head, ref: headRef }]);
  return commit;
}

controllerTest("registry", "registry ownership preserves overlap, release, idempotence and stale-replacement safeguards", async ({ repository, source }) => {
  const registry = new GitArcRegistry(repository);
  const checkpointCommit = await repository.currentHead();
  const contenders = await Promise.allSettled([
    registry.claim({
      checkpointCommit,
      claimedPaths: ["one.txt"],
      harness: "codex",
      intentDescription: "",
      intentName: "change one",
      proposalId: null,
      threadId: "thread-one",
    }),
    new GitArcRegistry(repository).claim({
      checkpointCommit,
      claimedPaths: ["one.txt"],
      harness: "opencode",
      intentDescription: "",
      intentName: "change one too",
      proposalId: null,
      threadId: "thread-two",
    }),
  ]);
  assert.equal(contenders.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(contenders.filter(({ status }) => status === "rejected").length, 1);
  const owner = (await registry.list())[0]!;
  await assert.rejects(registry.claim({
    checkpointCommit,
    claimedPaths: ["one.txt", "two.txt"],
    harness: "codex",
    intentDescription: "inspect overlap",
    intentName: "change both",
    proposalId: null,
    threadId: "thread-three",
  }), /overlap active sibling work.*one\.txt/u);

  await registry.claim({
    checkpointCommit,
    claimedPaths: ["two.txt"],
    harness: "codex",
    intentDescription: "change the independent file",
    intentName: "change two",
    proposalId: null,
    threadId: "thread-three",
  });
  assert.equal((await registry.read()).state.entries.length, 2);
  await registry.release({ harness: owner.harness, threadId: owner.threadId });
  assert.equal(await registry.find({ harness: owner.harness, threadId: owner.threadId }), null);
  assert.equal(await fs.readFile(path.join(source, "one.txt"), "utf8"), "one\n");
  await checkRegistryRetries(repository);
});

async function checkRegistryRetries(repository: WorkbenchGitRepository) {
  const registry = new GitArcRegistry(repository);
  const initialCheckpoint = await repository.currentHead();
  const initial = await registry.claim({
    checkpointCommit: initialCheckpoint,
    claimedPaths: ["two.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "change one",
    proposalId: null,
    threadId: "thread-three",
  });
  assert.deepEqual(await registry.claim({
    checkpointCommit: initialCheckpoint,
    claimedPaths: ["two.txt"],
    harness: "codex",
    intentDescription: "ignored retry text",
    intentName: "ignored retry name",
    proposalId: null,
    threadId: "thread-three",
  }), initial);
  await assert.rejects(registry.claim({
    checkpointCommit: "1".repeat(40),
    claimedPaths: ["two.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "different arc",
    proposalId: null,
    threadId: "thread-three",
  }), /already owns a different active Git arc/u);

  const replacement = await registry.prepareClaim({
    checkpointCommit: "2".repeat(40),
    claimedPaths: ["two.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "continued arc",
    proposalId: null,
    threadId: "thread-three",
  }, { expectedCheckpointCommit: initialCheckpoint });
  assert.ok(replacement.updates.length);
  await repository.updateRefs(replacement.updates);
  await assert.rejects(registry.prepareClaim({
    checkpointCommit: "3".repeat(40),
    claimedPaths: ["two.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "stale continuation",
    proposalId: null,
    threadId: "thread-three",
  }, { expectedCheckpointCommit: initialCheckpoint }), /active Git arc changed/u);
}

async function checkRemoteFailures(local: ControllerBranch<"remote">) {
  await git(local.source, ["remote", "set-url", "origin", path.join(local.root, "missing.git")]);
  const state = await new GitArcPublishState(local.repository).classifyCurrentHead();
  assert.equal(state.kind, "unknown");
  if (state.kind === "unknown") assert.match(state.reason, /Unable to refresh remote refs/u);
  await git(local.source, ["checkout", "--detach", "--quiet"]);
  assert.deepEqual(await new GitArcPublishState(local.repository).classifyCurrentHead(), { kind: "detached" });
}

controllerTest("empty", "empty and ignored plans preserve visibility and no-op boundaries", async ({ source }) => {
  const controller = new WorkbenchGitCheckpointController();
  const plan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "empty diagnostic plan",
    paths: [],
    threadId: "empty-plan-thread",
  });

  assert.deepEqual(plan.scopePaths, []);
  const states = await controller.listPlanStates({ cwd: source });
  assert.equal(states.length, 1);
  assert.deepEqual(states[0], {
    checkpointCommit: plan.checkpointCommit,
    harness: "codex",
    intentDescription: "",
    intentName: "empty diagnostic plan",
    scopePaths: [],
    threadId: "empty-plan-thread",
    updatedAt: states[0]?.updatedAt,
  });
  await assert.rejects(controller.startArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "empty-plan-thread",
  }), (error: Error) => {
    assert.ok(error instanceof GitArcRejectionError);
    assert.deepEqual(error.rejection, { reason: "emptyPlan" });
    return true;
  });
  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  const ignoredPlan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "skip ignored plan",
    paths: ["ignored/generated.ts"],
    threadId: "ignored-plan-thread",
  });
  assert.equal(ignoredPlan.kind, "noop");
  assert.equal(ignoredPlan.noOp, true);
  assert.equal(ignoredPlan.checkpointCommit, "");
  assert.equal(ignoredPlan.repoRoot, source);
  assert.deepEqual(ignoredPlan.scopePaths, []);
  assert.deepEqual(ignoredPlan.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.equal(await controller.findPlanState({
    cwd: source, harness: "codex", threadId: "ignored-plan-thread",
  }), null);
  const ignoredStart = await controller.createAndStartPlan({
    cwd: source,
    harness: "codex",
    intentName: "skip ignored plan start",
    paths: ["ignored/generated.ts"],
    threadId: "ignored-plan-start-thread",
  });
  assert.equal(ignoredStart.kind, "noop");
  assert.deepEqual(ignoredStart.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.equal(await controller.findLifecycleState({
    cwd: source, harness: "codex", threadId: "ignored-plan-start-thread",
  }), null);

  const mixedStart = await controller.createAndStartPlan({
    cwd: source,
    harness: "codex",
    intentName: "skip ignored start member",
    paths: ["ignored/generated.ts", "two.txt"],
    threadId: "mixed-plan-start-thread",
  });
  assert.equal(mixedStart.kind, "arc");
  assert.deepEqual(mixedStart.scopePaths, ["two.txt"]);
  assert.deepEqual(mixedStart.skippedIgnoredPaths, ["ignored/generated.ts"]);

  const mixedPlan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "skip ignored plan member",
    paths: ["ignored/generated.ts", "one.txt"],
    threadId: "mixed-plan-thread",
  });
  assert.equal(mixedPlan.kind, "plan");
  assert.deepEqual(mixedPlan.scopePaths, ["one.txt"]);
  assert.deepEqual(mixedPlan.skippedIgnoredPaths, ["ignored/generated.ts"]);
});

controllerTest("legacy", "v3 plans and legacy activation preserve adoption, drift and ownership", async ({ repository, source, state }) => {
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "duplicate.txt"), "intentional duplicate work\n");
  const duplicate = await controller.createPlan({
    adoptPaths: ["duplicate.txt"],
    cwd: source,
    harness: "codex",
    intentName: "duplicate adoption",
    paths: ["duplicate.txt"],
    threadId: "overlap-thread",
  });
  const duplicateCheckpoint = await new GitCheckpointStore(repository).readCheckpoint("codex", "overlap-thread", duplicate.checkpointCommit);
  assert.deepEqual(duplicateCheckpoint.metadata?.scopePaths, ["duplicate.txt"]);
  assert.deepEqual(duplicateCheckpoint.metadata?.adoptedPaths, ["duplicate.txt"]);
  await fs.mkdir(path.join(source, "folder"));
  await fs.writeFile(path.join(source, "folder", "file.txt"), "intentional nested work\n");
  const nested = await controller.createPlan({
    adoptPaths: ["folder/file.txt"],
    cwd: source,
    harness: "codex",
    intentName: "nested adoption",
    paths: ["folder"],
    threadId: "nested-adoption-thread",
  });
  const nestedCheckpoint = await new GitCheckpointStore(repository).readCheckpoint("codex", "nested-adoption-thread", nested.checkpointCommit);
  assert.deepEqual(nestedCheckpoint.metadata?.scopePaths, ["folder"]);
  assert.deepEqual(nestedCheckpoint.metadata?.adoptedPaths, ["folder/file.txt"]);
  const reverseNested = await controller.createPlan({
    adoptPaths: ["folder"],
    cwd: source,
    harness: "codex",
    intentName: "reverse nested adoption",
    paths: ["folder/file.txt"],
    threadId: "reverse-nested-adoption-thread",
  });
  const reverseNestedCheckpoint = await new GitCheckpointStore(repository).readCheckpoint(
    "codex",
    "reverse-nested-adoption-thread",
    reverseNested.checkpointCommit,
  );
  assert.deepEqual(reverseNestedCheckpoint.metadata?.scopePaths, ["folder"]);
  assert.deepEqual(reverseNestedCheckpoint.metadata?.adoptedPaths, ["folder"]);
  await assert.rejects(controller.removeFromPlan({
    cwd: source,
    harness: "codex",
    paths: ["folder/file.txt"],
    threadId: "nested-adoption-thread",
  }), (error: unknown) => {
    assert(error instanceof GitCheckpointDirtyPathsError);
    assert.deepEqual(error.dirtyPaths, ["folder/file.txt"]);
    return true;
  });
  const startedNested = await controller.startArc({
    checkpointCommit: nested.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "nested-adoption-thread",
  });
  assert.deepEqual(startedNested.scopePaths, ["folder"]);
  const startedNestedEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "nested-adoption-thread" });
  assert.equal(startedNestedEntry?.phase, "active");
  assert.deepEqual(startedNestedEntry?.claimedPaths, ["folder"]);
  await assert.rejects(controller.startArc({
    checkpointCommit: "deadbeef",
    cwd: source,
    harness: "codex",
    threadId: "missing-ref-thread",
  }), (error: unknown) => {
    assert(error instanceof GitCheckpointMissingObjectError);
    assert.equal(error.requestedRef, "deadbeef");
    return true;
  });
  await assert.rejects(controller.createPlan({
    adoptPaths: ["one.txt"],
    cwd: source,
    harness: "codex",
    intentName: "clean adoption",
    paths: [],
    threadId: "clean-thread",
  }), /clean against current HEAD/u);
  const original = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "fresh plan",
    paths: ["one.txt"],
    threadId: "preserved-plan-thread",
  });
  await fs.rm(path.join(source, "one.txt"));
  await git(source, ["add", "-A"]);
  await git(source, ["commit", "--quiet", "-m", "delete planned one"]);
  const causalCommit = await repository.currentHead();
  const replacement = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "restate the plan",
    paths: ["one.txt"],
    threadId: "preserved-plan-thread",
  });
  assert.deepEqual(replacement.planningDrift?.paths, ["one.txt"]);
  assert.equal(replacement.planningDrift?.previousRef, original.checkpointCommit);
  const replacementCheckpoint = await new GitCheckpointStore(repository).readCheckpoint(
    "codex",
    "preserved-plan-thread",
    replacement.checkpointCommit,
  );
  assert.equal(replacementCheckpoint.parent, causalCommit);
  const historical = await controller.diff({
    cwd: source,
    harness: "codex",
    paths: ["one.txt"],
    ref: original.checkpointCommit,
    threadId: "preserved-plan-thread",
  });
  assert.match(historical.diff, /deleted file/u);
  const refreshed = await controller.addToPlan({
    cwd: source,
    harness: "codex",
    paths: ["one.txt"],
    threadId: "preserved-plan-thread",
  });
  assert.deepEqual(refreshed.scopePaths, ["one.txt"]);
  assert.deepEqual(refreshed.planningDrift?.paths, []);
  await controller.startArc({
    checkpointCommit: refreshed.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "preserved-plan-thread",
  });

  await fs.writeFile(path.join(source, "one.txt"), "legacy implementation\n");
  await fs.writeFile(path.join(source, "two.txt"), "legacy implementation\n");
  const adopted = await controller.startArc({
    checkpointCommit: state.legacyCommit,
    cwd: source,
    harness: "opencode",
    threadId: "legacy-thread",
  });
  assert.deepEqual(adopted.changes.map((change) => change.path), ["two.txt"]);
  const active = await new GitArcRegistry(repository).find({ harness: "opencode", threadId: "legacy-thread" });
  assert.equal(active?.checkpointCommit, state.legacyCommit);
  assert.deepEqual(active?.claimedPaths, ["two.txt"]);
});

controllerTest("diagnostics", "activation diagnostics preserve scoped drift, causal history and collision precedence", async (fixture) => {
  const { source, state } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  const identity = { cwd: source, harness: "codex" as const, threadId: "comparison-thread" };
  const plan = { checkpointCommit: state.planCheckpoint };
  const addedPaths = state.addedPaths;

  const compared = await controller.compare({ ...identity, ref: plan.checkpointCommit });
  await assert.rejects(controller.startArc(identity), (error: unknown) => {
    assert(error instanceof GitArcStartDiagnosticError);
    assert.deepEqual(error.details.comparison, compared.changes.map(({ diff, ...change }) => ({
      ...change, kind: change.kind.type, binary: change.path === "nested/data.bin",
    })));
    const additions = compared.changes.reduce((sum, change) => sum + change.additions, 0);
    const deletions = compared.changes.reduce((sum, change) => sum + change.deletions, 0);
    assert.equal(additions, 28);
    assert.equal(deletions, 3);
    assert.match(error.message, /total \+28 -3 \(31 changed lines\)/u);
    for (const filePath of addedPaths) assert.ok(error.message.includes(filePath));
    assert.doesNotMatch(error.message, /unrelated\.txt|patch-only-secret|GIT binary patch/u);
    assert.match(error.message, /nested\/data\.bin[^\n]*binary/u);
    return true;
  });
  await fs.writeFile(path.join(source, "one.txt"), "committed\npatch-only-secret\n");
  await fs.writeFile(path.join(source, "two.txt"), "two\n");
  await checkCausalDiagnostics(fixture);
});

async function checkCausalDiagnostics({ repository, source, state }: ControllerBranch<"diagnostics">) {
  const planPaths = ["claimed-dirty.txt", "one.txt", "three.txt", "two.txt"];
  const { planHead, relevantCommit } = state;

  await new GitArcRegistry(repository).claim({
    checkpointCommit: await repository.currentHead(),
    claimedPaths: ["claimed-dirty.txt", "two.txt"],
    harness: "opencode",
    intentDescription: "",
    intentName: "claim sibling paths",
    proposalId: null,
    threadId: "sibling-thread",
  });
  await fs.writeFile(path.join(source, "claimed-dirty.txt"), "owned dirt\n");
  await fs.writeFile(path.join(source, "three.txt"), "adoptable dirt\n");

  const currentHead = await repository.currentHead();
  const currentTree = await repository.writeScopedWorktreeTree(planPaths);
  const snapshotDrift = await repository.listChangedPaths(planHead, currentTree, planPaths);
  const error = await createGitArcStartDiagnosticError({
    adoptedPaths: [],
    currentHead,
    currentTree,
    harness: "codex",
    planBaseCommit: planHead,
    planCheckpointCommit: planHead,
    planPaths,
    registryEntries: await new GitArcRegistry(repository).list(),
    repository,
    snapshotDrift,
    threadId: "target-thread",
  });
  assert(error instanceof GitArcStartDiagnosticError);
  assert.deepEqual(error.details.dirtyUnclaimedPaths, ["three.txt"]);
  assert.deepEqual(error.details.collisions.map(({ entry }) => entry.threadId), ["sibling-thread"]);
  assert.match(error.message, /New commits affecting planned files:/u);
  assert.match(error.message, new RegExp(`${relevantCommit.slice(0, 8)}[^\\n]*change planned one[\\s\\S]*one\\.txt`, "u"));
  assert.doesNotMatch(error.message, /unrelated housekeeping|unrelated\.txt/u);
  assert.match(error.message, /Planned paths claimed by other arcs:[\s\S]*opencode\/sibling-thread[\s\S]*claim sibling paths/u);
  assert.match(error.message, /claims `two\.txt` through planned path `two\.txt`/u);
  assert.match(error.message, /claims `claimed-dirty\.txt` through planned path `claimed-dirty\.txt`/u);
  assert.deepEqual(error.details.dirtyUnclaimedPaths, ["three.txt"]);

  const controller = new WorkbenchGitCheckpointController();
  const claimedPlan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "start claimed path",
    paths: ["claimed-dirty.txt"],
    threadId: "target-thread",
  });
  const assertSiblingCollision = (collisionError: unknown) => {
    assert(collisionError instanceof GitArcCollisionError);
    assert.equal(collisionError.collisions[0]?.entry.threadId, "sibling-thread");
    assert.deepEqual(collisionError.collisions[0]?.overlaps, [{
      claimedPath: "claimed-dirty.txt",
      requestedPath: "claimed-dirty.txt",
    }]);
    return true;
  };
  const baseline = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "target-thread" });
  await fs.writeFile(path.join(source, "claimed-dirty.txt"), "sibling changed this after publication\n");
  await assert.rejects(controller.startArc({
    checkpointCommit: claimedPlan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "target-thread",
  }), assertSiblingCollision);
  await assert.rejects(controller.createAndStartPlan({
    cwd: source,
    harness: "codex",
    intentName: "start sibling-owned dirt",
    paths: ["claimed-dirty.txt"],
    threadId: "direct-start-thread",
  }), assertSiblingCollision);
  await assert.rejects(controller.adoptIntoPlan({
    cwd: source,
    harness: "codex",
    paths: ["claimed-dirty.txt"],
    threadId: "target-thread",
  }), assertSiblingCollision);
  await controller.createAndStartPlan({
    cwd: source,
    harness: "codex",
    intentName: "extend active claim",
    paths: ["unrelated.txt"],
    threadId: "add-thread",
  });
  await assert.rejects(controller.addToArc({
    cwd: source,
    harness: "codex",
    paths: ["claimed-dirty.txt"],
    threadId: "add-thread",
  }), assertSiblingCollision);
  assert.deepEqual(await new GitArcRegistry(repository).find({ harness: "codex", threadId: "target-thread" }), baseline);
  await new GitArcRegistry(repository).release({ harness: "opencode", threadId: "sibling-thread" });
  await assert.rejects(controller.startArc({
    checkpointCommit: claimedPlan.checkpointCommit, cwd: source, harness: "codex", threadId: "target-thread",
  }), (failure: unknown) => {
    assert(failure instanceof GitArcStartDiagnosticError);
    assert.deepEqual(failure.details.collisions, []);
    assert.deepEqual(failure.details.snapshotDrift, ["claimed-dirty.txt"]);
    return true;
  });
  assert.deepEqual(await new GitArcRegistry(repository).find({ harness: "codex", threadId: "target-thread" }), baseline);
  assert.match(error.message, /git_arc_wait/u);
  assert.doesNotMatch(error.message, /git_arc_diff|git_plan_claims|git_plan_start/u);
  const identity = { cwd: source, harness: "codex" as const, threadId: "historical-start-thread" };
  const arc = await controller.createAndStartPlan({ ...identity, intentName: "historical activation", paths: ["one.txt"] });
  const registry = new GitArcRegistry(repository);
  await registry.release(identity);
  await controller.createAndStartPlan({ cwd: source, harness: "codex", threadId: "historical-sibling", intentName: "sibling work", paths: ["one.txt"] });
  await fs.writeFile(path.join(source, "one.txt"), "sibling changed the historical snapshot\n");
  await assert.rejects(controller.startArc({ ...identity, checkpointCommit: arc.checkpointCommit }), GitArcCollisionError);
  assert.equal(await registry.find(identity), null);
  await registry.release({ harness: "codex", threadId: "historical-sibling" });
  await assert.rejects(controller.startArc({ ...identity, checkpointCommit: arc.checkpointCommit }), GitArcStartDiagnosticError);
  assert.equal(await registry.find(identity), null);
}

controllerTest("adoption", "adoption preserves snapshot, ignored-deletion, index and collision boundaries", async (fixture) => {
  const { repository, source } = fixture;
  await checkLiveClaims(source);
  await checkInspectionSnapshot(source);
  await fs.writeFile(path.join(source, "one.txt"), "one\n");
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "two.txt"), "modified two\n");
  await fs.rm(path.join(source, "deleted.txt"));
  await fs.writeFile(path.join(source, "untracked.txt"), "new work\n");
  await fs.writeFile(path.join(source, "staged.txt"), "staged work\n");
  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\nignored-delete/\n", "utf8");
  await git(source, ["add", "staged.txt"]);
  const [stagedBefore, activeBeforeIgnoredAdopt] = await Promise.all([
    git(source, ["diff", "--cached", "--binary"]),
    new GitArcRegistry(repository).find({ harness: "codex", threadId: "adopt-thread" }),
  ]);
  const ignoredAdoption = await controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["ignored/generated.ts"],
    threadId: "adopt-thread",
  });
  assert.equal(ignoredAdoption.kind, "noop");
  assert.deepEqual(ignoredAdoption.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.deepEqual(
    await new GitArcRegistry(repository).find({ harness: "codex", threadId: "adopt-thread" }),
    activeBeforeIgnoredAdopt,
  );

  const adopted = await controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["two.txt", "deleted.txt", "ignored/generated.ts", "untracked.txt"],
    threadId: "adopt-thread",
  });
  assert.deepEqual(adopted.scopePaths, ["deleted.txt", "one.txt", "two.txt", "untracked.txt"]);
  assert.deepEqual(adopted.skippedIgnoredPaths, ["ignored/generated.ts"]);
  const [active, checkpointRef, two, untracked, , stagedAfter, compared] = await Promise.all([
    new GitArcRegistry(repository).find({ harness: "codex", threadId: "adopt-thread" }),
    repository.readRef(adopted.checkpointRef),
    fs.readFile(path.join(source, "two.txt"), "utf8"),
    fs.readFile(path.join(source, "untracked.txt"), "utf8"),
    assert.rejects(fs.access(path.join(source, "deleted.txt"))),
    git(source, ["diff", "--cached", "--binary"]),
    controller.compare({ cwd: source, harness: "codex", threadId: "adopt-thread" }),
  ]);
  assert.equal(active?.checkpointCommit, adopted.checkpointCommit);
  assert.equal(checkpointRef, adopted.checkpointCommit);
  assert.equal(two, "modified two\n");
  assert.equal(untracked, "new work\n");
  assert.equal(stagedAfter, stagedBefore);
  assert.deepEqual(compared.changes.map((change) => change.path), ["deleted.txt", "two.txt", "untracked.txt"]);
  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["staged.txt"],
    threadId: "missing-thread",
  }), /does not own an active Git arc/u);
  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["one.txt"],
    threadId: "adopt-thread",
  }), /Adoption requires unclaimed paths/u);
  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["clean-missing.txt"],
    threadId: "adopt-thread",
  }), /Adoption requires dirty unclaimed paths: clean-missing\.txt/u);

  const ignoredDeletionProposal = await controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    threadId: "ignored-deletion-thread",
    title: "ignore and delete tracked file",
  });
  const pendingIgnoredDeletion = await controller.getProposal({
    cwd: source,
    harness: "codex",
    includeNewer: false,
    proposalId: ignoredDeletionProposal.proposalId,
    threadId: "ignored-deletion-thread",
  });
  assert.deepEqual(pendingIgnoredDeletion.changes.map(({ kind, path: filePath }) => ({
    path: filePath,
    type: kind.type,
  })), [
    { path: ".gitignore", type: "add" },
    { path: "ignored-delete/environment.toml", type: "delete" },
  ]);
  const committedIgnoredDeletion = await controller.commitProposal({
    cwd: source,
    description: "",
    harness: "codex",
    includeNewer: false,
    proposalId: ignoredDeletionProposal.proposalId,
    threadId: "ignored-deletion-thread",
    title: "ignore and delete tracked file",
  });
  assert.equal(committedIgnoredDeletion.status, "committed");
  assert.deepEqual(await repository.listTreePaths("HEAD", [".gitignore", "ignored-delete"]), [".gitignore"]);
  assert.equal(await git(source, ["status", "--short", "--", ".gitignore", "ignored-delete/environment.toml"]), "");
  const resolvedIgnoredDeletion = await new GitArcRegistry(repository).find({
    harness: "codex",
    threadId: "ignored-deletion-thread",
  });
  assert.equal(resolvedIgnoredDeletion?.phase, "resolved");
  assert.deepEqual(resolvedIgnoredDeletion?.claimedPaths, []);
  assert.equal(resolvedIgnoredDeletion?.proposalId, ignoredDeletionProposal.proposalId);
  assert.deepEqual(resolvedIgnoredDeletion?.proposalIds, [ignoredDeletionProposal.proposalId]);
  await checkRejectedAdoption(fixture);
});

async function checkRecentWorkspaceDirt({ source }: ControllerBranch<"workspace">) {
  const controller = new WorkbenchGitCheckpointController();
  const threadCreatedAt = Date.UTC(2026, 7, 30, 12);
  await Promise.all([
    fs.writeFile(path.join(source, "one.txt"), "owned current change\n", "utf8"),
    fs.writeFile(path.join(source, "two.txt"), "old unclaimed change\n", "utf8"),
    fs.writeFile(path.join(source, "recent.txt"), "recent unclaimed change\n", "utf8"),
    fs.writeFile(path.join(source, "sibling.txt"), "sibling-owned change\n", "utf8"),
  ]);
  await Promise.all([
    fs.utimes(path.join(source, "one.txt"), new Date(threadCreatedAt + 1_000), new Date(threadCreatedAt + 1_000)),
    fs.utimes(path.join(source, "two.txt"), new Date(threadCreatedAt - 1_000), new Date(threadCreatedAt - 1_000)),
    fs.utimes(path.join(source, "recent.txt"), new Date(threadCreatedAt + 2_000), new Date(threadCreatedAt + 2_000)),
    fs.utimes(path.join(source, "sibling.txt"), new Date(threadCreatedAt + 3_000), new Date(threadCreatedAt + 3_000)),
  ]);

  assert.deepEqual(
    await controller.listUnclaimedWorkspaceDirt({ cwd: source, modifiedSince: threadCreatedAt }),
    ["recent.txt"],
  );
}

async function checkLiveClaims(source: string) {
  const controller = new WorkbenchGitCheckpointController();
  assert.equal(await controller.hasLiveClaimsAtRepoRoot({
    cwd: source, harness: "codex", threadId: "adopt-thread",
  }), true);
  assert.equal(await controller.hasLiveClaimsAtRepoRoot({
    cwd: source, harness: "codex", threadId: "missing-thread",
  }), false);
}

async function checkInspectionSnapshot(source: string) {
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "captured claimed change\n", "utf8");
  await fs.writeFile(path.join(source, "captured-unclaimed.txt"), "captured unclaimed change\n", "utf8");
  const snapshot = await controller.createInspectionSnapshot(source);
  await fs.writeFile(path.join(source, "one.txt"), "later claimed change\n", "utf8");
  await fs.writeFile(path.join(source, "later-unclaimed.txt"), "later unclaimed change\n", "utf8");

  const [comparison, unclaimedDirtPaths] = await Promise.all([
    controller.compare({
      cwd: source,
      harness: "codex",
      threadId: "adopt-thread",
    }, snapshot),
    controller.listUnclaimedWorkspaceDirt({ cwd: source, modifiedSince: 0 }, snapshot),
  ]);

  assert.match(comparison.changes[0]?.diff ?? "", /captured claimed change/u);
  assert.doesNotMatch(comparison.changes[0]?.diff ?? "", /later claimed change/u);
  assert.deepEqual(unclaimedDirtPaths, ["captured-unclaimed.txt"]);
}

async function checkRejectedAdoption({ repository, source }: ControllerBranch<"adoption">) {
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  await fs.writeFile(path.join(source, "collision.txt"), "dirty collision\n");
  const refsBefore = await repository.listRefs("refs/worktree/agents/codex/adopt-thread/checkpoints");
  const activeBefore = await registry.find({ harness: "codex", threadId: "adopt-thread" });

  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["collision.txt"],
    threadId: "adopt-thread",
  }), /overlap active sibling work/u);
  assert.deepEqual(await repository.listRefs("refs/worktree/agents/codex/adopt-thread/checkpoints"), refsBefore);
  assert.deepEqual(await registry.find({ harness: "codex", threadId: "adopt-thread" }), activeBefore);
}

controllerTest("partial", "partial acceptance, local reads and message amendments preserve claims and unrelated state", async (fixture, context) => {
  const { repository, source, state } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  const started = await registry.find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(started?.phase, "active");
  const firstProposal = { proposalId: state.firstProposalId };
  const secondProposal = { proposalId: state.secondProposalId };
  const refsBeforeScope = await repository.listRefsWithValues("refs/worktree");
  const recoveredScope = await controller.readScope({ cwd: source, harness: "codex", threadId: "partial-thread" });
  assert.deepEqual(recoveredScope?.proposals, [
    { proposalId: firstProposal.proposalId, status: "proposed" },
    { proposalId: secondProposal.proposalId, status: "proposed" },
  ]);
  assert.deepEqual(await repository.listRefsWithValues("refs/worktree"), refsBeforeScope);
  await fs.writeFile(path.join(source, "one.txt"), "newer one\n");
  const headBeforeLock = await repository.currentHead();
  const lockPath = path.resolve(source, (await git(source, ["rev-parse", "--git-path", "index.lock"])).trim());
  await fs.writeFile(lockPath, "locked\n", "utf8");
  context.after(async () => { await fs.rm(lockPath, { force: true }); });
  await assert.rejects(controller.commitProposal({
    cwd: source,
    description: "",
    harness: "codex",
    includeNewer: false,
    proposalId: firstProposal.proposalId,
    threadId: "partial-thread",
    title: "commit one",
  }), /Commit was not published[\s\S]*proposal remains pending[\s\S]*index\.lock/u);
  assert.equal(await repository.currentHead(), headBeforeLock);
  assert.equal((await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: firstProposal.proposalId, threadId: "partial-thread",
  })).status, "proposed");
  const locked = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(locked?.phase, "active");
  assert.deepEqual(locked?.claimedPaths, ["one.txt", "two.txt"]);
  await fs.rm(lockPath, { force: true });
  await controller.commitProposal({
    cwd: source,
    description: "",
    harness: "codex",
    includeNewer: false,
    proposalId: firstProposal.proposalId,
    threadId: "partial-thread",
    title: "commit one",
  });
  const [partial, one, two, compared] = await Promise.all([
    new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" }),
    fs.readFile(path.join(source, "one.txt"), "utf8"),
    fs.readFile(path.join(source, "two.txt"), "utf8"),
    controller.compare({ cwd: source, harness: "codex", threadId: "partial-thread" }),
  ]);
  assert.equal(partial?.phase, "active");
  assert.deepEqual(partial?.claimedPaths, ["one.txt", "two.txt"]);
  assert.notEqual(partial?.checkpointCommit, started?.checkpointCommit);
  assert.equal(one, "newer one\n");
  assert.equal(two, "remaining two\n");
  assert.deepEqual(compared.changes.map((change) => change.path), ["one.txt", "two.txt"]);
  const continued = await controller.continueArc({
    checkpointCommit: started!.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "partial-thread",
  });
  assert.equal(continued.checkpointCommit, partial?.checkpointCommit);
  assert.deepEqual(continued.scopePaths, ["one.txt", "two.txt"]);

  await fs.writeFile(path.join(source, "one.txt"), "committed one\n");
  await controller.commitProposal({
    cwd: source,
    description: "",
    harness: "codex",
    includeNewer: false,
    proposalId: secondProposal.proposalId,
    threadId: "partial-thread",
    title: "commit two",
  });
  const resolved = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(resolved?.phase, "resolved");
  assert.deepEqual(resolved?.claimedPaths, []);
  const completed = await controller.continueArc({
    checkpointCommit: started!.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "partial-thread",
  });
  assert.equal(completed.phase, "resolved");
  assert.deepEqual(completed.scopePaths, []);
  assert.deepEqual(completed.acceptedProposals.map(({ proposalId }) => proposalId), [firstProposal.proposalId, secondProposal.proposalId]);
  completed.acceptedProposals.forEach(({ commitSha }) => assert.match(commitSha, /^[a-f0-9]{40}$/u));
  const resolvedComparison = await controller.compare({ cwd: source, harness: "codex", threadId: "partial-thread" });
  assert.deepEqual(resolvedComparison.scopePaths, ["one.txt", "two.txt"]);
  assert.deepEqual(resolvedComparison.changes, []);
  const followUp = await controller.editArcClaims({
    cwd: source, harness: "codex", threadId: "partial-thread", inherit: true, addPaths: ["planned.txt"],
  });
  assert.equal(followUp.phase, "active");
  assert.deepEqual(followUp.scopePaths, ["planned.txt"]);
  assert.equal(followUp.intentName, completed.intentName);
  const inventory = await controller.readScope({ cwd: source, harness: "codex", threadId: "partial-thread" });
  assert.deepEqual(inventory?.claimedPaths, ["planned.txt"]);
  await checkLocalReadsAndMessageAmendments(fixture, secondProposal.proposalId);
});

async function checkProposalReadPurity({ repository, source, state }: ControllerBranch<"status">) {
  const controller = new WorkbenchGitCheckpointController();
  const receipt = { proposalId: state.proposalId };
  const store = new GitCheckpointStore(repository);
  const stored = await store.readProposal("codex", "partial-thread", receipt.proposalId);
  const proposalRefBefore = await repository.readRef(stored.proposalRef);
  const advancedHead = await advanceHead(repository, "advance without touching proposal paths");
  await fs.writeFile(path.join(source, "one.txt"), "newer worktree content\n", "utf8");
  const newerBlob = (await repository.run(["hash-object", "--", "one.txt"])).trim();
  assert.equal(await repository.succeeds(["cat-file", "-e", newerBlob]), false);

  const defaultCard = await controller.getProposal({
    cwd: source,
    harness: "codex",
    includeNewer: false,
    proposalId: receipt.proposalId,
    threadId: "partial-thread",
  });
  assert.equal(defaultCard.baseCommit, advancedHead);
  assert.equal(defaultCard.status, "proposed");
  assert.equal(defaultCard.includeNewerAvailable, true);
  assert.match(defaultCard.changes[0]?.diff ?? "", /proposed content/u);
  assert.doesNotMatch(defaultCard.changes[0]?.diff ?? "", /newer worktree content/u);
  assert.equal(await repository.succeeds(["cat-file", "-e", newerBlob]), false);
  assert.equal(await repository.readRef(stored.proposalRef), proposalRefBefore);

  const newerCard = await controller.getProposal({
    cwd: source,
    harness: "codex",
    includeNewer: true,
    proposalId: receipt.proposalId,
    threadId: "partial-thread",
  });
  assert.match(newerCard.changes[0]?.diff ?? "", /newer worktree content/u);
  assert.equal(await repository.succeeds(["cat-file", "-e", newerBlob]), true);
  assert.equal(await repository.readRef(stored.proposalRef), proposalRefBefore);

  const committed = await controller.commitProposal({
    cwd: source,
    description: "",
    harness: "codex",
    includeNewer: true,
    proposalId: receipt.proposalId,
    threadId: "partial-thread",
    title: "change one",
  });
  assert.equal(committed.status, "committed");
  assert.notEqual(await repository.readRef(stored.proposalRef), proposalRefBefore);
  assert.equal(await fs.readFile(path.join(source, "one.txt"), "utf8"), "newer worktree content\n");
}

async function checkLocalReadsAndMessageAmendments(fixture: ControllerBranch<"partial">, commitTargetProposalId: string) {
  const { source } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  await git(source, ["remote", "add", "haunted", path.join(source, "missing-remote")]);

  const card = await controller.getProposal({
    cwd: source,
    harness: "codex",
    includeNewer: false,
    proposalId: commitTargetProposalId,
    threadId: "partial-thread",
  });
  assert.deepEqual(card.amendability, { status: "available" });
  await assert.rejects(controller.commitProposal({
    cwd: source,
    description: card.description,
    harness: "codex",
    includeNewer: false,
    proposalId: card.proposalId,
    threadId: "partial-thread",
    title: `${card.title} changed`,
  }), /Unable to refresh remote refs/u);
  await git(source, ["remote", "remove", "haunted"]);
  await checkMessageAmendments(fixture, card);
}

async function checkMessageAmendments({ repository, source }: ControllerBranch<"partial">, original: GitCheckpointProposal) {
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  await registry.release({ harness: "codex", threadId: "partial-thread" });
  assert.equal(await registry.find({ harness: "codex", threadId: "partial-thread" }), null);
  assert.deepEqual(original.amendability, { status: "available" });
  const amendment = await controller.createProposal({
    amendProposalId: original.proposalId,
    cwd: source,
    description: "Replacement description",
    harness: "codex",
    threadId: "partial-thread",
    title: "Replacement title",
  });
  assert.notEqual(amendment.proposalId, original.proposalId);
  const laterHead = await advanceHead(repository, "advance after message proposal");
  await fs.writeFile(path.join(source, "one.txt"), "unrelated unstaged\n");
  await fs.writeFile(path.join(source, "two.txt"), "unrelated staged\n");
  await git(source, ["add", "two.txt"]);
  const [worktreeBefore, indexBefore, pending] = await Promise.all([
    git(source, ["diff", "--binary"]),
    git(source, ["diff", "--cached", "--binary"]),
    controller.getProposal({
      cwd: source, harness: "codex", includeNewer: false, proposalId: amendment.proposalId, threadId: "partial-thread",
    }),
  ]);
  assert.deepEqual({ mode: pending.mode, status: pending.status, title: pending.title }, {
    mode: "amend", status: "proposed", title: "Replacement title",
  });
  const accepted = await controller.commitProposal({
    cwd: source,
    description: amendment.description,
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "partial-thread",
    title: amendment.title,
  });
  assert.equal(accepted.status, "committed");
  const [head, headTitle, prior, acceptedTitle, worktreeAfter, indexAfter] = await Promise.all([
    repository.currentHead(),
    git(source, ["show", "-s", "--format=%s", "HEAD"]),
    controller.getProposal({
      cwd: source, harness: "codex", includeNewer: false, proposalId: original.proposalId, threadId: "partial-thread",
    }),
    git(source, ["show", "-s", "--format=%s", accepted.committedSha!]),
    git(source, ["diff", "--binary"]),
    git(source, ["diff", "--cached", "--binary"]),
  ]);
  assert.notEqual(head, laterHead);
  assert.equal(headTitle.trim(), "advance after message proposal");
  assert.equal(prior.status, "superseded");
  assert.equal(acceptedTitle.trim(), "Replacement title");
  assert.equal(worktreeAfter, worktreeBefore);
  assert.equal(indexAfter, indexBefore);

  const directlyAmended = await controller.commitProposal({
    cwd: source,
    description: "Edited from the committed card",
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "partial-thread",
    title: "Card-edited title",
  });
  assert.notEqual(directlyAmended.committedSha, accepted.committedSha);
  const [directTitle, directWorktree, directIndex] = await Promise.all([
    git(source, ["show", "-s", "--format=%s", directlyAmended.committedSha!]),
    git(source, ["diff", "--binary"]),
    git(source, ["diff", "--cached", "--binary"]),
  ]);
  assert.equal(directTitle.trim(), "Card-edited title");
  assert.equal(directWorktree, worktreeBefore);
  assert.equal(directIndex, indexBefore);
}

controllerTest("replacement", "replacement plans target prior pending and committed proposals through the thread namespace", async ({ repository, source, state }) => {
  const controller = new WorkbenchGitCheckpointController();
  const replaceTarget = { proposalId: state.replaceTargetProposalId };
  const rescindTarget = { proposalId: state.rescindTargetProposalId };
  const commitTarget = { proposalId: state.commitTargetProposalId };

  const replacement = await controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    paths: ["one.txt"],
    replaceProposalId: replaceTarget.proposalId,
    threadId: "partial-thread",
    title: "replacement",
  });
  const [superseded, currentReplacement] = await Promise.all([
    controller.getProposal({
      cwd: source, harness: "codex", includeNewer: false, proposalId: replaceTarget.proposalId, threadId: "partial-thread",
    }),
    controller.getProposal({
      cwd: source, harness: "codex", includeNewer: false, proposalId: replacement.proposalId, threadId: "partial-thread",
    }),
  ]);
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededByProposalId, replacement.proposalId);
  assert.equal(currentReplacement.status, "proposed");

  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  const activeBeforeIgnoredAdd = await new GitArcRegistry(repository)
    .find({ harness: "codex", threadId: "partial-thread" });
  const ignoredAdd = await controller.addToArc({
    cwd: source,
    harness: "codex",
    paths: ["ignored/generated.ts"],
    threadId: "partial-thread",
  });
  assert.equal(ignoredAdd.kind, "noop");
  assert.deepEqual(ignoredAdd.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.deepEqual(
    await new GitArcRegistry(repository)
      .find({ harness: "codex", threadId: "partial-thread" }),
    activeBeforeIgnoredAdd,
  );

  const successor = await controller.addToArc({
    cwd: source,
    harness: "codex",
    paths: ["four.txt", "ignored/generated.ts"],
    threadId: "partial-thread",
  });
  assert.deepEqual(successor.skippedIgnoredPaths, ["ignored/generated.ts"]);
  const unavailable = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: replacement.proposalId, threadId: "partial-thread",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.committedSha, null);
  assert.equal(unavailable.unavailableReason, "Implementation continued after this proposal was created.");
  const continuedReplacement = await controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    paths: ["one.txt"],
    replaceProposalId: replacement.proposalId,
    threadId: "partial-thread",
    title: "continued replacement",
  });
  assert.equal(continuedReplacement.sourceCheckpoint, successor.checkpointCommit);
  const continuedSuperseded = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: replacement.proposalId, threadId: "partial-thread",
  });
  assert.equal(continuedSuperseded.status, "superseded");
  assert.equal(continuedSuperseded.supersededByProposalId, continuedReplacement.proposalId);
  assert.equal(continuedSuperseded.unavailableReason, null);

  assert.deepEqual(await controller.rescindProposal({
    cwd: source, harness: "codex", proposalId: rescindTarget.proposalId, threadId: "partial-thread",
  }), { committedSha: null, proposalId: rescindTarget.proposalId, status: "rescinded" });
  assert.equal((await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: rescindTarget.proposalId, threadId: "partial-thread",
  })).status, "rescinded");

  const committedTarget = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: commitTarget.proposalId, threadId: "partial-thread",
  });
  assert.ok(committedTarget.committedSha);
  const assertCommittedTarget = (error: unknown) => {
    assert.ok(error instanceof GitArcProposalAlreadyCommittedError);
    assert.equal(error.commitSha, committedTarget.committedSha);
    assert.equal(error.proposalId, commitTarget.proposalId);
    assert.equal(error.proposalTitle, committedTarget.title);
    assert.doesNotMatch(error.message, /wb git arc/u);
    return true;
  };
  await assert.rejects(controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    replaceProposalId: commitTarget.proposalId,
    threadId: "partial-thread",
    title: "invalid replacement",
  }), assertCommittedTarget);
  await assert.rejects(controller.rescindProposal({
    cwd: source, harness: "codex", proposalId: commitTarget.proposalId, threadId: "partial-thread",
  }), assertCommittedTarget);
  const amendment = await controller.createProposal({
    amend: true,
    amendProposalId: commitTarget.proposalId,
    cwd: source,
    description: "",
    freshDescription: "Preserve the accepted commit.",
    freshTitle: "add committed target correction",
    harness: "codex",
    threadId: "partial-thread",
    title: "amend committed target",
  });
  const laterHead = await advanceHead(repository, "advance after content proposal");
  const proposed = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: amendment.proposalId, threadId: "partial-thread",
  });
  assert.equal(proposed.mode, "amend");
  assert.equal(proposed.amendTargetSha, state.committedSha);
  assert.equal(proposed.status, "proposed");
  assert.deepEqual(proposed.amendTargetMessage, {
    description: committedTarget.description,
    title: committedTarget.title,
  });
  assert.deepEqual(proposed.changes.map(({ path: filePath }) => filePath), ["one.txt", "three.txt", "two.txt"]);
  assert.deepEqual(proposed.freshChanges?.map(({ path: filePath }) => filePath), ["one.txt", "two.txt"]);
  assert.match(proposed.changes.find(({ path: filePath }) => filePath === "one.txt")?.diff ?? "", /replace one/u);
  assert.match(proposed.changes.find(({ path: filePath }) => filePath === "two.txt")?.diff ?? "", /rescind two/u);
  assert.deepEqual(
    (await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" }))?.proposalIds,
    [continuedReplacement.proposalId, amendment.proposalId],
  );
  const pendingPlan = await controller.createPlan({
    cwd: source, harness: "codex", intentName: "next work", paths: successor.scopePaths, threadId: "partial-thread",
  });
  const committedFresh = await controller.commitProposal({
    cwd: source,
    description: "Preserve the accepted commit.",
    harness: "codex",
    includeNewer: false,
    mode: "commit",
    proposalId: amendment.proposalId,
    threadId: "partial-thread",
    title: "add committed target correction",
  });
  assert.equal(committedFresh.mode, "commit");
  const [retainedPlan, parent, title, originalTarget] = await Promise.all([
    controller.findPlanState({ cwd: source, harness: "codex", threadId: "partial-thread" }),
    git(source, ["rev-parse", `${committedFresh.committedSha}^`]),
    git(source, ["show", "-s", "--format=%s", committedFresh.committedSha!]),
    controller.getProposal({
      cwd: source, harness: "codex", includeNewer: false, proposalId: commitTarget.proposalId, threadId: "partial-thread",
    }),
  ]);
  assert.equal(retainedPlan?.checkpointCommit, pendingPlan.checkpointCommit);
  assert.equal(committedFresh.amendTargetSha, null);
  assert.equal(parent.trim(), laterHead);
  assert.equal(title.trim(), "add committed target correction");
  assert.equal(originalTarget.status, "committed");
  await assert.rejects(controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: replaceTarget.proposalId, threadId: "foreign-thread",
  }), (error: Error) => {
    assert.ok(error instanceof GitArcRejectionError);
    assert.deepEqual(error.rejection, { reason: "proposalNotFound", proposalId: replaceTarget.proposalId });
    return true;
  });
});

controllerTest("claims", "combined claims and inactive plan edits preserve dirty coverage and ignored-path boundaries", async (fixture) => {
  const { repository, source } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "keep this work\n");
  const before = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  await assert.rejects(controller.editArcClaims({
    cwd: source, harness: "codex", threadId: "partial-thread", inherit: true,
    removePaths: ["one.txt"], addPaths: ["planned.txt"],
  }), /dirty|clean/i);
  assert.deepEqual(await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" }), before);
  const edited = await controller.editArcClaims({
    cwd: source, harness: "codex", threadId: "partial-thread", inherit: true,
    removePaths: ["two.txt"], addPaths: ["planned.txt"],
  });
  assert.deepEqual(edited.scopePaths, ["one.txt", "planned.txt"]);
  assert.equal(await fs.readFile(path.join(source, "one.txt"), "utf8"), "keep this work\n");
  const current = await controller.continueArc({ cwd: source, harness: "codex", threadId: "partial-thread" });
  assert.equal(current.checkpointCommit, edited.checkpointCommit);
  const historical = await controller.diff({
    cwd: source, harness: "codex", threadId: "partial-thread", ref: before!.checkpointCommit, paths: ["one.txt"],
  });
  assert.match(historical.diff, /\+keep this work/u);
  await checkActivePlanEditing(fixture);
});

async function checkActivePlanEditing({ repository, source }: ControllerBranch<"claims">) {
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "retained one\n");

  await assert.rejects(controller.removeFromPlan({
    cwd: source, harness: "codex", paths: ["planned.txt"], threadId: "partial-thread",
  }), /legacy operation/u);
  await assert.rejects(controller.adoptIntoPlan({
    cwd: source, harness: "codex", paths: ["two.txt"], threadId: "partial-thread",
  }), /legacy operation/u);
  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  const activeBeforeIgnoredPlanAdd = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  const ignoredPlanAdd = await controller.addToPlan({
    cwd: source, harness: "codex", paths: ["ignored/generated.ts"], threadId: "partial-thread",
  });
  assert.equal(ignoredPlanAdd.kind, "noop");
  assert.deepEqual(ignoredPlanAdd.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.deepEqual(
    await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" }),
    activeBeforeIgnoredPlanAdd,
  );

  const extended = await controller.addToPlan({
    cwd: source, harness: "codex", paths: ["ignored/generated.ts", "two.txt"], threadId: "partial-thread",
  });
  assert.deepEqual(extended.scopePaths, ["one.txt", "planned.txt", "two.txt"]);
  assert.deepEqual(extended.skippedIgnoredPaths, ["ignored/generated.ts"]);
  let registryEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(registryEntry?.phase, "plan");
  assert.deepEqual(registryEntry?.claimedPaths, []);
  assert.deepEqual(registryEntry?.retainedArc?.claimedPaths, ["one.txt"]);
  assert.deepEqual(await controller.findPlanState({ cwd: source, harness: "codex", threadId: "partial-thread" }), {
    checkpointCommit: extended.checkpointCommit,
    harness: "codex",
    intentDescription: "",
    intentName: "change both files",
    scopePaths: ["one.txt", "planned.txt", "two.txt"],
    threadId: "partial-thread",
    updatedAt: registryEntry?.updatedAt,
  });
  const planBeforeIgnoredAdopt = registryEntry;
  const ignoredPlanAdopt = await controller.adoptIntoPlan({
    cwd: source, harness: "codex", paths: ["ignored/generated.ts"], threadId: "partial-thread",
  });
  assert.equal(ignoredPlanAdopt.kind, "noop");
  assert.deepEqual(ignoredPlanAdopt.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.deepEqual(
    await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" }),
    planBeforeIgnoredAdopt,
  );
  await fs.writeFile(path.join(source, "adopted.txt"), "adopted work\n");
  const adoptedPlan = await controller.adoptIntoPlan({
    cwd: source,
    harness: "codex",
    paths: ["adopted.txt", "ignored/generated.ts"],
    threadId: "partial-thread",
  });
  assert.equal(adoptedPlan.kind, "plan");
  assert.deepEqual(adoptedPlan.scopePaths, ["adopted.txt", "one.txt", "planned.txt", "two.txt"]);
  assert.deepEqual(adoptedPlan.skippedIgnoredPaths, ["ignored/generated.ts"]);
  assert.equal((await controller.listPlanStates({ cwd: source })).length, 1);

  await controller.startArc({
    checkpointCommit: adoptedPlan.checkpointCommit, cwd: source, harness: "codex", threadId: "partial-thread",
  });
  assert.equal(await controller.findPlanState({ cwd: source, harness: "codex", threadId: "partial-thread" }), null);
  await fs.rm(path.join(source, "adopted.txt"));
  const replacement = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "replan an ordinary active arc",
    paths: ["one.txt", "planned.txt", "two.txt"],
    threadId: "partial-thread",
  });
  assert.deepEqual(replacement.scopePaths, ["one.txt", "planned.txt", "two.txt"]);
  registryEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(registryEntry?.phase, "plan");
  assert.deepEqual(registryEntry?.retainedArc?.claimedPaths, ["one.txt"]);
}

controllerTest("retained", "replacement plans retain every dirty claim and release claims that became clean", async ({ repository, source, state }) => {
  const controller = new WorkbenchGitCheckpointController();
  const proposal = { proposalId: state.proposalId };
  const replacement = await controller.createPlan({
    cwd: source, harness: "codex", intentName: "carry retained dirt", paths: ["one.txt", "two.txt"], threadId: "partial-thread",
  });
  const revised = await controller.addToPlan({
    cwd: source, harness: "codex", paths: ["planned.txt"], threadId: "partial-thread",
  });
  await controller.commitProposal({
    cwd: source, description: "", harness: "codex", includeNewer: false, proposalId: proposal.proposalId,
    threadId: "partial-thread", title: "commit one",
  });

  await assert.rejects(controller.createPlan({
    cwd: source, harness: "codex", intentName: "omit retained dirt", paths: ["one.txt"], threadId: "partial-thread",
  }), /must include every dirty claimed file: two\.txt/u);
  await assert.rejects(controller.createAndStartPlan({
    cwd: source, harness: "codex", intentName: "skip retained dirt", paths: ["one.txt"], threadId: "partial-thread",
  }), /must include every dirty claimed file: two\.txt/u);

  let registryEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(registryEntry?.phase, "plan");
  assert.equal(registryEntry?.checkpointCommit, revised.checkpointCommit);
  assert.equal(registryEntry?.intentName, replacement.intentName);
  assert.deepEqual(registryEntry?.retainedArc?.claimedPaths, ["two.txt"]);
  await assert.rejects(controller.removeFromPlan({
    cwd: source, harness: "codex", paths: ["two.txt"], threadId: "partial-thread",
  }), /must include every dirty claimed file: two\.txt/u);

  await fs.writeFile(path.join(source, "two.txt"), "two\n");
  await controller.createPlan({
    cwd: source, harness: "codex", intentName: "release clean retained work", paths: ["one.txt"], threadId: "partial-thread",
  });
  registryEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(registryEntry?.phase, "plan");
  assert.equal(registryEntry?.retainedArc?.phase, "resolved");
  assert.deepEqual(registryEntry?.retainedArc?.claimedPaths, []);
  assert.notEqual(registryEntry?.checkpointCommit, replacement.checkpointCommit);
});


controllerTest("remote", "remote boundaries reject published amendments, unavailable refreshes and detached HEAD", async (fixture) => {
  const { source } = fixture;
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "amend pushed head\n");
  await assert.rejects(controller.createProposal({
    amend: true,
    cwd: source,
    description: "",
    freshDescription: "",
    freshTitle: "commit pushed correction separately",
    harness: "codex",
    threadId: "adopt-thread",
    title: "",
  }), /already present on remote refs/u);
  await checkRemoteFailures(fixture);
});

test("Git arc controller operations", { concurrency: 4 }, async (context) => {
  const fixture = await fixtureCache.copy(CONTROLLER_OPERATIONS_FIXTURE);
  context.after(fixture.dispose);
  const order: Array<keyof ControllerFixtureState> = [
    "partial", "diagnostics", "replacement", "legacy", "claims", "status",
    "retained", "adoption", "empty", "workspace", "remote", "registry",
  ];
  await Promise.all(order.map(async (key) => {
    const { name, run } = controllerCases.get(key)!;
    await context.test(name, { concurrency: true }, (child) => run(fixture, child));
  }));
});
