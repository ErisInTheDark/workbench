/* Exports: none; real Git tests protect integration ancestry, dirty work, published history and publication rollback. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchGitIntegration from "./WorkbenchGitIntegration";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const execute = promisify(execFile);

/** Local `main` one commit ahead of `incoming`, which is one commit ahead of their base. */
async function fixture(t: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("git-integration-");
  t.after(() => temporary.dispose());
  const root = temporary.path;
  const git = async (...args: string[]) => (await execute("git", args, {
    cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
  await git("init", "-b", "main");
  for (const [key, value] of [["user.name", "Workbench test"], ["user.email", "test@workbench.invalid"],
    ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git("config", key, value);
  const commit = async (file: string, content: string) => {
    await fs.writeFile(path.join(root, file), content);
    await git("add", file);
    await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  const base = await commit("base.txt", "base\n");
  const incoming = await commit("incoming.txt", "incoming\n");
  await git("reset", "--hard", base);
  const local = await commit("local.txt", "local\n");
  const status = () => git("status", "--porcelain", "--untracked-files=all");
  return { root, git, local, incoming, status, integration: new WorkbenchGitIntegration(new WorkbenchGitRepository(root)) };
}

test("local commits already on a remote ref are blocked instead of rewritten", async t => {
  const f = await fixture(t);
  await f.git("remote", "add", "elsewhere", f.root);
  await f.git("update-ref", "refs/remotes/elsewhere/main", f.local);
  const plan = await f.integration.prepare(f.incoming);
  assert.equal(plan.kind, "blocked");
  assert.match(plan.kind === "blocked" ? plan.reason ?? "" : "", /refs\/remotes\/elsewhere\/main/u);
  assert.equal(await f.git("rev-parse", "HEAD"), f.local);
});

test("local commits a peer daemon already holds are blocked even with no configured remote", async t => {
  const f = await fixture(t);
  await f.git("update-ref", "refs/remotes/wb-peer/main", f.local);
  const plan = await f.integration.prepare(f.incoming);
  assert.equal(plan.kind, "blocked");
  assert.match(plan.kind === "blocked" ? plan.reason ?? "" : "", /refs\/remotes\/wb-peer\/main/u);
});

test("merge preserves both published histories and unrelated staged and unstaged work", async t => {
  const f = await fixture(t);
  await f.git("update-ref", "refs/remotes/published/main", f.local);
  await fs.writeFile(path.join(f.root, "base.txt"), "staged\n");
  await f.git("add", "base.txt");
  await fs.writeFile(path.join(f.root, "base.txt"), "unstaged\n");
  const before = await f.status();
  const plan = await f.integration.prepare(f.incoming, "merge");
  assert.equal(plan.kind, "merge");
  await f.integration.apply(plan);
  assert.deepEqual((await f.git("rev-parse", "HEAD^1", "HEAD^2")).split(/\r?\n/u), [f.local, f.incoming]);
  assert.equal(await f.git("show", "HEAD:incoming.txt"), "incoming");
  assert.equal(await f.git("show", "HEAD:local.txt"), "local");
  assert.equal(await f.git("rev-parse", "refs/remotes/published/main"), f.local);
  assert.equal(await f.status(), before);
  assert.equal(await f.git("show", ":base.txt"), "staged");
  assert.equal(await fs.readFile(path.join(f.root, "base.txt"), "utf8"), "unstaged\n");
  assert.equal((await f.integration.prepare(f.incoming, "merge")).kind, "current");
});

test("fast-forward-only refuses divergence without replaying either history", async t => {
  const f = await fixture(t);
  const plan = await f.integration.prepare(f.incoming, "fastForward");
  assert.equal(plan.kind, "blocked");
  assert.equal(await f.git("rev-parse", "HEAD"), f.local);
  assert.equal(await f.status(), "");
});

test("merge refuses incoming dirty overlap without changing local files", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "incoming.txt"), "my unsaved work\n");
  const plan = await f.integration.prepare(f.incoming, "merge");
  assert.equal(plan.kind, "blocked");
  assert.deepEqual(plan.kind === "blocked" && plan.conflicts, ["incoming.txt"]);
  assert.equal(await f.git("rev-parse", "HEAD"), f.local);
  assert.equal(await fs.readFile(path.join(f.root, "incoming.txt"), "utf8"), "my unsaved work\n");
});

test("failed ref publication restores the worktree and index to the original HEAD", async t => {
  const f = await fixture(t);
  const checkpointRef = "refs/worktree/agents/claude/thread/checkpoints/1";
  const checkpoint = await f.git("commit-tree", await f.git("rev-parse", "HEAD^{tree}"), "-p", f.local, "-m", "checkpoint");
  await f.git("update-ref", checkpointRef, checkpoint);
  const plan = await f.integration.prepare(f.incoming);
  assert.equal(plan.kind, "replay");
  // A concurrent writer moves a remapped ref, so the atomic publication's expected old value no longer matches.
  await f.git("update-ref", checkpointRef, f.local);
  await assert.rejects(f.integration.apply(plan));
  assert.equal(await f.git("rev-parse", "HEAD"), f.local);
  assert.equal(await f.status(), "");
  await assert.rejects(fs.access(path.join(f.root, "incoming.txt")));
});
