/*
 * Exports: none. Protect stack edits: revisions and restacks rebase later proposals by merge so layer tips keep every
 * proposal's work, publish atomically, never touch the worktree, and return released paths to active claims.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { STACK_EDITOR_FIXTURE, STACK_OPERATIONS_FIXTURE, type StackEditorFixtureState, type StackFixtureState } from "./GitArcControllerTestFixtures";
import GitArcRegistry from "./GitArcRegistry";
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

test("restack rejects layers another thread builds on", async () => {
  const state = stacks!.state.transfer;
  const cwd = path.join(stacks!.bundleRoot, state.root);
  // The child inherited layer one; dropping it would pull the child's baseline away.
  await assert.rejects(controller.restackArc({ cwd, threadId: "parent", drop: [state.lower] }),
    (error) => error instanceof GitArcRejectionError && error.rejection.reason === "stackLayerInUse");
});
