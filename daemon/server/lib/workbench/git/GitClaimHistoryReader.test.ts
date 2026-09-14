/*
 * No production exports. Tests protect actual-claim checkpoint discovery and scope expansion. Keywords: Git, claims, import, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_METADATA_MARKER,
  checkpointMessage,
} from "workbench-shared/workbench/git/git-arc-storage";
import GitTestFixtureCache from "./GitTestFixtureCache.ts";
import GitClaimHistoryReader from "./GitClaimHistoryReader.ts";
import WorkbenchGitRepository from "./WorkbenchGitRepository.ts";
import { THREAD_GIT_BASE_FIXTURE } from "./WorkbenchGitTestFixtures.ts";

const fixtureCache = new GitTestFixtureCache();

test("claim history imports active scopes, excludes plans, and expands directories", async (context) => {
    const fixture = await fixtureCache.copy(THREAD_GIT_BASE_FIXTURE);
    context.after(fixture.dispose);
    const repository = await WorkbenchGitRepository.open(fixture.root);
    const head = await repository.currentHead();
    const tree = await repository.resolveTree(head);
    const active = await repository.createCommitFromTree(tree, head, checkpointMessage({
      amendedFrom: null, kind: "arc", scopePaths: ["nested", "deleted.ts"], version: 3,
    }));
    const plan = await repository.createCommitFromTree(tree, head, checkpointMessage({
      amendedFrom: null, kind: "plan", scopePaths: ["nested"], version: 3,
    }));
    const malformed = await repository.createCommitFromTree(tree, head, `${CHECKPOINT_METADATA_MARKER}\n{broken\n`);
    await repository.updateRef("refs/worktree/agents/codex/thread/checkpoints/active", active);
    await repository.updateRef("refs/worktree/agents/codex/thread/checkpoints/plan", plan);
    await repository.updateRef("refs/worktree/agents/codex/thread/checkpoints/malformed", malformed);
    const reader = new GitClaimHistoryReader();
    const discovered = await reader.discover({
      projectId: "project",
      rootId: "root",
      workspaceRoot: fixture.root,
    });
    assert.equal(discovered.candidates.length, 1);
    assert.equal(discovered.unsupported, 1);
    const paths = await reader.hydrate(discovered.candidates[0]!);
    assert.deepEqual(paths, ["deleted.ts", "nested/one.txt", "nested/two.txt"]);
});
