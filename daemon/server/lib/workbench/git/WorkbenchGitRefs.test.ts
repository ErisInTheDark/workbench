/* Exports: none; real Git tests protect upstream counts, marked history, non-forced pushes, branch listings with their
 * occupying worktrees, stash listings, and commit/stash file sides including stashed untracked files. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchGitRefs from "./WorkbenchGitRefs";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const execute = promisify(execFile);

async function repository(root: string, init = true) {
  await fs.mkdir(root, { recursive: true });
  const git = async (...args: string[]) => (await execute("git", args, {
    cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
  if (init) await git("init", "-b", "main");
  for (const [key, value] of [["user.name", "Workbench test"], ["user.email", "test@workbench.invalid"],
    ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git("config", key, value);
  const commit = async (file: string, content = `${file}\n`) => {
    await fs.writeFile(path.join(root, file), content);
    await git("add", file);
    await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  return { root, git, commit, refs: new WorkbenchGitRefs(new WorkbenchGitRepository(root)) };
}

/** A checkout cloned from a bare origin, so the branch has a real upstream. */
async function withOrigin(t: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("git-refs-");
  t.after(() => temporary.dispose());
  const seed = await repository(path.join(temporary.path, "seed"));
  await seed.commit("base.txt");
  const origin = path.join(temporary.path, "origin.git");
  await execute("git", ["clone", "--quiet", "--bare", seed.root, origin], { windowsHide: true });
  const clone = path.join(temporary.path, "clone");
  await execute("git", ["clone", "--quiet", origin, clone], { windowsHide: true });
  const local = await repository(clone, false);
  return { temporary, origin, local, other: seed };
}

test("upstream counts, history marks and pushes follow the branch's real upstream", async t => {
  const { local } = await withOrigin(t);
  const pushed = await local.git("rev-parse", "HEAD");
  const first = await local.commit("one.txt");
  const second = await local.commit("two.txt");
  assert.deepEqual((await local.refs.position([])).upstream, { name: "origin/main", ahead: 2, behind: 0 });

  const history = await local.refs.history({ limit: 2, peers: [] });
  assert.deepEqual(history.commits.map(({ commit, unpushed }) => ({ commit, unpushed })),
    [{ commit: second, unpushed: true }, { commit: first, unpushed: true }]);
  assert.equal(history.complete, false, "the base commit lies beyond the page");
  const all = await local.refs.history({ limit: 10, peers: [] });
  assert.equal(all.complete, true);
  assert.deepEqual(all.commits.at(-1), { ...all.commits.at(-1)!, commit: pushed, unpushed: false, subject: "base.txt" });

  assert.deepEqual(await local.refs.push(), { branch: "main", upstream: "origin/main", pushed: 2 });
  assert.deepEqual((await local.refs.position([])).upstream, { name: "origin/main", ahead: 0, behind: 0 });
  assert.ok((await local.refs.history({ limit: 10, peers: [] })).commits.every(commit => !commit.unpushed));
});

test("a push never overwrites upstream commits this branch lacks", async t => {
  const { origin, local, other } = await withOrigin(t);
  await other.git("remote", "add", "origin", origin);
  await other.commit("theirs.txt");
  await other.git("push", "--quiet", "origin", "main");
  const theirs = await other.git("rev-parse", "HEAD");
  await local.commit("mine.txt");
  await local.git("fetch", "--quiet");
  await assert.rejects(local.refs.push(), /pull them first/u);
  assert.equal((await execute("git", ["rev-parse", "main"], { cwd: origin, windowsHide: true })).stdout.trim(), theirs);
});

test("branches carry upstream counts and name the other worktree holding them", async t => {
  const { temporary, local } = await withOrigin(t);
  await local.commit("one.txt");
  await local.git("branch", "side");
  const linked = path.join(temporary.path, "linked");
  await local.git("worktree", "add", "--quiet", linked, "side");
  const listed = await local.refs.branches();
  assert.equal(listed.current, "main");
  const main = listed.branches.find(branch => branch.name === "main");
  assert.deepEqual(main?.upstream, { name: "origin/main", ahead: 1, behind: 0 });
  assert.equal(main?.worktree, null, "the current checkout does not count as elsewhere");
  const side = listed.branches.find(branch => branch.name === "side");
  assert.ok(side?.worktree && path.resolve(side.worktree) === path.resolve(linked));
});

test("commit files compare against their parent and the root commit against the empty tree", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("git-refs-");
  t.after(() => temporary.dispose());
  const local = await repository(path.join(temporary.path, "local"));
  const root = await local.commit("a.txt", "one\n");
  const second = await local.commit("a.txt", "one\ntwo\n");
  const detail = await local.refs.objectDetail({ kind: "commit", sha: second });
  assert.equal(detail.subject, "a.txt");
  assert.deepEqual(detail.parents, [root]);
  assert.deepEqual(detail.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    [{ path: "a.txt", status: "M", additions: 1, deletions: 0 }]);
  assert.equal(detail.undoBlocked, null, "an unpublished HEAD can be undone");
  assert.match((await local.refs.objectDetail({ kind: "commit", sha: root })).undoBlocked ?? "", /latest/u);
  const [rootFile] = await local.refs.objectFiles({ kind: "commit", sha: root });
  assert.equal(rootFile?.sides.head, null);
  assert.equal(rootFile?.file.status, "A");
});

test("stashes list newest first and show tracked changes plus untracked files", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("git-refs-");
  t.after(() => temporary.dispose());
  const local = await repository(path.join(temporary.path, "local"));
  await local.commit("a.txt", "one\n");
  await fs.writeFile(path.join(local.root, "a.txt"), "one\nchanged\n");
  await fs.writeFile(path.join(local.root, "new.txt"), "fresh\n");
  await local.git("stash", "push", "--include-untracked", "-m", "first idea");
  await fs.writeFile(path.join(local.root, "a.txt"), "other\n");
  await local.git("stash", "push", "-m", "second idea");
  const { stashes } = await local.refs.stashes();
  assert.deepEqual(stashes.map(({ index, message }) => ({ index, message })),
    [{ index: 0, message: "second idea" }, { index: 1, message: "first idea" }]);
  const detail = await local.refs.objectDetail({ kind: "stash", sha: stashes[1]!.sha });
  assert.equal(detail.subject, "first idea");
  assert.deepEqual(detail.files.map(file => `${file.status} ${file.path}`).sort(), ["A new.txt", "M a.txt"]);
  assert.equal(await local.refs.stashName(stashes[1]!.sha), "stash@{1}");
  await local.git("stash", "drop", "stash@{1}");
  await assert.rejects(local.refs.objectDetail({ kind: "stash", sha: stashes[1]!.sha }), /gone/u);
});

test("a branch lists only its own stashes and Git's generated names read as unnamed", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("git-refs-");
  t.after(() => temporary.dispose());
  const local = await repository(path.join(temporary.path, "local"));
  await local.commit("a.txt", "one\n");
  await fs.writeFile(path.join(local.root, "a.txt"), "main work\n");
  await local.git("stash", "push");
  await local.git("switch", "--quiet", "-c", "side");
  await fs.writeFile(path.join(local.root, "a.txt"), "side work\n");
  await local.git("stash", "push", "-m", "side idea");
  assert.deepEqual((await local.refs.stashes()).stashes.map(stash => stash.message), ["side idea"]);
  await local.git("switch", "--quiet", "main");
  assert.deepEqual((await local.refs.stashes()).stashes.map(stash => stash.message), [""], "main sees only its unnamed stash");
});
