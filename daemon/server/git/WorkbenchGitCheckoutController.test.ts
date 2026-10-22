/* Exports: none; real Git tests protect that ref moves report disturbed threads instead of stranding their claims, that a
 * conflicted stash restore keeps the stash with plain markers and no merge in progress, and that restores never touch
 * claimed files. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { GitArcRegistryEntry } from "../lib/workbench/git/GitArcRegistry";
import WorkbenchGitCheckoutController from "./WorkbenchGitCheckoutController";

const execute = promisify(execFile);
const projectId = ProjectIdSchema.parse("project");

async function fixture(t: test.TestContext, claims: Array<Pick<GitArcRegistryEntry, "threadId" | "claimedPaths">> = []) {
  const temporary = await WorkbenchTemporaryDirectory.create("git-checkout-");
  t.after(() => temporary.dispose());
  const root = temporary.path;
  const git = async (...args: string[]) => (await execute("git", args, {
    cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
  await git("init", "-b", "main");
  for (const [key, value] of [["user.name", "Workbench test"], ["user.email", "test@workbench.invalid"],
    ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git("config", key, value);
  const write = (file: string, content: string) => fs.writeFile(path.join(root, file), content);
  const commit = async (file: string, content: string) => {
    await write(file, content);
    await git("add", file);
    await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  const controller = new WorkbenchGitCheckoutController({
    resolveRoot: async () => root,
    resolveIdentity: async () => null,
    readOwner: async threadId => ({ id: threadId, projectId, entry: { title: threadId } as never }),
    transitions: { read: async (_key, operation) => await operation(), run: async (_key, operation) => await operation() },
    discoverProject: async () => null,
    listClaims: async () => claims.map(claim => ({
      harness: "codex", checkpointCommit: "x", intentDescription: "", intentName: "", updatedAt: "", phase: "active", ...claim,
    })),
  });
  return { root, git, write, commit, controller };
}

test("a branch switch reports threads with live claims and moves only once disturbing them is admitted", async t => {
  const f = await fixture(t, [{ threadId: "agent", claimedPaths: ["a.txt"] }]);
  await f.commit("a.txt", "one\n");
  await f.git("branch", "side");
  const reported = await f.controller.mutate({ projectId, action: "switchBranch", branch: "side", disturb: false });
  assert.equal(reported.status, "disturbs");
  assert.deepEqual(reported.status === "disturbs" ? reported.owners.map(owner => owner.id) : [], ["agent"]);
  assert.equal(await f.git("branch", "--show-current"), "main");
  assert.equal((await f.controller.mutate({ projectId, action: "switchBranch", branch: "side", disturb: true })).status, "complete");
  assert.equal(await f.git("branch", "--show-current"), "side");
});

test("a conflicted stash restore keeps the stash and leaves only worktree markers", async t => {
  const f = await fixture(t);
  await f.commit("a.txt", "one\n");
  await f.write("a.txt", "stashed\n");
  await f.git("stash", "push", "-m", "idea");
  const sha = await f.git("rev-parse", "stash@{0}");
  await f.commit("a.txt", "moved on\n");
  const result = await f.controller.mutate({ projectId, action: "restoreStash", sha });
  assert.deepEqual(result.status === "complete" ? result.conflicts : null, ["a.txt"]);
  assert.match(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), /<<<<<<<[\s\S]*stashed/u);
  assert.equal(await f.git("ls-files", "--unmerged"), "", "no merge is left in progress");
  assert.equal(await f.git("rev-parse", "stash@{0}"), sha, "the stash survives a conflicted restore");
});

test("a clean stash restore applies its untracked files and drops the stash", async t => {
  const f = await fixture(t);
  await f.commit("a.txt", "one\n");
  await f.write("new.txt", "fresh\n");
  await f.git("stash", "push", "--include-untracked", "-m", "idea");
  const sha = await f.git("rev-parse", "stash@{0}");
  assert.equal((await f.controller.mutate({ projectId, action: "restoreStash", sha })).status, "complete");
  assert.equal(await fs.readFile(path.join(f.root, "new.txt"), "utf8"), "fresh\n");
  assert.equal(await f.git("stash", "list"), "");
});

test("a stash restore refuses to write files a thread claims", async t => {
  const f = await fixture(t, [{ threadId: "agent", claimedPaths: ["a.txt"] }]);
  await f.commit("a.txt", "one\n");
  await f.write("a.txt", "stashed\n");
  await f.git("stash", "push", "-m", "idea");
  const sha = await f.git("rev-parse", "stash@{0}");
  await assert.rejects(f.controller.mutate({ projectId, action: "restoreStash", sha }), /claims/u);
  assert.equal(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), "one\n");
});

test("undoing HEAD keeps its changes in the worktree and refuses older commits", async t => {
  const f = await fixture(t);
  const first = await f.commit("a.txt", "one\n");
  const second = await f.commit("a.txt", "two\n");
  await assert.rejects(f.controller.mutate({ projectId, action: "undoCommit", sha: first, disturb: false }), /latest/u);
  assert.equal((await f.controller.mutate({ projectId, action: "undoCommit", sha: second, disturb: false })).status, "complete");
  assert.equal(await f.git("rev-parse", "HEAD"), first);
  assert.equal(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), "two\n");
});
