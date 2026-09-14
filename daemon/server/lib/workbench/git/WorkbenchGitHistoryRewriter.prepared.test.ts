/* No production exports. One history battery protects read-only classification of prepared commits before publication. */
import assert from "node:assert/strict";
import test from "node:test";

import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import { HISTORY_LINEAR_FIXTURE } from "./WorkbenchGitTestFixtures";

test("prepared history classification uses future ancestry without publishing or fetching", async (context) => {
  const fixture = await new GitTestFixtureCache().copy(HISTORY_LINEAR_FIXTURE);
  context.after(fixture.dispose);
  const repository = await WorkbenchGitRepository.open(fixture.root);
  const rewriter = new WorkbenchGitHistoryRewriter(repository);
  const tip = await repository.currentHead();
  const target = (await repository.readCommit(tip)).parents[0]!;
  const base = (await repository.readCommit(target)).parents[0]!;
  const ref = await repository.symbolicHead();
  assert.ok(ref);
  const index = await repository.writeIndexTree();
  await repository.updateRef(ref, base, tip);

  const prepared = { preparedHead: { commit: tip, ref }, refresh: false };
  assert.equal((await rewriter.classifyAmendability(tip, { refresh: false })).status, "unavailable");
  assert.equal((await rewriter.classifyAmendability(tip, prepared)).status, "available");
  assert.equal((await rewriter.classifyAmendability(target, prepared)).status, "available");
  const detached = { ...prepared, preparedHead: { commit: tip, ref: null } };
  assert.equal((await rewriter.classifyAmendability(tip, detached)).status, "unavailable");

  await repository.run(["config", "remote.fixture.url", "https://example.invalid/fixture.git"]);
  await repository.updateRef("refs/remotes/fixture/main", tip);
  let fetches = 0;
  context.mock.method(repository, "fetchRemotes", async () => {
    fetches++;
    throw new Error("Prepared presentation must not fetch remotes.");
  });
  const published = await rewriter.classifyAmendability(tip, { ...prepared, refresh: true });
  assert.equal(published.status, "unavailable");
  assert.ok(published.status === "unavailable" && published.reason.includes("refs/remotes/fixture/main"));
  assert.equal(fetches, 0);
  assert.equal(await repository.currentHead(), base);
  assert.equal(await repository.writeIndexTree(), index);
});
