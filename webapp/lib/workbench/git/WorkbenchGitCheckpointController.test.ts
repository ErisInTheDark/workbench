/*
 * Exports:
 * - No production exports; serial shared-state tests and bounded concurrent copied-repository cases cover arc ownership, proposals, and publish state. Keywords: git, arc, registry, proposal, concurrency, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { promisify } from "node:util";

import GitArcPublishState from "./GitArcPublishState";
import { GitArcProposalAlreadyCommittedError } from "./git-arc-failures";
import { GitArcAcceptedProposalsError } from "./GitArcProposalController";
import createGitArcStartDiagnosticError, { GitArcStartDiagnosticError } from "./git-arc-start-diagnostics";
import { GitCheckpointDirtyPathsError, GitCheckpointIgnoredPathsError } from "./GitArcPlanController";
import GitArcRegistry, { GitArcCollisionError } from "./GitArcRegistry";
import GitCheckpointStore, { GitCheckpointMissingObjectError } from "./GitCheckpointStore";
import GitTestFixtureCache, { type GitTestFixtureSpec } from "./GitTestFixtureCache";
import {
  CONTROLLER_ADOPT_READY_FIXTURE,
  CONTROLLER_BASE_FIXTURE,
  CONTROLLER_FAILED_ADOPT_READY_FIXTURE,
  CONTROLLER_PARTIAL_READY_FIXTURE,
  CONTROLLER_PUSHED_AMEND_READY_FIXTURE,
  CONTROLLER_REPLACEMENT_READY_FIXTURE,
  CONTROLLER_START_READY_FIXTURE,
} from "./WorkbenchGitTestFixtures";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";

const execFileAsync = promisify(execFile);
const fixtureCache = new GitTestFixtureCache();
const isolatedControllerCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];
const sharedControllerCases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];
let baseCommit = "";
let sharedRepository: WorkbenchGitRepository;
let sharedRoot = "";
let sharedSource = "";
let disposeSharedFixture: () => Promise<void> = async () => undefined;

function isolatedControllerTest(name: string, run: (context: TestContext) => Promise<void>) {
  isolatedControllerCases.push({ name, run });
}

function sharedControllerTest(name: string, run: (context: TestContext) => Promise<void>) {
  sharedControllerCases.push({ name, run });
}

function rejectsIgnoredPaths(expectedPaths: string[]) {
  return (error: unknown) => {
    assert(error instanceof GitCheckpointIgnoredPathsError);
    assert.deepEqual(error.ignoredPaths, expectedPaths);
    return true;
  };
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

async function advanceHead(repository: WorkbenchGitRepository, message: string) {
  const head = await repository.currentHead();
  const headRef = await repository.symbolicHead();
  assert.ok(headRef);
  const commit = await repository.createCommitFromTree(await repository.resolveTree(head), head, message);
  await repository.updateRefs([{ newValue: commit, oldValue: head, ref: headRef }]);
  return commit;
}

async function createRepository(_context: TestContext) {
  return { repository: sharedRepository, root: sharedRoot, source: sharedSource };
}

async function copyRepository<State extends object>(context: TestContext, spec: GitTestFixtureSpec<State>) {
  const fixture = await fixtureCache.copy(spec);
  context.after(fixture.dispose);
  return {
    repository: await WorkbenchGitRepository.open(fixture.root),
    root: fixture.temporaryRoot,
    source: fixture.root,
    state: fixture.state,
  };
}

before(async () => {
  const fixture = await fixtureCache.copy(CONTROLLER_BASE_FIXTURE);
  disposeSharedFixture = fixture.dispose;
  sharedRoot = fixture.temporaryRoot;
  sharedSource = fixture.root;
  sharedRepository = await WorkbenchGitRepository.open(sharedSource);
  baseCommit = await sharedRepository.currentHead();
});

async function resetSharedRepository() {
  await fs.rm(path.join(sharedSource, ".workbench"), { force: true, recursive: true });
  await git(sharedSource, ["checkout", "--force", "--quiet", "-B", "main", baseCommit]);
  const entries = await fs.readdir(sharedSource);
  if (entries.some((entry) => ![".git", "one.txt", "two.txt"].includes(entry))) {
    await git(sharedSource, ["clean", "-fdx", "--quiet"]);
  }
  const refs = await sharedRepository.listRefs("refs/worktree");
  if (refs.length) await sharedRepository.updateRefs([], refs.map((ref) => ({ ref })));
}

after(async () => {
  await disposeSharedFixture();
});

sharedControllerTest("active arc registry rejects sibling overlap and releases claims without touching the worktree", async (context) => {
  await resetSharedRepository();
  const { repository, source } = await createRepository(context);
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
});

sharedControllerTest("active arc registry keeps start idempotent and rejects stale same-thread replacement", async (context) => {
  await resetSharedRepository();
  const { repository } = await createRepository(context);
  const registry = new GitArcRegistry(repository);
  const initialCheckpoint = await repository.currentHead();
  const initial = await registry.claim({
    checkpointCommit: initialCheckpoint,
    claimedPaths: ["one.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "change one",
    proposalId: null,
    threadId: "thread-one",
  });
  assert.deepEqual(await registry.claim({
    checkpointCommit: initialCheckpoint,
    claimedPaths: ["one.txt"],
    harness: "codex",
    intentDescription: "ignored retry text",
    intentName: "ignored retry name",
    proposalId: null,
    threadId: "thread-one",
  }), initial);
  await assert.rejects(registry.claim({
    checkpointCommit: "1".repeat(40),
    claimedPaths: ["one.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "different arc",
    proposalId: null,
    threadId: "thread-one",
  }), /already owns a different active Git arc/u);

  const replacement = await registry.prepareClaim({
    checkpointCommit: "2".repeat(40),
    claimedPaths: ["one.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "continued arc",
    proposalId: null,
    threadId: "thread-one",
  }, { expectedCheckpointCommit: initialCheckpoint });
  assert.ok(replacement.update);
  await repository.updateRefs([replacement.update]);
  await assert.rejects(registry.prepareClaim({
    checkpointCommit: "3".repeat(40),
    claimedPaths: ["one.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "stale continuation",
    proposalId: null,
    threadId: "thread-one",
  }, { expectedCheckpointCommit: initialCheckpoint }), /active Git arc changed/u);
});

isolatedControllerTest("publish state fails closed when a configured remote cannot refresh", async (context) => {
  const local = await copyRepository(context, CONTROLLER_PUSHED_AMEND_READY_FIXTURE);
  await git(local.source, ["remote", "set-url", "origin", path.join(local.root, "missing.git")]);
  const state = await new GitArcPublishState(local.repository).classifyCurrentHead();
  assert.equal(state.kind, "unknown");
  if (state.kind === "unknown") assert.match(state.reason, /Unable to refresh remote refs/u);
  await git(local.source, ["checkout", "--detach", "--quiet"]);
  assert.deepEqual(await new GitArcPublishState(local.repository).classifyCurrentHead(), { kind: "detached" });
});

isolatedControllerTest("empty inactive plans remain visible through plan-state reads", async (context) => {
  const { source } = await copyRepository(context, CONTROLLER_BASE_FIXTURE);
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
  }), /An empty Git arc plan cannot start/u);
  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  await assert.rejects(controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "reject ignored plan",
    paths: ["ignored/generated.ts"],
    threadId: "ignored-plan-thread",
  }), rejectsIgnoredPaths(["ignored/generated.ts"]));
  await assert.rejects(controller.createAndStartPlan({
    cwd: source,
    harness: "codex",
    intentName: "reject ignored plan start",
    paths: ["ignored/generated.ts"],
    threadId: "ignored-plan-start-thread",
  }), rejectsIgnoredPaths(["ignored/generated.ts"]));
});

isolatedControllerTest("arc start requires fresh v3 plans but adopts dirty legacy arcs into the registry", async (context) => {
  const { repository, source, state } = await copyRepository(context, CONTROLLER_START_READY_FIXTURE);
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
  }), /clean against current HEAD[\s\S]*belong after -- as ordinary plan paths/u);
  const original = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "fresh plan",
    paths: ["one.txt"],
    threadId: "preserved-plan-thread",
  });
  const originalCheckpoint = await new GitCheckpointStore(repository).readCheckpoint(
    "codex",
    "preserved-plan-thread",
    original.checkpointCommit,
  );
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
  assert.deepEqual(replacement.preservedDriftPaths, ["one.txt"]);
  assert.equal(replacement.preservedDriftPathCount, 1);
  const replacementCheckpoint = await new GitCheckpointStore(repository).readCheckpoint(
    "codex",
    "preserved-plan-thread",
    replacement.checkpointCommit,
  );
  assert.equal(replacementCheckpoint.parent, originalCheckpoint.parent);
  await assert.rejects(controller.startArc({
    checkpointCommit: replacement.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "preserved-plan-thread",
  }), new RegExp(`${causalCommit.slice(0, 8)}[^\\n]*delete planned one[\\s\\S]*one\\.txt`, "u"));
  const refreshed = await controller.addToPlan({
    cwd: source,
    harness: "codex",
    paths: ["one.txt"],
    threadId: "preserved-plan-thread",
  });
  assert.deepEqual(refreshed.scopePaths, ["one.txt"]);
  assert.deepEqual(refreshed.preservedDriftPaths, []);
  assert.equal(refreshed.preservedDriftPathCount, 0);
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

isolatedControllerTest("arc start reports only causal commits, sibling claims, and adoptable workspace dirt", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_BASE_FIXTURE);
  const planPaths = ["claimed-dirty.txt", "one.txt", "three.txt", "two.txt"];
  const planHead = await repository.currentHead();

  await fs.writeFile(path.join(source, "unrelated.txt"), "unrelated\n");
  await git(source, ["add", "unrelated.txt"]);
  await git(source, ["commit", "--quiet", "-m", "unrelated housekeeping"]);
  await fs.writeFile(path.join(source, "one.txt"), "committed one\n");
  await git(source, ["add", "one.txt"]);
  await git(source, ["commit", "--quiet", "-m", "change planned one"]);
  const relevantCommit = (await git(source, ["rev-parse", "HEAD"])).trim();

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
  const dirtySection = error.message.split("Dirty unclaimed planned files:")[1]?.split("Only dirty unclaimed files")[0] ?? "";
  assert.match(dirtySection, /three\.txt/u);
  assert.doesNotMatch(dirtySection, /two\.txt|claimed-dirty\.txt/u);
  assert.match(error.message, new RegExp(`mcp__wbex__git_arc_diff.*${planHead}`, "u"));
  assert.match(error.message, /mcp__wbex__git_arc_plan_start/u);

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
});

isolatedControllerTest("arc adopt claims dirty workspace paths from HEAD without changing worktree or index state", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_ADOPT_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "two.txt"), "modified two\n");
  await fs.rm(path.join(source, "deleted.txt"));
  await fs.writeFile(path.join(source, "untracked.txt"), "new work\n");
  await fs.writeFile(path.join(source, "staged.txt"), "staged work\n");
  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  await git(source, ["add", "staged.txt"]);
  const stagedBefore = await git(source, ["diff", "--cached", "--binary"]);

  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["ignored/generated.ts"],
    threadId: "adopt-thread",
  }), rejectsIgnoredPaths(["ignored/generated.ts"]));

  const adopted = await controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["two.txt", "deleted.txt", "untracked.txt"],
    threadId: "adopt-thread",
  });
  assert.deepEqual(adopted.scopePaths, ["deleted.txt", "one.txt", "two.txt", "untracked.txt"]);
  assert.equal((await new GitArcRegistry(repository).find({ harness: "codex", threadId: "adopt-thread" }))?.checkpointCommit, adopted.checkpointCommit);
  assert.equal(await repository.readRef(adopted.checkpointRef), adopted.checkpointCommit);
  assert.equal(await fs.readFile(path.join(source, "two.txt"), "utf8"), "modified two\n");
  assert.equal(await fs.readFile(path.join(source, "untracked.txt"), "utf8"), "new work\n");
  await assert.rejects(fs.access(path.join(source, "deleted.txt")));
  assert.equal(await git(source, ["diff", "--cached", "--binary"]), stagedBefore);

  const compared = await controller.compare({ cwd: source, harness: "codex", threadId: "adopt-thread" });
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
  }), /already covered by the claimed set/u);
  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["clean-missing.txt"],
    threadId: "adopt-thread",
  }), /Arc adopt paths must contain working-tree changes: clean-missing\.txt/u);
});

isolatedControllerTest("failed arc adoption publishes neither a successor ref nor a replacement registry entry", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_FAILED_ADOPT_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  await fs.writeFile(path.join(source, "collision.txt"), "dirty collision\n");
  const refsBefore = await repository.listRefs("refs/worktree/agents/codex/adopt-owner/checkpoints");
  const activeBefore = await registry.find({ harness: "codex", threadId: "adopt-owner" });

  await assert.rejects(controller.adoptIntoArc({
    cwd: source,
    harness: "codex",
    paths: ["collision.txt"],
    threadId: "adopt-owner",
  }), /overlap active sibling work/u);
  assert.deepEqual(await repository.listRefs("refs/worktree/agents/codex/adopt-owner/checkpoints"), refsBefore);
  assert.deepEqual(await registry.find({ harness: "codex", threadId: "adopt-owner" }), activeBefore);
});

isolatedControllerTest("accepted proposals narrow claims, continue through successors, and resolve after disjoint commits", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_PARTIAL_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  const started = await registry.find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(started?.phase, "active");
  await fs.writeFile(path.join(source, "one.txt"), "committed one\n");
  await fs.writeFile(path.join(source, "two.txt"), "remaining two\n");
  const firstProposal = await controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    paths: ["one.txt"],
    threadId: "partial-thread",
    title: "commit one",
  });
  const secondProposal = await controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    paths: ["two.txt"],
    threadId: "partial-thread",
    title: "commit two",
  });
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
  const partial = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(partial?.phase, "active");
  assert.deepEqual(partial?.claimedPaths, ["one.txt", "two.txt"]);
  assert.notEqual(partial?.checkpointCommit, started?.checkpointCommit);
  assert.equal(await fs.readFile(path.join(source, "one.txt"), "utf8"), "newer one\n");
  assert.equal(await fs.readFile(path.join(source, "two.txt"), "utf8"), "remaining two\n");
  const compared = await controller.compare({ cwd: source, harness: "codex", threadId: "partial-thread" });
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
  await assert.rejects(controller.continueArc({
    checkpointCommit: started!.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "partial-thread",
  }), (error) => {
    assert.ok(error instanceof GitArcAcceptedProposalsError);
    assert.deepEqual(error.claimedPaths, []);
    assert.deepEqual(error.receipts.map(({ proposalId }) => proposalId), [firstProposal.proposalId, secondProposal.proposalId]);
    error.receipts.forEach(({ commitSha }) => assert.match(commitSha, /^[a-f0-9]{40}$/u));
    assert.match(error.message, /resolved and owns no live claims/u);
    return true;
  });
});

isolatedControllerTest("targeted message amendments need no active arc and preserve unrelated worktree and index state", async (context) => {
  const { repository, source, state } = await copyRepository(context, CONTROLLER_REPLACEMENT_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  const registry = new GitArcRegistry(repository);
  await registry.release({ harness: "codex", threadId: "partial-thread" });
  assert.equal(await registry.find({ harness: "codex", threadId: "partial-thread" }), null);
  const original = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false,
    proposalId: state.commitTargetProposalId, threadId: "partial-thread",
  });
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
  const worktreeBefore = await git(source, ["diff", "--binary"]);
  const indexBefore = await git(source, ["diff", "--cached", "--binary"]);
  const pending = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: amendment.proposalId, threadId: "partial-thread",
  });
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
  assert.notEqual(await repository.currentHead(), laterHead);
  assert.equal((await git(source, ["show", "-s", "--format=%s", "HEAD"])).trim(), "advance after message proposal");
  assert.equal((await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: original.proposalId, threadId: "partial-thread",
  })).status, "superseded");
  assert.equal((await git(source, ["show", "-s", "--format=%s", accepted.committedSha!])).trim(), "Replacement title");
  assert.equal(await git(source, ["diff", "--binary"]), worktreeBefore);
  assert.equal(await git(source, ["diff", "--cached", "--binary"]), indexBefore);

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
  assert.equal((await git(source, ["show", "-s", "--format=%s", directlyAmended.committedSha!])).trim(), "Card-edited title");
  assert.equal(await git(source, ["diff", "--binary"]), worktreeBefore);
  assert.equal(await git(source, ["diff", "--cached", "--binary"]), indexBefore);
});

isolatedControllerTest("replacement plans target prior pending and committed proposals through the thread namespace", async (context) => {
  const { repository, source, state } = await copyRepository(context, CONTROLLER_REPLACEMENT_READY_FIXTURE);
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
  const superseded = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: replaceTarget.proposalId, threadId: "partial-thread",
  });
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededByProposalId, replacement.proposalId);
  assert.equal((await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: replacement.proposalId, threadId: "partial-thread",
  })).status, "proposed");

  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  await assert.rejects(controller.addToArc({
    cwd: source,
    harness: "codex",
    paths: ["ignored/generated.ts"],
    threadId: "partial-thread",
  }), rejectsIgnoredPaths(["ignored/generated.ts"]));

  const successor = await controller.addToArc({
    cwd: source,
    harness: "codex",
    paths: ["four.txt"],
    threadId: "partial-thread",
  });
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
    harness: "codex",
    threadId: "partial-thread",
    title: "amend committed target",
  });
  await advanceHead(repository, "advance after content proposal");
  const proposed = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: amendment.proposalId, threadId: "partial-thread",
  });
  assert.equal(proposed.mode, "amend");
  assert.equal(proposed.amendTargetSha, state.committedSha);
  assert.equal(proposed.status, "proposed");
  assert.deepEqual(proposed.changes.map(({ path: filePath }) => filePath), ["one.txt", "three.txt", "two.txt"]);
  assert.match(proposed.changes.find(({ path: filePath }) => filePath === "one.txt")?.diff ?? "", /replace one/u);
  assert.match(proposed.changes.find(({ path: filePath }) => filePath === "two.txt")?.diff ?? "", /rescind two/u);
  assert.deepEqual(
    (await new GitArcRegistry(await WorkbenchGitRepository.open(source)).find({ harness: "codex", threadId: "partial-thread" }))?.proposalIds,
    [continuedReplacement.proposalId, amendment.proposalId],
  );
  await assert.rejects(controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: replaceTarget.proposalId, threadId: "foreign-thread",
  }), /Checkpoint proposal not found/u);
});

isolatedControllerTest("active plan add publishes an inactive successor without claiming new paths", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_PARTIAL_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "retained one\n");

  await assert.rejects(controller.removeFromPlan({
    cwd: source, harness: "codex", paths: ["two.txt"], threadId: "partial-thread",
  }), /Only arc plan add can create an inactive plan from an active Git arc/u);
  await assert.rejects(controller.adoptIntoPlan({
    cwd: source, harness: "codex", paths: ["planned.txt"], threadId: "partial-thread",
  }), /Only arc plan add can create an inactive plan from an active Git arc/u);
  await fs.writeFile(path.join(source, ".gitignore"), "ignored/\n", "utf8");
  await assert.rejects(controller.addToPlan({
    cwd: source, harness: "codex", paths: ["ignored/generated.ts"], threadId: "partial-thread",
  }), rejectsIgnoredPaths(["ignored/generated.ts"]));

  const extended = await controller.addToPlan({
    cwd: source, harness: "codex", paths: ["planned.txt"], threadId: "partial-thread",
  });
  assert.deepEqual(extended.scopePaths, ["one.txt", "planned.txt", "two.txt"]);
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
  await assert.rejects(controller.adoptIntoPlan({
    cwd: source, harness: "codex", paths: ["ignored/generated.ts"], threadId: "partial-thread",
  }), rejectsIgnoredPaths(["ignored/generated.ts"]));
  assert.equal((await controller.listPlanStates({ cwd: source })).length, 1);

  await controller.startArc({
    checkpointCommit: extended.checkpointCommit, cwd: source, harness: "codex", threadId: "partial-thread",
  });
  assert.equal(await controller.findPlanState({ cwd: source, harness: "codex", threadId: "partial-thread" }), null);
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
});

isolatedControllerTest("replacement plans retain every dirty claim and release claims that became clean", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_PARTIAL_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "committed one\n");
  await fs.writeFile(path.join(source, "two.txt"), "retained two\n");
  const proposal = await controller.createProposal({
    cwd: source, description: "", harness: "codex", paths: ["one.txt"], threadId: "partial-thread", title: "commit one",
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

  const replacement = await controller.createPlan({
    cwd: source, harness: "codex", intentName: "carry retained dirt", paths: ["one.txt", "two.txt"], threadId: "partial-thread",
  });
  let registryEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(registryEntry?.phase, "plan");
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


isolatedControllerTest("amend proposal creation rejects HEAD already contained by a refreshed remote ref", async (context) => {
  const { source } = await copyRepository(context, CONTROLLER_PUSHED_AMEND_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "amend pushed head\n");
  await assert.rejects(controller.createProposal({
    amend: true,
    cwd: source,
    description: "",
    harness: "codex",
    threadId: "pushed-thread",
    title: "",
  }), /already present on remote refs/u);
});

test("Git arc controller operations", { concurrency: 2 }, async (context) => {
  await Promise.all([
    context.test("shared-repository operations", async (sharedContext) => {
      for (const { name, run } of sharedControllerCases) await sharedContext.test(name, run);
    }),
    context.test("isolated repository operations", { concurrency: 4 }, async (isolatedContext) => {
      await Promise.all(isolatedControllerCases.map(async ({ name, run }) => (
        await isolatedContext.test(name, { concurrency: true }, run)
      )));
    }),
  ]);
});
