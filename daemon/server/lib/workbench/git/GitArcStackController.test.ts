/*
 * Exports: none. Protect stack layer waiting, sealing, reopening, history rewrites and subagent transfer on prepared branches.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import GitArcRegistry from "./GitArcRegistry";
import GitCheckpointStore from "./GitCheckpointStore";
import GitTestFixtureCache, { type GitTestFixtureCopy } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { STACK_OPERATIONS_FIXTURE, type StackFixtureState } from "./GitArcControllerTestFixtures";

const fixtures = new GitTestFixtureCache();
const controller = new WorkbenchGitCheckpointController();
let fixture: GitTestFixtureCopy<StackFixtureState> | null = null;
before(async () => { fixture = await fixtures.copy(STACK_OPERATIONS_FIXTURE); }, { timeout: 30_000 });
after(async () => { await fixture?.dispose(); });

function branch<Key extends keyof StackFixtureState>(key: Key) {
  const state = fixture!.state[key];
  const cwd = path.join(fixture!.bundleRoot, state.root);
  const commit = async (threadId: string, proposalId: string, title: string) => await controller.commitProposal({
    cwd, threadId, proposalId, title, description: "", includeNewer: false,
  });
  const read = async (threadId: string, proposalId: string) => await controller.getProposal({ cwd, threadId, proposalId, includeNewer: false });
  const git = async (...args: string[]) => await (await WorkbenchGitRepository.open(cwd)).run(args);
  return { commit, cwd, git, read, state };
}

test("stacked proposals wait on sealed layers, reject sealed mutations and land bottom-up", async () => {
  const { commit, cwd, git, read, state } = branch("stacked");
  const owner = { cwd, threadId: "owner" };
  const repository = await WorkbenchGitRepository.open(cwd);
  const refsBeforeConflict = await repository.listRefsWithValues("refs/worktree");
  await fs.writeFile(path.join(cwd, "one.txt"), "third\n");
  await assert.rejects(controller.createProposal({
    ...owner, amend: true, amendProposalId: state.lower, paths: ["one.txt"], title: "conflicting revision", description: "",
  }), (error) => error instanceof GitArcRejectionError && error.rejection.reason === "proposalRevisionConflict");
  assert.deepEqual(await repository.listRefsWithValues("refs/worktree"), refsBeforeConflict,
    "a conflicting lower-layer revision leaves every Workbench ref unchanged");
  await fs.writeFile(path.join(cwd, "one.txt"), "second\n");

  const revised = await controller.createProposal({
    ...owner, amendProposalId: state.lower, title: "first revised", description: "Clearer message.",
  });
  assert.equal((await read("owner", state.lower)).status, "superseded");
  assert.equal((await read("owner", revised.proposalId)).sealedInLayer, "layer one");
  const upper = await read("owner", state.upper);
  assert.equal(upper.waitingForLayer, "layer one");
  assert.match(upper.changes[0]!.diff, /-first\n\+second/u, "stacked work diffs from the sealed layer");
  const lower = await read("owner", revised.proposalId);
  assert.equal(lower.sealedInLayer, "layer one");
  assert.equal(lower.title, "first revised");
  assert.equal(lower.includeNewerAvailable, false, "newer work belongs to the upper layer");
  const status = await controller.readStatus(owner);
  assert.deepEqual(status.stacked, [{ title: "layer one", pending: [{ proposalId: revised.proposalId, title: "first revised" }] }]);
  assert.deepEqual(status.pending, [{ proposalId: state.upper, title: "second" }]);

  await assert.rejects(controller.rescindProposal({ ...owner, proposalId: revised.proposalId }), /sealed/iu);
  await assert.rejects(commit("owner", state.upper, "second"), /layer one/u);
  await assert.rejects(controller.unstackArc(owner), /builds on/iu);
  await assert.rejects(controller.stashArc(owner), /stack/iu);
  await assert.rejects(controller.adoptArc({ cwd, threadId: "other", source: { harness: "codex", threadId: "owner" } }), /stack/iu);
  assert.deepEqual(await controller.readScope(owner).then(scope => scope?.claimedPaths), ["one.txt"], "rejections leave ownership intact");

  await commit("owner", revised.proposalId, "first revised");
  assert.equal(await git("show", "HEAD:one.txt"), "first\n");
  assert.equal((await read("owner", state.upper)).waitingForLayer, null);
  await commit("owner", state.upper, "second");
  assert.equal(await git("show", "HEAD:one.txt"), "second\n");
  assert.equal((await controller.findLifecycleState(owner))?.stackLayers, undefined, "a landed stack stops shaping the baseline");
  // Accepted commits carry their proposal time, not the moment each layer happened to land.
  const store = new GitCheckpointStore(await WorkbenchGitRepository.open(cwd));
  const proposedAt = await Promise.all([state.upper, state.lower]
    .map(async id => (await store.readProposal("codex", "owner", id)).metadata.proposedAt));
  assert.ok(proposedAt.every(Boolean));
  assert.deepEqual((await git("log", "-2", "--date=raw", "--format=%ad|%cd")).trim().split("\n"),
    proposedAt.map(date => `${date}|${date}`));
});

test("a lower layer that lands differently makes stacked proposals unavailable", async () => {
  const { read, state } = branch("broken");
  const upper = await read("owner", state.upper);
  assert.equal(upper.status, "unavailable");
  assert.equal(upper.waitingForLayer, null);
});

test("claim and plan changes keep sealed proposals visible, and unstack reopens an unused top layer", async () => {
  const { cwd, read, state } = branch("sealed");
  const owner = { cwd, threadId: "owner" };
  await controller.editArcClaims({ ...owner, inherit: true, addPaths: ["three.txt"] });
  assert.equal((await read("owner", state.lower)).status, "proposed", "continuing work never retires a sealed layer");
  assert.deepEqual((await controller.findLifecycleState(owner))?.proposals.map(({ proposalId }) => proposalId), [state.lower],
    "the sealed proposal stays in the lifecycle list that stack cards render from");

  await fs.writeFile(path.join(cwd, "one.txt"), "first revised\n");
  const revision = await controller.createProposal({
    ...owner, amend: true, amendProposalId: state.lower, paths: ["one.txt"], title: "first revised", description: "",
  });
  assert.equal((await read("owner", state.lower)).status, "superseded");
  assert.match((await read("owner", revision.proposalId)).changes[0]!.diff, /\+first revised/u);
  const reopened = await controller.unstackArc(owner);
  assert.deepEqual([reopened.proposalIds, reopened.stackTip], [[revision.proposalId], null]);
  assert.deepEqual(reopened.layerProposals, [{
    changes: [{ additions: 1, deletions: 1, kind: "update", path: "one.txt" }],
    description: "", proposalId: revision.proposalId, title: "first revised",
  }], "the tip recorded each sealed message and file totals");
  await controller.rescindProposal({ ...owner, proposalId: revision.proposalId });
  await assert.rejects(controller.unstackArc(owner), /stack layer/iu);

  await controller.createPlan({ ...owner, intentName: "upper work", paths: ["one.txt", "three.txt"] });
  const landed = await controller.createProposal({ ...owner, title: "landed before later sealing", description: "" });
  await fs.writeFile(path.join(cwd, "one.txt"), "replacement\n");
  await controller.commitProposal({
    ...owner, proposalId: landed.proposalId, title: "landed before later sealing", description: "", includeNewer: false,
  });
  const replacement = await controller.createProposal({ ...owner, title: "replacement", description: "" });
  await controller.stackArc({ ...owner, title: "replacement layer" });
  const plan = await controller.createPlan({ ...owner, intentName: "upper work", paths: ["one.txt", "three.txt"] });
  await controller.startArc({ ...owner, checkpointCommit: plan.checkpointCommit });
  assert.ok((await controller.findLifecycleState(owner))?.proposals.some(({ proposalId }) => proposalId === replacement.proposalId),
    "activating successor work keeps the sealed proposal in lifecycle ownership");

  const repository = await WorkbenchGitRepository.open(cwd);
  const registry = new GitArcRegistry(repository);
  const active = await registry.find({ harness: "codex", threadId: owner.threadId });
  assert.ok(active);
  await registry.set({ ...active, proposalId: null, proposalIds: [] }, active.checkpointCommit);
  assert.deepEqual((await controller.findLifecycleState(owner))?.proposals.map(({ proposalId }) => proposalId), [replacement.proposalId],
    "stack metadata recovers proposals omitted by older lifecycle state");
  await controller.commitProposal({
    ...owner, proposalId: replacement.proposalId, title: "replacement", description: "", includeNewer: false,
  });
  assert.equal(await repository.run(["show", "HEAD:one.txt"]), "replacement\n");
});

test("outside commits on unsealed paths never strand work beneath a pending stack", async () => {
  const { commit, cwd, git, read, state } = branch("sibling");
  const owner = { cwd, threadId: "owner" };
  const repository = await WorkbenchGitRepository.open(cwd);
  await controller.editArcClaims({ ...owner, inherit: true, addPaths: ["two.txt"] });
  await fs.writeFile(path.join(cwd, "two.txt"), "sibling\nowner\n");
  await controller.editArcClaims({ ...owner, inherit: true, addPaths: ["three.txt"] });
  await controller.continueArc(owner);
  assert.deepEqual((await controller.compare({ ...owner, paths: ["two.txt"] })).changes
    .map(({ additions, deletions, path: filePath }) => ({ additions, deletions, filePath })),
  [{ additions: 1, deletions: 0, filePath: "two.txt" }], "the outside commit is not the owner's change");

  const upper = await controller.createProposal({ ...owner, paths: ["two.txt"], title: "owner two", description: "" });
  const { stackBase } = (await new GitCheckpointStore(repository).readProposal("codex", "owner", upper.proposalId)).metadata;
  assert.equal((await repository.readCommitAt(stackBase!))?.identity.parents[0], await repository.currentHead(),
    "the pending stack rebased onto the outside commit");
  const { diff } = (await read("owner", upper.proposalId)).changes[0]!;
  assert.match(diff, /^\+owner$/mu);
  assert.doesNotMatch(diff, /^[-+]sibling$/mu);

  await commit("owner", state.lower, "first");
  await commit("owner", upper.proposalId, "owner two");
  assert.equal(await git("show", "HEAD:one.txt"), "first\n");
  assert.equal(await git("show", "HEAD:two.txt"), "sibling\nowner\n");
});

test("accepting a sealed amend rewrites the stack onto the amended history", async () => {
  const { commit, cwd, git, state } = branch("amended");
  await controller.commitProposal({
    cwd, threadId: "owner", proposalId: state.amendment, title: "first amended", description: "", includeNewer: false, mode: "amend",
  });
  const repository = await WorkbenchGitRepository.open(cwd);
  const { stackBase } = (await new GitCheckpointStore(repository).readProposal("codex", "owner", state.upper)).metadata;
  assert.equal((await repository.readCommitAt(stackBase!))?.identity.parents[0], await repository.currentHead(),
    "the stacked base follows the rewritten HEAD");
  await commit("owner", state.upper, "stacked");
  assert.equal(await git("show", "HEAD:one.txt"), "stacked\n");
  assert.equal(await git("log", "-1", "--format=%s", "HEAD~1"), "first amended\n");
});

test("transferred claims keep sealed proposals committable, never lower a stack tip, and fast-forward a child on a lower layer", async () => {
  const { commit, cwd, git, read, state } = branch("transfer");
  const registry = new GitArcRegistry(await WorkbenchGitRepository.open(cwd));
  const owner = async (threadId: string) => await registry.find({ harness: "codex", threadId });
  const parentTip = (await owner("parent"))?.stackTip;
  const childTip = (await owner("child"))?.stackTip;
  const revisedLower = await controller.createProposal({
    cwd, threadId: "parent", amendProposalId: state.lower, title: "parent one revised", description: "",
  });
  assert.notEqual((await owner("parent"))?.stackTip, parentTip, "the parent's dependent upper layer follows the revision");
  assert.notEqual((await owner("child"))?.stackTip, childTip, "the child's inherited lower-layer tip follows the revision");
  // The child holds three.txt on layer one; the parent has since sealed layer two. Taking it back keeps the parent's top.
  await (await controller.prepareAdoption({
    cwd, threadId: "parent", source: { harness: "codex", threadId: "child" }, selectedPaths: ["three.txt"],
  })).apply();
  const revisedParentTip = (await owner("parent"))?.stackTip;
  assert.deepEqual([(await owner("parent"))?.stackTip, (await owner("child"))?.claimedPaths], [revisedParentTip, []]);
  await (await controller.prepareReleaseToChild({
    cwd, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["two.txt"],
  })).apply();
  await assert.rejects(controller.editArcClaims({ cwd, threadId: "child", inherit: true, removePaths: ["two.txt"] }),
    (error) => error instanceof GitArcRejectionError && error.rejection.reason === "sealedStackContent",
    "unlanded sealed content keeps its claim, and says so");
  await fs.writeFile(path.join(cwd, "two.txt"), "child builds on two\n");
  // Build views hold other owners' dirty claims at their stack-aware baselines and mirror only into ignored folders.
  await fs.appendFile(path.resolve(cwd, (await git("rev-parse", "--git-path", "info/exclude")).trim()), "\nbuild-out/\n");
  const out = path.join(cwd, "build-out");
  const view = async (threadId: string, holdOwn = false) => {
    const built = await controller.readClaimView({ cwd, threadId, holdOwn });
    return { ...built, ...await controller.mirrorClaimView({ into: out, paths: ["two.txt"], repoRoot: built.repoRoot, tree: built.tree }) };
  };
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, "keep.txt"), "outside the mirrored paths\n");
  const parentView = await view("parent");
  assert.ok(parentView.held.some(({ paths, threadId }) => threadId === "child" && paths.includes("two.txt")));
  assert.deepEqual([(await fs.readdir(out)).sort(), await fs.readFile(path.join(out, "two.txt"), "utf8")], [[".wb-arc-tree.json", "keep.txt", "two.txt"], "parent two\n"]);
  const unchanged = await controller.mirrorClaimView({ into: out, paths: ["two.txt"], repoRoot: parentView.repoRoot, tree: parentView.tree });
  assert.deepEqual([unchanged.written, unchanged.deleted], [0, 0], "unchanged files are left alone");
  await view("child");
  assert.equal(await fs.readFile(path.join(out, "two.txt"), "utf8"), "child builds on two\n");
  await view("child", true);
  assert.equal(await fs.readFile(path.join(out, "two.txt"), "utf8"), "parent two\n", "the child's baseline is the parent's newest layer");
  // Whole-tree mirrors never touch files they didn't write, and remove their own once those leave the view.
  assert.ok((await controller.mirrorClaimView({ into: out, paths: [], repoRoot: cwd, tree: parentView.tree })).written > 0);
  const emptySource = path.resolve(cwd, (await git("rev-parse", "--git-path", "wb-empty-tree")).trim());
  await fs.writeFile(emptySource, "");
  const emptyTree = (await git("hash-object", "-t", "tree", "-w", emptySource)).trim();
  await controller.mirrorClaimView({ into: out, paths: [], repoRoot: cwd, tree: emptyTree });
  assert.deepEqual(await fs.readdir(out), ["keep.txt"]);
  await assert.rejects(controller.mirrorClaimView({ into: path.join(cwd, "tracked-out"), paths: [], repoRoot: cwd, tree: parentView.tree }), /gitignored/u);
  const child = await controller.createProposal({ cwd, threadId: "child", paths: ["two.txt"], title: "child", description: "" });
  assert.equal((await read("child", child.proposalId)).waitingForLayer, "layer one", "it waits on the lowest unlanded layer");
  // Both layers land in one batch; the batch stops at its first failure with earlier entries landed.
  const batch = await controller.commitProposals({ cwd, threadId: "parent", entries: [
    { proposalId: revisedLower.proposalId, title: "parent one revised", description: "", includeNewer: false },
    { proposalId: state.upper, title: "parent two", description: "", includeNewer: false },
    { proposalId: "missing", title: "missing", description: "", includeNewer: false },
  ] });
  assert.deepEqual([batch.landed.map(({ status, title }) => `${title}:${status}`), batch.failed?.proposalId],
    [["parent one revised:committed", "parent two:committed"], "missing"]);
  assert.equal(await git("log", "-2", "--format=%s"), "parent two\nparent one revised\n");
  // Landed parent layers are the child's baseline, not drift in its claims.
  assert.match((await controller.diff({ cwd, threadId: "child", paths: ["two.txt"] })).diff, /-parent two\n\+child builds on two/u);
  // The parent commits one.txt past the landing, then hands it over: the child's checkpoint moves onto that HEAD,
  // so its landed tip must stop measuring the later commit.
  await controller.editArcClaims({ cwd, threadId: "parent", inherit: true, addPaths: ["one.txt"] });
  await fs.writeFile(path.join(cwd, "one.txt"), "parent three\n");
  const later = await controller.createProposal({ cwd, threadId: "parent", paths: ["one.txt"], title: "parent three", description: "" });
  await fs.writeFile(path.join(cwd, "one.txt"), "handed over\n");
  await commit("parent", later.proposalId, "parent three");
  await (await controller.prepareReleaseToChild({
    cwd, threadId: "child", source: { harness: "codex", threadId: "parent" }, selectedPaths: ["one.txt"],
  })).apply();
  assert.match((await controller.diff({ cwd, threadId: "child", paths: ["one.txt"] })).diff, /-parent three\n\+handed over/u);
  await controller.editArcClaims({ cwd, threadId: "child", inherit: true });
  await commit("child", child.proposalId, "child");
  assert.equal(await git("show", "HEAD:two.txt"), "child builds on two\n");
});
