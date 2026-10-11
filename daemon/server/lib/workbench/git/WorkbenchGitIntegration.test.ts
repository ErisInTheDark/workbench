/* Exports: none; real Git tests protect integration refusal of published history and rollback after failed publication. */
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
