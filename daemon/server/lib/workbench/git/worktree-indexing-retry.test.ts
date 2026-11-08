/*
 * Exports: none. Protect staging retries on files rewritten mid-read, and their refusal to mask other Git failures.
 */
import assert from "node:assert/strict";
import test from "node:test";
import retryWorktreeIndexing, { WORKTREE_INDEXING_RETRY_DELAYS_MS } from "./worktree-indexing-retry";

const SHORT_READ = "error: short read while indexing src/World.ts\nerror: src/World.ts: failed to insert into database\nfatal: adding files failed";

function failing(messages: readonly string[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    work: async () => {
      const message = messages[calls];
      calls += 1;
      if (message !== undefined) throw new Error(message);
      return "tree";
    },
  };
}

const instant = async () => {};

test("a file rewritten mid-read is staged again once the writer is done", async () => {
  const staging = failing([SHORT_READ, "fatal: unable to index file 'src/Port.ts'"]);
  assert.equal(await retryWorktreeIndexing(staging.work, { wait: instant }), "tree");
  assert.equal(staging.calls, 3);
});

test("other Git failures surface on the first attempt", async () => {
  const staging = failing(["fatal: not a git repository"]);
  await assert.rejects(retryWorktreeIndexing(staging.work, { wait: instant }), /not a git repository/u);
  assert.equal(staging.calls, 1);
});

test("an aborted request stops retrying", async () => {
  const controller = new AbortController();
  controller.abort();
  const staging = failing([SHORT_READ]);
  await assert.rejects(retryWorktreeIndexing(staging.work, { signal: controller.signal, wait: instant }), /short read/u);
  assert.equal(staging.calls, 1);
});

test("a file that never settles fails naming it, without blaming Git storage", async () => {
  const staging = failing(Array.from({ length: WORKTREE_INDEXING_RETRY_DELAYS_MS.length + 1 }, () => SHORT_READ));
  await assert.rejects(retryWorktreeIndexing(staging.work, { wait: instant }), (error: Error) => {
    assert.match(error.message, /src\/World\.ts/u);
    assert.doesNotMatch(error.message, /database/u);
    return true;
  });
  assert.equal(staging.calls, WORKTREE_INDEXING_RETRY_DELAYS_MS.length + 1);
});
