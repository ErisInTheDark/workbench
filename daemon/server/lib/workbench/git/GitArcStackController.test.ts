/*
 * Exports: none. Protect stack layer sealing, stacked proposal ordering, reopening and history rewrites.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import GitCheckpointStore from "./GitCheckpointStore";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";

const fixtures = new GitTestFixtureCache();

async function setup(context: { after(callback: () => Promise<void> | void): void }, paths = ["one.txt"]) {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await controller.createAndStartPlan({ cwd, threadId: "owner", intentName: "stacked work", paths });
  const write = async (file: string, content: string) => await fs.writeFile(path.join(cwd, file), content);
  const propose = async (title: string, files = ["one.txt"]) => (
    await controller.createProposal({ cwd, threadId: "owner", paths: files, title, description: "" })
  ).proposalId;
  const commit = async (proposalId: string, title: string) => await controller.commitProposal({
    cwd, threadId: "owner", proposalId, title, description: "", includeNewer: false,
  });
  const headFile = async (file: string) => await (await WorkbenchGitRepository.open(cwd)).run(["show", `HEAD:${file}`]);
  return { commit, controller, cwd, headFile, propose, write };
}

test("stacked proposals measure from sealed layers and commit bottom-up by replaying onto HEAD", async context => {
  const { commit, controller, cwd, headFile, propose, write } = await setup(context);
  await write("one.txt", "first\n");
  const lower = await propose("first");
  await controller.stackArc({ cwd, threadId: "owner", title: "layer one" });
  assert.deepEqual((await controller.compare({ cwd, threadId: "owner" })).changes, [], "sealed work is the new baseline");

  await write("one.txt", "second\n");
  const upper = await propose("second");
  const waiting = await controller.getProposal({ cwd, threadId: "owner", proposalId: upper, includeNewer: false });
  assert.equal(waiting.waitingForLayer, "layer one");
  assert.match(waiting.changes[0]!.diff, /-first\n\+second/u, "the stacked proposal diffs only its own layer");
  await assert.rejects(commit(upper, "second"), /layer one/u);
  await assert.rejects(controller.rescindProposal({ cwd, threadId: "owner", proposalId: lower }), /sealed/iu);

  const lowerState = await controller.getProposal({ cwd, threadId: "owner", proposalId: lower, includeNewer: false });
  assert.equal(lowerState.sealedInLayer, "layer one");
  assert.equal(lowerState.includeNewerAvailable, false, "newer work belongs to the upper layer");

  await commit(lower, "first");
  assert.equal(await headFile("one.txt"), "first\n");
  assert.equal((await controller.getProposal({ cwd, threadId: "owner", proposalId: upper, includeNewer: false })).waitingForLayer, null);
  await commit(upper, "second");
  assert.equal(await headFile("one.txt"), "second\n");
  assert.deepEqual((await controller.findLifecycleState({ cwd, threadId: "owner" }))?.stackLayers ?? [], [],
    "a fully landed stack stops shaping the baseline");
});

test("a lower layer that did not land as sealed makes stacked proposals unavailable", async context => {
  const { controller, cwd, propose, write } = await setup(context);
  await write("one.txt", "sealed\n");
  await propose("sealed");
  await controller.stackArc({ cwd, threadId: "owner", title: "layer one" });
  await write("one.txt", "stacked\n");
  const upper = await propose("stacked");

  const repository = await WorkbenchGitRepository.open(cwd);
  const head = await repository.currentHead();
  await write("one.txt", "someone else\n");
  const outside = await repository.createCommitFromTree(await repository.writeScopedWorktreeTree(["one.txt"], head), head, "outside\n");
  await repository.updateRefs([{ newValue: outside, oldValue: head, ref: (await repository.symbolicHead())! }]);

  const state = await controller.getProposal({ cwd, threadId: "owner", proposalId: upper, includeNewer: false });
  assert.equal(state.status, "unavailable");
  assert.equal(state.waitingForLayer, null);
});

test("unstack reopens only an unused top layer, after which its proposals can be rescinded", async context => {
  const { controller, cwd, propose, write } = await setup(context);
  await write("one.txt", "sealed\n");
  const lower = await propose("sealed");
  await controller.stackArc({ cwd, threadId: "owner", title: "layer one" });
  await write("one.txt", "stacked\n");
  const upper = await propose("stacked");

  await assert.rejects(controller.unstackArc({ cwd, threadId: "owner" }), /builds on/iu);
  await controller.rescindProposal({ cwd, threadId: "owner", proposalId: upper });
  const reopened = await controller.unstackArc({ cwd, threadId: "owner" });
  assert.deepEqual(reopened.proposalIds, [lower]);
  assert.equal(reopened.stackTip, null);
  await controller.rescindProposal({ cwd, threadId: "owner", proposalId: lower });
  await assert.rejects(controller.unstackArc({ cwd, threadId: "owner" }), /stack layer/iu);
});

test("accepting a sealed amend rewrites the stack onto the amended history", async context => {
  const { commit, controller, cwd, headFile, propose, write } = await setup(context);
  await write("one.txt", "first\n");
  const original = await propose("first");
  await write("one.txt", "amended\n");
  await commit(original, "first");
  const amendment = (await controller.createProposal({
    cwd, threadId: "owner", amend: true, amendProposalId: original, paths: ["one.txt"],
    title: "first amended", description: "", freshTitle: "first follow-up",
  })).proposalId;
  await controller.stackArc({ cwd, threadId: "owner", title: "amend layer" });
  await write("one.txt", "stacked\n");
  const upper = await propose("stacked");

  await controller.commitProposal({
    cwd, threadId: "owner", proposalId: amendment, title: "first amended", description: "", includeNewer: false, mode: "amend",
  });
  const repository = await WorkbenchGitRepository.open(cwd);
  const head = await repository.currentHead();
  const { stackBase } = (await new GitCheckpointStore(repository).readProposal("codex", "owner", upper)).metadata;
  assert.ok(stackBase);
  assert.equal((await repository.readCommitAt(stackBase))?.identity.parents[0], head, "the stacked base follows the rewritten HEAD");

  await commit(upper, "stacked");
  assert.equal(await headFile("one.txt"), "stacked\n");
  assert.equal(await repository.run(["log", "-1", "--format=%s", "HEAD~1"]), "first amended\n");
});
