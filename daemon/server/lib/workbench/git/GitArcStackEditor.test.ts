/*
 * Exports: none. Protect stack edits: revisions and restacks rebase later proposals by merge so layer tips keep every
 * proposal's work, publish atomically, never touch the worktree, return released paths to active claims, and reject
 * only when they would change a file another thread holds. Also covers unstack and retention of inherited stack tips.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { STACK_EDITOR_FIXTURE, STACK_OPERATIONS_FIXTURE, type StackEditorFixtureState, type StackFixtureState } from "./GitArcControllerTestFixtures";
import GitArcRegistry from "./GitArcRegistry";
import GitArcStackEditor from "./GitArcStackEditor";
import GitCheckpointStore from "./GitCheckpointStore";
import GitTestFixtureCache, { type GitTestFixtureCopy } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const controller = new WorkbenchGitCheckpointController();
const fixtures = new GitTestFixtureCache();
let editor: GitTestFixtureCopy<StackEditorFixtureState> | null = null;
let stacks: GitTestFixtureCopy<StackFixtureState> | null = null;
before(async () => {
  [editor, stacks] = await Promise.all([fixtures.copy(STACK_EDITOR_FIXTURE), fixtures.copy(STACK_OPERATIONS_FIXTURE)]);
}, { timeout: 60_000 });
after(async () => { await Promise.all([editor?.dispose(), stacks?.dispose()]); });

function branch<Key extends keyof StackEditorFixtureState>(key: Key) {
  const state = editor!.state[key];
  const cwd = path.join(editor!.bundleRoot, state.root);
  const repository = async () => await WorkbenchGitRepository.open(cwd);
  const stackTip = async () => (await new GitArcRegistry(await repository()).find({ harness: "codex", threadId: "owner" }))?.stackTip ?? null;
  const tipFiles = async (paths: string[]) => {
    const tip = await stackTip();
    assert.ok(tip);
    const files = await (await repository()).readTreeFiles(tip, paths);
    return Object.fromEntries(paths.map(file => [file, files.get(file)?.bytes.toString("utf8") ?? null]));
  };
  const worktreeFiles = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async file => (
    [file, await fs.readFile(path.join(cwd, file), "utf8").catch(() => null)] as const
  ))));
  const refs = async () => await (await repository()).listRefsWithValues("refs/worktree");
  const status = async (proposalId: string) => (await new GitCheckpointStore(await repository()).readProposal("codex", "owner", proposalId)).metadata.status;
  return { cwd, refs, stackTip, state, status, tipFiles, worktreeFiles };
}

const MOD_FILES = ["doc.txt", "feature.txt", "lock.txt", "mod/a.txt", "mod/b.txt"];

test("revising a lower proposal keeps upper layers' edits to the same file in the top tip", async () => {
  const { cwd, state, tipFiles } = branch("shared");
  await fs.writeFile(path.join(cwd, "shared.txt"), "A\nB\nc\nd\nE\n");
  await controller.createProposal({
    cwd, threadId: "owner", amend: true, amendProposalId: state.lower, paths: ["shared.txt"], title: "lower revised", description: "",
  });
  assert.deepEqual(await tipFiles(["shared.txt"]), { "shared.txt": "A\nB\nc\nd\nE\n" });
});

test("restack rejections leave every Workbench ref unchanged", async () => {
  const { cwd, refs, state } = branch("mod");
  const before = await refs();
  const rejects = async (edits: Parameters<typeof controller.restackArc>[0], reason: string) => {
    await assert.rejects(controller.restackArc(edits), (error) => error instanceof GitArcRejectionError && error.rejection.reason === reason);
    assert.deepEqual(await refs(), before, reason);
  };
  // The feature layer still edits a file only the dropped layer created.
  await rejects({ cwd, threadId: "owner", drop: [state.mod] }, "restackConflict");
  await rejects({ cwd, threadId: "owner", drop: [state.mod], strip: [{ proposalId: state.feature, paths: ["doc.txt", "feature.txt", "mod"] }] }, "proposalEmptied");
  await rejects({ cwd, threadId: "owner", fold: [{ proposalId: state.mod, into: state.removal }] }, "invalidFoldTarget");
});

test("restack drops, strips and folds in one transaction without touching the worktree", async () => {
  const { cwd, state, status, tipFiles, worktreeFiles } = branch("mod");
  const worktree = await worktreeFiles(MOD_FILES);
  const result = await controller.restackArc({
    cwd, threadId: "owner",
    drop: [state.mod],
    fold: [{ proposalId: state.removal, into: state.feature }],
    strip: [{ proposalId: state.feature, paths: ["mod"] }],
  });
  const replacement = result.proposals.find(outcome => outcome.proposalId === state.feature);
  assert.ok(replacement && "replacementId" in replacement);
  assert.deepEqual(result.layers, [{ proposalIds: [replacement.replacementId], title: "feature" }]);
  // Outcomes name each proposal and the files a strip took out, so the transcript can say what happened.
  assert.deepEqual(new Map(result.proposals.map(outcome => [outcome.proposalId, outcome])), new Map([
    [state.feature, { proposalId: state.feature, replacementId: replacement.replacementId, status: "replaced", stripped: ["mod/a.txt"], title: "feature" }],
    [state.mod, { proposalId: state.mod, status: "rescinded", title: "add mod" }],
    [state.removal, { proposalId: state.removal, replacementId: replacement.replacementId, status: "superseded", stripped: [], title: "remove mod" }],
  ]));
  assert.deepEqual(
    [await status(state.mod), await status(state.removal), await status(state.feature), await status(replacement.replacementId)],
    ["rescinded", "superseded", "superseded", "proposed"],
  );
  assert.deepEqual(await worktreeFiles(MOD_FILES), worktree, "the worktree is untouched");
  assert.deepEqual(await tipFiles(MOD_FILES), worktree, "the new top tip holds exactly the work that remains");
  assert.deepEqual(result.releasedClaims, ["lock.txt", "mod/a.txt", "mod/b.txt"]);
  const claims = await controller.readStatus({ cwd, threadId: "owner" });
  assert.ok(result.releasedClaims.every(file => [...claims.dirtyClaims, ...claims.cleanClaims].includes(file)),
    "dropped and stripped paths return to active claims");
});

/**
 * A private copy of the transfer branch: parent sealed one.txt in layer one and two.txt in layer two;
 * child inherited layer one and holds dirty three.txt.
 */
