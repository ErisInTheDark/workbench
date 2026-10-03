/*
 * Exports: none. Tests protect frozen stash merge bases during history remapping.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import GitArcHistoryRewriter, { remapGitArcClaimLossHead } from "./GitArcHistoryRewriter";
import GitArcRegistry, { REGISTRY_REF } from "./GitArcRegistry";
import GitTestFixtureCache from "./GitTestFixtureCache";
import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

test("history remapping preserves frozen stash bases and advances ordinary loss boundaries", () => {
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const commits = new Map([[oldHead, newHead]]);
  assert.equal(remapGitArcClaimLossHead({ frozen: true, head: oldHead }, commits), oldHead);
  assert.equal(remapGitArcClaimLossHead({ frozen: false, head: oldHead }, commits), newHead);
  assert.equal(remapGitArcClaimLossHead({ frozen: true, head: null }, commits), null);
});

test("history replacement remaps the caller checkpoint but keeps adopted frozen work intact", async context => {
  const fixture = await new GitTestFixtureCache().copyFresh(CONTROLLER_BASE_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const controller = new WorkbenchGitCheckpointController();
  await controller.createAndStartPlan({ cwd: fixture.root, threadId: "parent", intentName: "parent", paths: ["one.txt"] });
  await controller.createAndStartPlan({ cwd: fixture.root, threadId: "child", intentName: "child", paths: ["two.txt"] });
  await fs.writeFile(path.join(fixture.root, "two.txt"), "saved work\n");
  await controller.stashArc({ cwd: fixture.root, threadId: "child" });
  await controller.adoptArc({ cwd: fixture.root, threadId: "parent", source: { harness: "codex", threadId: "child" } });
  const owner = await new GitArcRegistry(repository).find({ harness: "codex", threadId: "parent" });
  assert.ok(owner?.savedStash);
  const stashRef = "refs/worktree/agents/codex/parent/arc-stash";
  const frozen = await repository.readRef(stashRef);
  assert.ok(frozen);
  const previous = await repository.currentHead();
  assert.ok(previous);
  await fs.writeFile(path.join(fixture.root, "unrelated.txt"), "new base\n");
  const next = await repository.createCommitFromTree(
    await repository.writeScopedWorktreeTree(["unrelated.txt"], previous), previous, "replacement base",
  );
  const rewrite = await new GitArcHistoryRewriter(repository).prepare(new Map([[previous, next]]));
  assert.equal(rewrite.updates.some(update => update.ref === stashRef), false);
  assert.equal(await repository.readRef(stashRef), frozen);
  const registryUpdate = rewrite.updates.find(update => update.ref === REGISTRY_REF);
  assert.ok(registryUpdate);
  const state = JSON.parse(await repository.readBlob(registryUpdate.newValue)) as {
    entries: Array<{ threadId: string; savedStash?: { checkpointCommit: string } }>;
  };
  const preserved = state.entries.find(entry => entry.threadId === "parent")?.savedStash;
  assert.equal(preserved?.checkpointCommit,
    rewrite.commits.get(owner.savedStash.checkpointCommit) ?? owner.savedStash.checkpointCommit);
});
