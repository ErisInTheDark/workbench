/* No production exports. Protect on-demand commit reads: one detail read per commit and one ref read per revision, shared while in flight, kept once loaded, retried after failure. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadGitCommit } from "workbench-shared/workbench/thread/thread-state";
import ThreadGitCommitHistory from "./ThreadGitCommitHistory";

const commit = (sha: string): WorkbenchThreadGitCommit => ({
  commitSha: sha.repeat(40), description: `${sha} body`, historyIndex: 0, rootId: "root", sourceProposalId: sha, title: sha,
});
/** Views hand the store whole refs; the read must name commits by key alone. */
const key = (sha: string) => ({ commitSha: sha.repeat(40), committedAt: "2026-10-01T00:00:00.000Z", historyIndex: 0, rootId: "root" });
const noRefs = async () => [];

test("each commit is read once, a repeat ask while loading reads nothing new, and loaded commits stay", async () => {
  const reads: string[][] = [];
  const pending = Promise.withResolvers<void>();
  const history = new ThreadGitCommitHistory({ refs: noRefs, details: async (_threadId, commits) => {
    reads.push(commits.map(item => item.commitSha[0]!));
    assert.ok(commits.every(item => Object.keys(item).sort().join() === "commitSha,rootId"), "reads name commits by key alone");
    await pending.promise;
    return commits.map(item => commit(item.commitSha[0]!));
  } });
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
  const history = new ThreadGitCommitHistory({ refs: noRefs, details: async (_threadId, commits) => {
    if (fail) throw new Error("daemon unavailable");
    return commits.map(item => commit(item.commitSha[0]!));
  } }, message => reports.push(message));
  await history.load("thread", [key("a"), key("b")]);
  assert.deepEqual(history.get("thread", key("a")), { status: "failed", error: "daemon unavailable" });
  assert.deepEqual(reports, ["daemon unavailable"], "one failed read is one report, not one per commit");
  fail = false;
  await history.load("thread", [key("a")]);
  assert.equal(history.get("thread", key("a")).status, "ready");
});

test("a thread's refs are read once per revision, kept while a newer revision loads, and a stale answer never wins", async () => {
  const answers: Array<PromiseWithResolvers<ReturnType<typeof key>[]>> = [];
  const history = new ThreadGitCommitHistory({
    details: async () => [],
    refs: async () => { const answer = Promise.withResolvers<ReturnType<typeof key>[]>(); answers.push(answer); return await answer.promise; },
  });
  const first = history.loadRefs("thread", "1");
  void history.loadRefs("thread", "1");
  assert.equal(answers.length, 1, "views sharing a revision share its read");
  assert.deepEqual(history.getRefs("thread"), { status: "loading" });
  answers[0]!.resolve([key("a")]);
  await first;
  assert.deepEqual(history.getRefs("thread"), { status: "ready", refs: [key("a")] });

  const stale = history.loadRefs("thread", "2");
  const fresh = history.loadRefs("thread", "3");
  assert.deepEqual(history.getRefs("thread"), { status: "ready", refs: [key("a")] }, "the old list shows while newer ones load");
  answers[2]!.resolve([key("a"), key("b"), key("c")]);
  await fresh;
  answers[1]!.resolve([key("a"), key("b")]);
  await stale;
  assert.deepEqual(history.getRefs("thread"), { status: "ready", refs: [key("a"), key("b"), key("c")] });
});

test("a failed ref read reports, and asking for the same revision again reads again", async () => {
  let fail = true;
  const reports: string[] = [];
  const history = new ThreadGitCommitHistory({
    details: async () => [],
    refs: async () => { if (fail) throw new Error("daemon unavailable"); return [key("a")]; },
  }, message => reports.push(message));
  await history.loadRefs("thread", "1");
  assert.deepEqual(history.getRefs("thread"), { status: "failed", error: "daemon unavailable" });
  assert.deepEqual(reports, ["daemon unavailable"]);
  fail = false;
  await history.loadRefs("thread", "1");
  assert.deepEqual(history.getRefs("thread"), { status: "ready", refs: [key("a")] });
});