async function transferBranch(name: string) {
  const { lower, root, upper } = stacks!.state.transfer;
  const cwd = path.join(stacks!.bundleRoot, `r/${name}`);
  await fs.cp(path.join(stacks!.bundleRoot, root), cwd, { recursive: true });
  const repository = await WorkbenchGitRepository.open(cwd);
  const tip = async (threadId: string) => (await new GitArcRegistry(repository).find({ harness: "codex", threadId }))?.stackTip ?? null;
  const hand = async (from: string, to: string, selectedPaths: string[]) => await (await controller.prepareReleaseToChild({
    cwd, threadId: to, source: { harness: "codex", threadId: from }, selectedPaths,
  })).apply();
  const refs = async () => await repository.listRefsWithValues("refs/worktree");
  const write = async (file: string, content: string) => await fs.writeFile(path.join(cwd, file), content);
  return { cwd, hand, lower, refs, repository, tip, upper, write };
}

function inUse(...names: RegExp[]) {
  return (error: unknown) => error instanceof GitArcRejectionError
    && error.rejection.reason === "stackLayerInUse"
    && names.every(name => name.test(error.message));
}

test("restack under a live child on other files leaves its proposal landable", async () => {
  const { cwd, lower, repository, tip } = await transferBranch("disjoint-child");
  const { proposalId } = await controller.createProposal({ cwd, threadId: "child", paths: ["three.txt"], title: "child", description: "" });
  const before = await tip("child");
  await controller.restackArc({ cwd, threadId: "parent", drop: [lower] });
  assert.notEqual(await tip("child"), before, "the child's tip follows the rewrite");
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "child" })).pending, [{ proposalId, title: "child" }]);
  await controller.commitProposal({ cwd, threadId: "child", proposalId, title: "child", description: "", includeNewer: false });
  assert.equal(await repository.run(["show", "HEAD:three.txt"]), "child start\n");
});

