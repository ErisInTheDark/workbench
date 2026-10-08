/*
 * Exports: none. Protect independent saved work across new live arcs and stash disposal.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import GitTestFixtureCache from "./GitTestFixtureCache";
import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const fixtures = new GitTestFixtureCache();

test("discarding an adopted stash preserves the caller's live claims and changes", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await controller.createAndStartPlan({ cwd, threadId: "child", intentName: "saved", paths: ["one.txt"] });
  await fs.writeFile(path.join(cwd, "one.txt"), "saved change\n");
  await controller.stashArc({ cwd, threadId: "child" });
  await controller.createAndStartPlan({ cwd, threadId: "owner", intentName: "live", paths: ["two.txt"] });
  await fs.writeFile(path.join(cwd, "two.txt"), "live change\n");
  await controller.adoptArc({ cwd, threadId: "owner", source: { harness: "codex", threadId: "child" } });
  assert.deepEqual((await controller.readStatus({ cwd, threadId: "owner" })).stashedClaims, ["one.txt"]);
  await assert.rejects(controller.stashArc({ cwd, threadId: "owner" }), /stash/i);
  await controller.discardStashedArc({ cwd, threadId: "owner" });
  const status = await controller.readStatus({ cwd, threadId: "owner" });
  assert.deepEqual(status.stashedClaims, []);
  assert.deepEqual(status.dirtyClaims, ["two.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "live change\n");
});

test("stashed pending proposals can be reworded without changing frozen work", async context => {
  const fixture = await fixtures.copy(CONTROLLER_BASE_FIXTURE);
  context.after(() => fixture.dispose());
  const cwd = fixture.root;
  const controller = new WorkbenchGitCheckpointController();
  await controller.createAndStartPlan({ cwd, threadId: "owner", intentName: "saved", paths: ["one.txt"] });
  await fs.writeFile(path.join(cwd, "one.txt"), "saved change\n");
  const proposal = await controller.createProposal({
    cwd, threadId: "owner", title: "saved title", description: "",
  });
  await controller.stashArc({ cwd, threadId: "owner" });
  const repository = await WorkbenchGitRepository.open(cwd);
  const stashRef = "refs/worktree/agents/codex/owner/arc-stash";
  const frozenBefore = await repository.readRef(stashRef);

  const reworded = await controller.createProposal({
    cwd, threadId: "owner", amendProposalId: proposal.proposalId,
    title: "clear saved title", description: "Keep the frozen content.",
  });
  assert.equal((await controller.getProposal({
    cwd, threadId: "owner", proposalId: proposal.proposalId, includeNewer: false,
  })).status, "superseded");
  assert.equal((await controller.getProposal({
    cwd, threadId: "owner", proposalId: reworded.proposalId, includeNewer: false,
  })).title, "clear saved title");
  // The observed lifecycle carries the revision's message and the frozen content's recorded totals.
  assert.deepEqual((await controller.findLifecycleState({ cwd, threadId: "owner" }))?.proposals, [{
    paths: ["one.txt"],
    proposalId: reworded.proposalId,
    status: "proposed",
    summary: {
      changes: [{ additions: 1, deletions: 1, kind: "update", path: "one.txt" }],
      committedSha: null,
      description: "Keep the frozen content.",
      mode: "commit",
      title: "clear saved title",
    },
  }]);
  assert.equal(await repository.readRef(stashRef), frozenBefore);
  await assert.rejects(controller.createProposal({
    cwd, threadId: "owner", amend: true, amendProposalId: reworded.proposalId,
    paths: ["one.txt"], title: "content cannot move", description: "",
  }), /active|stashed/iu);
});
