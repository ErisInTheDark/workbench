/*
 * Exports:
 * - No production exports; repository fixture tests cover active arc registry ownership and conservative publish-state classification. Keywords: git, arc, registry, publish, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { promisify } from "node:util";

import GitArcPublishState from "./GitArcPublishState";
import GitArcProposalCache from "./GitArcProposalCache";
import GitArcRegistry from "./GitArcRegistry";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";

const execFileAsync = promisify(execFile);
let baseCommit = "";
let sharedRepository: WorkbenchGitRepository;
let sharedRoot = "";
let sharedSource = "";
let templateRoot = "";

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

async function createRepository(context: TestContext, withRemote = false) {
  if (!withRemote) return { repository: sharedRepository, root: sharedRoot, source: sharedSource };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-arc-owner-test-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "clone");
  await git(root, ["clone", "--bare", "--quiet", templateRoot, remote]);
  await git(root, ["clone", "--quiet", remote, clone]);
  return { repository: await WorkbenchGitRepository.open(clone), root, source: clone };
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
  templateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-arc-owner-template-"));
  await git(templateRoot, ["init", "-b", "main"]);
  await fs.writeFile(path.join(templateRoot, "one.txt"), "one\n");
  await fs.writeFile(path.join(templateRoot, "two.txt"), "two\n");
  await git(templateRoot, ["add", "-A"]);
  await git(templateRoot, ["commit", "-m", "base"]);

  sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-arc-owner-shared-"));
  sharedSource = path.join(sharedRoot, "source");
  await git(sharedRoot, ["clone", "--quiet", templateRoot, sharedSource]);
  await git(sharedSource, ["remote", "remove", "origin"]);
  sharedRepository = await WorkbenchGitRepository.open(sharedSource);
  baseCommit = await sharedRepository.currentHead();
});

beforeEach(async () => {
  await fs.rm(path.join(sharedSource, ".workbench"), { force: true, recursive: true });
  await git(sharedSource, ["checkout", "--force", "--quiet", "-B", "main", baseCommit]);
  const entries = await fs.readdir(sharedSource);
  if (entries.some((entry) => ![".git", "one.txt", "two.txt"].includes(entry))) {
    await git(sharedSource, ["clean", "-fdx", "--quiet"]);
  }
  const refs = await sharedRepository.listRefs("refs/worktree");
  if (refs.length) await sharedRepository.updateRefs([], refs.map((ref) => ({ ref })));
});

after(async () => {
  await fs.rm(sharedRoot, { force: true, recursive: true });
  await fs.rm(templateRoot, { force: true, recursive: true });
});

test("active arc registry rejects sibling overlap and releases claims without touching the worktree", async (context) => {
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

test("active arc registry keeps start idempotent and rejects stale same-thread replacement", async (context) => {
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

test("publish state fails closed when a configured remote cannot refresh", async (context) => {
  const local = await createRepository(context, true);
  await git(local.source, ["remote", "set-url", "origin", path.join(local.root, "missing.git")]);
  const state = await new GitArcPublishState(local.repository).classifyCurrentHead();
  assert.equal(state.kind, "unknown");
  if (state.kind === "unknown") assert.match(state.reason, /Unable to refresh remote refs/u);
  await git(local.source, ["checkout", "--detach", "--quiet"]);
  assert.deepEqual(await new GitArcPublishState(local.repository).classifyCurrentHead(), { kind: "detached" });
});

test("proposal cache reuses derived changes beneath the canonical harness transcript", async (context) => {
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

test("arc start requires fresh v3 plans but adopts dirty legacy arcs into the registry", async (context) => {
  const { repository, source } = await createRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const fresh = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "fresh plan",
    paths: ["one.txt"],
    threadId: "fresh-thread",
  });
  await fs.writeFile(path.join(source, "one.txt"), "dirty before start\n");
  await assert.rejects(controller.startArc({
    checkpointCommit: fresh.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "fresh-thread",
  }), /Arc start paths changed after the plan was created: one\.txt/u);

  await fs.writeFile(path.join(source, "one.txt"), "legacy implementation\n");
  const tree = await repository.writeWorktreeTree();
  const head = await repository.currentHead();
  const legacyCommit = await repository.createCommitFromTree(tree, head, [
    "workbench-git-checkpoint-v1",
    JSON.stringify({ amendedFrom: null, intentName: "legacy plan", kind: "arc", scopePaths: ["two.txt"], version: 2 }),
    "",
  ].join("\n"));
  await repository.updateRef(`refs/worktree/agents/legacy-thread/checkpoints/legacy-${legacyCommit.slice(0, 7)}`, legacyCommit);
  await fs.writeFile(path.join(source, "two.txt"), "legacy implementation\n");
  const adopted = await controller.startArc({
    checkpointCommit: legacyCommit,
    cwd: source,
    harness: "opencode",
    threadId: "legacy-thread",
  });
  assert.deepEqual(adopted.changes.map((change) => change.path), ["two.txt"]);
  const active = await new GitArcRegistry(repository).find({ harness: "opencode", threadId: "legacy-thread" });
  assert.equal(active?.checkpointCommit, legacyCommit);
  assert.deepEqual(active?.claimedPaths, ["two.txt"]);
});

test("arc adopt claims dirty workspace paths from HEAD without changing worktree or index state", async (context) => {
  const { repository, source } = await createRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  await fs.writeFile(path.join(source, "deleted.txt"), "delete me\n");
  await fs.writeFile(path.join(source, "staged.txt"), "staged base\n");
  await git(source, ["add", "deleted.txt", "staged.txt"]);
  await git(source, ["commit", "-m", "add adoption fixtures"]);

  const plan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "adopt workspace work",
    paths: ["one.txt"],
    threadId: "adopt-thread",
  });
  await controller.startArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "adopt-thread",
  });

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

test("failed arc adoption publishes neither a successor ref nor a replacement registry entry", async (context) => {
  const { repository, source } = await createRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  const plan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "atomic adoption",
    paths: ["one.txt"],
    threadId: "adopt-owner",
  });
  await controller.startArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "adopt-owner",
  });
  const registry = new GitArcRegistry(repository);
  await registry.claim({
    checkpointCommit: await repository.currentHead(),
    claimedPaths: ["collision.txt"],
    harness: "opencode",
    intentDescription: "",
    intentName: "sibling collision",
    proposalId: null,
    threadId: "sibling-thread",
  });
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

test("partial proposal commit atomically records and returns the remaining-file successor", async (context) => {
  const { repository, source } = await createRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  await createTranscript(repository, "codex", "partial-thread");
  const plan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "change both files",
    paths: ["one.txt", "two.txt"],
    threadId: "partial-thread",
  });
  await controller.startArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "partial-thread",
  });
  await fs.writeFile(path.join(source, "one.txt"), "committed one\n");
  await fs.writeFile(path.join(source, "two.txt"), "remaining two\n");
  const proposal = await controller.createProposal({
    cwd: source,
    description: "",
    harness: "codex",
    paths: ["one.txt"],
    threadId: "partial-thread",
    title: "commit one",
  });
  await controller.commitProposal({
    cwd: source,
    description: "",
    harness: "codex",
    includeNewer: false,
    proposalId: proposal.proposalId,
    threadId: "partial-thread",
    title: "commit one",
  });
  const active = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "partial-thread" });
  assert.deepEqual(active?.claimedPaths, ["two.txt"]);
  assert.notEqual(active?.checkpointCommit, plan.checkpointCommit);

  const continued = await controller.continueArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "partial-thread",
  });
  assert.equal(continued.checkpointCommit, active?.checkpointCommit);
  assert.deepEqual(continued.scopePaths, ["two.txt"]);
  assert.equal(await fs.readFile(path.join(source, "two.txt"), "utf8"), "remaining two\n");
});

test("amend proposals inherit messages, replace unpushed HEAD, and supersede the prior proposal", async (context) => {
  const { repository, source } = await createRepository(context);
  const controller = new WorkbenchGitCheckpointController();
  await createTranscript(repository, "codex", "amend-thread");
  const plan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "amend lifecycle",
    paths: ["one.txt"],
    threadId: "amend-thread",
  });
  await controller.startArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "amend-thread",
  });
  await fs.writeFile(path.join(source, "one.txt"), "first proposal\n");
  const first = await controller.createProposal({
    cwd: source,
    description: "Original description",
    harness: "codex",
    threadId: "amend-thread",
    title: "Original title",
  });
  const firstCommit = await controller.commitProposal({
    cwd: source,
    description: first.description,
    harness: "codex",
    includeNewer: false,
    proposalId: first.proposalId,
    threadId: "amend-thread",
    title: first.title,
  });
  const originalParent = await repository.resolveParent(firstCommit.committedSha!);
  const continued = await controller.continueArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "amend-thread",
  });
  const continuedAgain = await controller.continueArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "amend-thread",
  });
  assert.equal(continuedAgain.checkpointCommit, continued.checkpointCommit);
  await fs.writeFile(path.join(source, "one.txt"), "amended proposal\n");
  const amendment = await controller.createProposal({
    amend: true,
    cwd: source,
    description: "",
    harness: "codex",
    threadId: "amend-thread",
    title: "",
  });
  const amendmentPreview = await controller.getProposal({
    cwd: source,
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "amend-thread",
  });
  assert.equal(amendmentPreview.mode, "amend");
  assert.equal(amendmentPreview.title, "Original title");
  assert.equal(amendmentPreview.description, "Original description");
  assert.match(amendmentPreview.changes[0]?.diff ?? "", /amended proposal/u);

  const amended = await controller.commitProposal({
    cwd: source,
    description: amendmentPreview.description,
    harness: "codex",
    includeNewer: false,
    proposalId: amendment.proposalId,
    threadId: "amend-thread",
    title: amendmentPreview.title,
  });
  assert.equal(await repository.resolveParent(amended.committedSha!), originalParent);
  assert.equal(await fs.readFile(path.join(source, "one.txt"), "utf8"), "amended proposal\n");
  const superseded = await controller.getProposal({
    cwd: source,
    harness: "codex",
    includeNewer: false,
    proposalId: first.proposalId,
    threadId: "amend-thread",
  });
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededByProposalId, amendment.proposalId);
  assert.equal(superseded.supersededBySha, amended.committedSha);
});

test("amend proposal creation rejects HEAD already contained by a refreshed remote ref", async (context) => {
  const { source } = await createRepository(context, true);
  const controller = new WorkbenchGitCheckpointController();
  const plan = await controller.createPlan({
    cwd: source,
    harness: "codex",
    intentName: "reject pushed amend",
    paths: ["one.txt"],
    threadId: "pushed-thread",
  });
  await controller.startArc({
    checkpointCommit: plan.checkpointCommit,
    cwd: source,
    harness: "codex",
    threadId: "pushed-thread",
  });
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
