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
import GitArcProposalCache from "./GitArcProposalCache";
import GitArcRegistry from "./GitArcRegistry";
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

function isolatedControllerTest(name: string, run: (context: TestContext) => Promise<void>) {
  isolatedControllerCases.push({ name, run });
}

function sharedControllerTest(name: string, run: (context: TestContext) => Promise<void>) {
  sharedControllerCases.push({ name, run });
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

async function createTranscript(
  repository: WorkbenchGitRepository,
  harness: "codex" | "copilot" | "opencode",
  threadId: string,
) {
  const threadDirectory = path.join(
    repository.root,
    ".workbench",
    "transcripts",
    harness,
    "threads",
    Buffer.from(threadId, "utf8").toString("base64url"),
  );
  await fs.mkdir(threadDirectory, { recursive: true });
  await fs.writeFile(path.join(threadDirectory, "thread.json"), "{}\n");
}

before(async () => {
  const fixture = await fixtureCache.copy(CONTROLLER_BASE_FIXTURE);
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
  await fs.rm(sharedRoot, { force: true, recursive: true });
});

sharedControllerTest("active arc registry rejects sibling overlap and releases claims without touching the worktree", async (context) => {
  await resetSharedRepository();
  const { repository, source } = await createRepository(context);
  const registry = new GitArcRegistry(repository);
  await registry.claim({
    checkpointCommit: await repository.currentHead(),
    claimedPaths: ["one.txt"],
    harness: "codex",
    intentDescription: "",
    intentName: "change one",
    proposalId: null,
    threadId: "thread-one",
  });
  await assert.rejects(registry.claim({
    checkpointCommit: await repository.currentHead(),
    claimedPaths: ["one.txt", "two.txt"],
    harness: "opencode",
    intentDescription: "inspect overlap",
    intentName: "change both",
    proposalId: null,
    threadId: "thread-two",
  }), /overlap active sibling work.*opencode\/thread-two|codex\/thread-one.*change one.*one\.txt/u);

  await registry.claim({
    checkpointCommit: await repository.currentHead(),
    claimedPaths: ["two.txt"],
    harness: "opencode",
    intentDescription: "change the independent file",
    intentName: "change two",
    proposalId: null,
    threadId: "thread-two",
  });
  assert.equal((await registry.read()).state.entries.length, 2);
  await registry.release({ harness: "codex", threadId: "thread-one" });
  assert.equal(await registry.find({ harness: "codex", threadId: "thread-one" }), null);
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

sharedControllerTest("proposal cache reuses derived changes beneath the canonical harness transcript", async (context) => {
  await resetSharedRepository();
  const { repository } = await createRepository(context);
  const threadId = "shared-thread-id";
  await createTranscript(repository, "opencode", threadId);
  const tree = await repository.resolveTree("HEAD");
  let builds = 0;
  const input = {
    baseTree: tree,
    build: async () => {
      builds += 1;
      return [];
    },
    harness: "opencode" as const,
    paths: ["one.txt"],
    proposalId: "proposal-one",
    targetTree: tree,
    threadId,
  };
  const cache = new GitArcProposalCache(repository.root);
  await cache.readOrBuild(input);
  await cache.readOrBuild(input);
  assert.equal(builds, 1);
});

isolatedControllerTest("arc start requires fresh v3 plans but adopts dirty legacy arcs into the registry", async (context) => {
  const { repository, source, state } = await copyRepository(context, CONTROLLER_START_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "one.txt"), "dirty before start\n");
  await assert.rejects(controller.startArc({
    checkpointCommit: state.freshPlanCheckpoint,
    cwd: source,
    harness: "codex",
    threadId: "fresh-thread",
  }), /Arc start paths changed after the plan was created: one\.txt/u);

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

isolatedControllerTest("arc adopt claims dirty workspace paths from HEAD without changing worktree or index state", async (context) => {
  const { repository, source } = await copyRepository(context, CONTROLLER_ADOPT_READY_FIXTURE);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "two.txt"), "modified two\n");
  await fs.rm(path.join(source, "deleted.txt"));
  await fs.writeFile(path.join(source, "untracked.txt"), "new work\n");
  await fs.writeFile(path.join(source, "staged.txt"), "staged work\n");
  await git(source, ["add", "staged.txt"]);
  const stagedBefore = await git(source, ["diff", "--cached", "--binary"]);

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
  const started = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
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
  }), new RegExp(`Accepted commit proposals:[\\s\\S]*${firstProposal.proposalId}[\\s\\S]*${secondProposal.proposalId}[\\s\\S]*resolved and owns no live claims`, "u"));
});

isolatedControllerTest("replacement plans target prior pending and committed proposals through the thread namespace", async (context) => {
  const { source, state } = await copyRepository(context, CONTROLLER_REPLACEMENT_READY_FIXTURE);
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

  assert.deepEqual(await controller.rescindProposal({
    cwd: source, harness: "codex", proposalId: rescindTarget.proposalId, threadId: "partial-thread",
  }), { committedSha: null, proposalId: rescindTarget.proposalId, status: "rescinded" });
  assert.equal((await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: rescindTarget.proposalId, threadId: "partial-thread",
  })).status, "rescinded");

  await assert.rejects(controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    replaceProposalId: commitTarget.proposalId,
    threadId: "partial-thread",
    title: "invalid replacement",
  }), new RegExp(`already committed\\. Use wb git arc propose --amend ${commitTarget.proposalId}`, "u"));
  const amendment = await controller.createProposal({
    amendProposalId: commitTarget.proposalId,
    cwd: source,
    description: "",
    harness: "codex",
    paths: ["two.txt"],
    threadId: "partial-thread",
    title: "amend committed target",
  });
  const proposed = await controller.getProposal({
    cwd: source, harness: "codex", includeNewer: false, proposalId: amendment.proposalId, threadId: "partial-thread",
  });
  assert.equal(proposed.mode, "amend");
  assert.equal(proposed.amendTargetSha, state.committedSha);
  assert.equal(proposed.status, "proposed");
  assert.deepEqual(
    (await new GitArcRegistry(await WorkbenchGitRepository.open(source)).find({ harness: "codex", threadId: "partial-thread" }))?.proposalIds,
    [replacement.proposalId, amendment.proposalId],
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

  const extended = await controller.addToPlan({
    cwd: source, harness: "codex", paths: ["planned.txt"], threadId: "partial-thread",
  });
  assert.deepEqual(extended.scopePaths, ["one.txt", "planned.txt", "two.txt"]);
  let registryEntry = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.equal(registryEntry?.phase, "plan");
  assert.deepEqual(registryEntry?.claimedPaths, []);
  assert.deepEqual(registryEntry?.retainedArc?.claimedPaths, ["one.txt"]);

  await controller.startArc({
    checkpointCommit: extended.checkpointCommit, cwd: source, harness: "codex", threadId: "partial-thread",
  });
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