test("restack rejects changing a file another thread claims, leaving its diff alone", async () => {
  const { cwd, hand, lower, refs } = await transferBranch("claimed-file");
  await hand("parent", "child", ["one.txt"]);
  const before = await refs();
  const diff = await controller.diff({ cwd, threadId: "child", paths: ["one.txt"] });
  await assert.rejects(controller.restackArc({ cwd, threadId: "parent", drop: [lower] }), inUse(/child \(one\.txt\)/u));
  assert.deepEqual(await refs(), before);
  assert.deepEqual(await controller.diff({ cwd, threadId: "child", paths: ["one.txt"] }), diff);
});

test("restack rejection names every thread holding a changed file", async () => {
  const { cwd, hand, lower, upper, write } = await transferBranch("two-holders");
  await hand("parent", "child", ["one.txt"]);
  await hand("parent", "other", ["two.txt"]);
  // A pending proposal on a changed file would otherwise surface as a raw merge conflict naming no thread.
  await write("one.txt", "child one\n");
  await controller.createProposal({ cwd, threadId: "child", paths: ["one.txt"], title: "child one", description: "" });
  await assert.rejects(controller.restackArc({ cwd, threadId: "parent", drop: [lower, upper] }),
    inUse(/child \(one\.txt\)/u, /other \(two\.txt\)/u));
});

test("fold under a child on the top tip changes nothing it holds", async () => {
  const { cwd, hand, lower, tip, upper, write } = await transferBranch("fold-at-top");
  await hand("parent", "child", ["two.txt"]);
  await write("two.txt", "child two\n");
  const before = await tip("child");
  const diff = await controller.diff({ cwd, threadId: "child", paths: ["two.txt"] });
  await controller.restackArc({ cwd, threadId: "parent", fold: [{ proposalId: upper, into: lower }] });
  assert.notEqual(await tip("child"), before);
  assert.deepEqual(await controller.diff({ cwd, threadId: "child", paths: ["two.txt"] }), diff);
});

test("restack skips a thread that holds nothing, even its conflicting rescinded proposal", async () => {
  const { cwd, hand, lower, tip, write } = await transferBranch("quiet-child");
  await hand("parent", "child", ["one.txt"]);
  await write("one.txt", "child one\n");
  const { proposalId } = await controller.createProposal({ cwd, threadId: "child", paths: ["one.txt"], title: "child one", description: "" });
  await controller.rescindProposal({ cwd, threadId: "child", proposalId });
  await hand("child", "parent", ["one.txt", "three.txt"]);
  assert.ok(await tip("child"), "the quiet child still inherits the stack");
  await controller.restackArc({ cwd, threadId: "parent", drop: [lower] });
});

test("revision rejects changing a file another thread claims", async () => {
  const { hand, lower, refs, repository } = await transferBranch("revised-file");
  await hand("parent", "child", ["one.txt"]);
  const before = await refs();
  await assert.rejects(new GitArcStackEditor(repository).apply({ harness: "codex", threadId: "parent" }, {
    revise: {
      description: "", livePaths: ["one.txt"], paths: ["one.txt"], proposalId: lower, sourceCheckpoint: "unused", title: "revised",
      tree: await repository.resolveTree(await repository.headOrNull()),
    },
  }), inUse(/child \(one\.txt\)/u));
  assert.deepEqual(await refs(), before);
});

test("unstack rejects naming all live threads on the top layer, and detaches quiet ones", async () => {
  const { cwd, hand, tip } = await transferBranch("unstack");
  await hand("parent", "child", ["two.txt"]);
  await hand("parent", "other", ["one.txt"]);
  await assert.rejects(controller.unstackArc({ cwd, threadId: "parent" }), inUse(/child \(live claims\)/u, /other \(live claims\)/u));
  await hand("child", "parent", ["two.txt", "three.txt"]);
  await hand("other", "parent", ["one.txt"]);
  assert.ok(await tip("child"), "the quiet child still inherits the stack");
  await controller.unstackArc({ cwd, threadId: "parent" });
  assert.deepEqual([await tip("child"), await tip("other")], [null, null]);
});

test("an inherited stack tip does not hold a quiet thread's history, but an owned layer does", async () => {
  const { cwd, hand, tip } = await transferBranch("retention");
  await hand("child", "parent", ["three.txt"]);
  assert.ok(await tip("child"), "the quiet child still inherits the stack");
  assert.equal(await controller.canPruneThreadHistory({ cwd, harness: "codex", threadId: "child" }), true);
  assert.equal(await controller.canPruneThreadHistory({ cwd, harness: "codex", threadId: "parent" }), false);
});
