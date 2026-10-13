/* Exports: none; real Git tests protect scratch conflict resolution, stale-HEAD rejection, claim-aware carrying and merge mode. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchGitIntegrationSession, { type WorkbenchGitIntegrationClaim } from "./WorkbenchGitIntegrationSession";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const execute = promisify(execFile);
const source = { kind: "upstream" as const, ref: "origin/main" };

/** `incoming` and local `main` both descend from `base`, which holds `shared.txt` and `notes.txt`. */
async function fixture(t: test.TestContext, edits: { incoming: Record<string, string>; local: Record<string, string> }) {
  const temporary = await WorkbenchTemporaryDirectory.create("git-integrate-");
  t.after(() => temporary.dispose());
  const root = temporary.path;
  const git = async (...args: string[]) => (await execute("git", args, {
    cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
  await git("init", "-b", "main");
  for (const [key, value] of [["user.name", "Workbench test"], ["user.email", "test@workbench.invalid"],
    ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git("config", key, value);
  const write = (file: string, content: string) => fs.writeFile(path.join(root, file), content);
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) await write(file, content);
    await git("add", ".");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const base = await commit({ "shared.txt": "base\n", "notes.txt": "one\ntwo\nthree\n" }, "base");
  const incoming = await commit(edits.incoming, "incoming");
  await git("reset", "--hard", base);
  const local = Object.keys(edits.local).length ? await commit(edits.local, "local") : base;
  const claims: WorkbenchGitIntegrationClaim[] = [];
  const session = new WorkbenchGitIntegrationSession({
    repository: new WorkbenchGitRepository(root), threadId: "thread-a", listClaims: async () => claims,
  });
  return { root, git, write, incoming, local, claims, session };
}

test("replay conflicts resolve through scratch files, and markers left behind are refused", async t => {
  const f = await fixture(t, { incoming: { "shared.txt": "theirs\n" }, local: { "shared.txt": "mine\n" } });
  const started = await f.session.start({ incoming: f.incoming, source, mode: "replay", carryOwn: false });
  const scratch = path.join(f.root, ".workbench", "integrate", "thread-a", "shared.txt");
  assert.match(started, /\.workbench\/integrate\/thread-a\/shared\.txt/u);
  assert.match(await fs.readFile(scratch, "utf8"), /^<{7}/mu);
  assert.equal(await f.git("status", "--porcelain"), "");
  await assert.rejects(f.session.resolve(), /Conflict markers remain/u);

  await fs.writeFile(scratch, "both\n");
  assert.match(await f.session.resolve(), /Run `wb git integrate apply`/u);
  await f.session.apply();
  assert.equal(await f.git("rev-parse", "HEAD~1"), f.incoming);
  assert.equal(await fs.readFile(path.join(f.root, "shared.txt"), "utf8"), "both\n");
  assert.equal(await f.git("status", "--porcelain"), "");
  await assert.rejects(f.session.view(), /no integration in progress/u);
});

test("apply refuses once HEAD moved after start", async t => {
  const f = await fixture(t, { incoming: { "shared.txt": "theirs\n" }, local: {} });
  await f.session.start({ incoming: f.incoming, source, mode: "replay", carryOwn: false });
  await f.write("other.txt", "late\n");
  await f.git("add", "other.txt");
  await f.git("commit", "-m", "late");
  await assert.rejects(f.session.apply(), /HEAD moved/u);
});

test("only the caller's own dirty claimed files carry; other owners and unclaimed dirt block", async t => {
  const f = await fixture(t, { incoming: { "notes.txt": "one\ntwo\nthree\nfour\n", "shared.txt": "theirs\n" }, local: {} });
  await f.write("notes.txt", "zero\none\ntwo\nthree\n");
  await f.write("shared.txt", "dirty\n");
  f.claims.push({ threadId: "thread-a", paths: ["notes.txt"] }, { threadId: "thread-b", paths: ["shared.txt"] });
  await f.session.start({ incoming: f.incoming, source, mode: "replay", carryOwn: true });
  assert.match(await f.session.view(), /shared\.txt \(thread-b\)/u);
  await assert.rejects(f.session.apply(), /Dirty files block apply/u);
  assert.deepEqual(await f.session.waitAttempt(), { kind: "blocked" });

  f.claims.splice(1);
  assert.match(await f.session.view(), /Unclaimed dirty files block apply/u);
  await f.git("checkout", "--", "shared.txt");
  await f.session.apply();
  assert.equal(await f.git("rev-parse", "HEAD"), f.incoming);
  assert.equal(await fs.readFile(path.join(f.root, "notes.txt"), "utf8"), "zero\none\ntwo\nthree\nfour\n");
  assert.equal(await f.git("status", "--porcelain"), "M notes.txt");
});

test("local commits a peer already holds refuse replay and integrate by one merge commit instead", async t => {
  const f = await fixture(t, { incoming: { "shared.txt": "theirs\n" }, local: { "notes.txt": "local\n" } });
  await f.git("update-ref", "refs/remotes/wb-peer/main", f.local);
  await assert.rejects(f.session.start({ incoming: f.incoming, source, mode: "replay", carryOwn: false }), /--merge/u);
  await f.session.start({ incoming: f.incoming, source, mode: "merge", carryOwn: false });
  await f.session.apply();
  assert.deepEqual((await f.git("rev-list", "--parents", "-n", "1", "HEAD")).split(" ").slice(1), [f.local, f.incoming]);
  assert.equal(await f.git("status", "--porcelain"), "");
});
