/* No production exports. Protect on-demand commit detail reads: one read per commit, shared while in flight, kept once loaded, retried after failure. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadGitCommit } from "workbench-shared/workbench/thread/thread-state";
import ThreadGitCommitHistory from "./ThreadGitCommitHistory";

const commit = (sha: string): WorkbenchThreadGitCommit => ({
  commitSha: sha.repeat(40), description: `${sha} body`, historyIndex: 0, rootId: "root", sourceProposalId: sha, title: sha,
});
/** Views hand the store whole refs; the read must name commits by key alone. */
const key = (sha: string) => ({ commitSha: sha.repeat(40), committedAt: "2026-10-01T00:00:00.000Z", historyIndex: 0, rootId: "root" });

test("each commit is read once, a repeat ask while loading reads nothing new, and loaded commits stay", async () => {
  const reads: string[][] = [];
  const pending = Promise.withResolvers<void>();
  const history = new ThreadGitCommitHistory(async (_threadId, commits) => {
    reads.push(commits.map(item => item.commitSha[0]!));
    assert.ok(commits.every(item => Object.keys(item).sort().join() === "commitSha,rootId"), "reads name commits by key alone");
    await pending.promise;
    return commits.map(item => commit(item.commitSha[0]!));
  });
  let heard = 0;
  history.subscribe(() => { heard += 1; });
  const first = history.load("thread", [key("a"), key("b")]);
  await history.load("thread", [key("a"), key("b")]);
  assert.deepEqual(history.get("thread", key("a")), { status: "loading" });
  pending.resolve();
  await first;
  assert.deepEqual(history.get("thread", key("b")), { status: "ready", commit: commit("b") });
  await history.load("thread", [key("a"), key("c")]);
  assert.deepEqual(reads, [["a", "b"], ["c"]], "only the commit not yet loaded is read again");
  assert.ok(heard >= 2, "subscribers hear the loads start and land");
  assert.deepEqual(history.get("other-thread", key("a")), { status: "loading" }, "threads keep separate histories");
});

test("a failed read marks its commits failed, reports once, and the next ask reads them again", async () => {
  let fail = true;
  const reports: string[] = [];
  const history = new ThreadGitCommitHistory(async (_threadId, commits) => {
    if (fail) throw new Error("daemon unavailable");
    return commits.map(item => commit(item.commitSha[0]!));
  }, message => reports.push(message));
  await history.load("thread", [key("a"), key("b")]);
  assert.deepEqual(history.get("thread", key("a")), { status: "failed", error: "daemon unavailable" });
  assert.deepEqual(reports, ["daemon unavailable"], "one failed read is one report, not one per commit");
  fail = false;
  await history.load("thread", [key("a")]);
  assert.equal(history.get("thread", key("a")).status, "ready");
});
