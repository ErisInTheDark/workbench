/* Exports: none; real Git tests protect installation pull admission, replay recovery and lifecycle ownership. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchInstallationUpdateController from "./WorkbenchInstallationUpdateController";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";
import { INSTALLATION_REPAIR_JOURNAL_SEGMENTS, type InstallationRepairJournal } from "workbench-shared/workbench/installation-update";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);

async function fixture(t: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("installation-update-");
  t.after(() => temporary.dispose());
  const origin = path.join(temporary.path, "origin.git");
  const remote = path.join(temporary.path, "remote");
  const local = path.join(temporary.path, "local");
  const git = async (cwd: string, ...args: string[]) => (await execute("git", args, {
    cwd, windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  })).stdout.trim();
  await git(temporary.path, "init", "--bare", origin);
  await git(temporary.path, "clone", origin, remote);
  const configure = async (cwd: string) => {
    await git(cwd, "config", "user.name", "Workbench test");
    await git(cwd, "config", "user.email", "test@workbench.invalid");
    await git(cwd, "config", "commit.gpgsign", "false");
    await git(cwd, "config", "core.autocrlf", "false");
  };
  await configure(remote);
  const commit = async (cwd: string, filename: string, content: string, title = filename) => {
    await fs.writeFile(path.join(cwd, filename), content);
    await git(cwd, "add", filename);
    await git(cwd, "commit", "-m", title);
    return git(cwd, "rev-parse", "HEAD");
  };
  await fs.writeFile(path.join(remote, "auxiliary.txt"), "unchanged\n");
  await git(remote, "add", "auxiliary.txt");
  await commit(remote, "content.txt", "original\n");
  await git(remote, "push", "-u", "origin", "HEAD");
  await git(temporary.path, "clone", origin, local);
  await configure(local);
  const transitions = createWorktreeGitTransitions(new WorkbenchThreadTransitionCoordinator());
  const warnings: string[] = [];
  const controller = new WorkbenchInstallationUpdateController({
    repoRoot: local, dataRoot: path.join(temporary.path, "data"),
    transitions, projectId: async () => null, warn: warning => warnings.push(warning),
    schedule: () => () => {}, watch: () => () => {},
  });
  t.after(() => controller.dispose());
  const incoming = async (filename: string, content: string) => {
    const sha = await commit(remote, filename, content);
    await git(remote, "push");
    return sha;
  };
  return { temporary, local, remote, git, commit, incoming, controller, transitions, warnings };
}

test("clean behind checkout pulls a fast-forward and detects incoming lockfile changes", async t => {
  const f = await fixture(t);
  const fromSha = await f.git(f.local, "rev-parse", "HEAD");
  const target = await f.incoming("pnpm-lock.yaml", "lockfileVersion: 9.0\n");
  await fs.writeFile(path.join(f.local, "auxiliary.txt"), "unrelated dirty\n");
  assert.equal((await f.controller.check()).state, "available");
  assert.equal(f.controller.read().lockfileChanged, true);
  const result = await f.controller.pull();
  assert.deepEqual(result, { fromSha, toSha: target, lockfileChanged: true });
  assert.equal(f.controller.read().state, "current");
  assert.equal(await fs.readFile(path.join(f.local, "auxiliary.txt"), "utf8"), "unrelated dirty\n");
});

test("divergent clean checkout rebases and preserves its local commit on upstream", async t => {
  const f = await fixture(t);
  await f.commit(f.local, "local.txt", "local\n", "local work");
  const upstream = await f.incoming("remote.txt", "remote\n");
  const prediction = await f.controller.check();
  assert.equal(prediction.state, "available");
  assert.equal(prediction.ahead, 1);
  assert.equal(prediction.behind, 1);
  const result = await f.controller.pull();
  assert.notEqual(result.fromSha, result.toSha);
  assert.equal(await f.git(f.local, "rev-parse", "HEAD^"), upstream);
  assert.equal(await f.git(f.local, "log", "-1", "--format=%s"), "local work");
  assert.equal(await fs.readFile(path.join(f.local, "local.txt"), "utf8"), "local\n");
});

test("dirty incoming overlap refuses pull without changing HEAD or local content", async t => {
  const f = await fixture(t);
  const head = await f.git(f.local, "rev-parse", "HEAD");
  await fs.writeFile(path.join(f.local, "content.txt"), "dirty\n");
  await f.incoming("content.txt", "upstream\n");
  const prediction = await f.controller.check();
  assert.equal(prediction.state, "conflict");
  assert.deepEqual(prediction.conflicts, ["content.txt"]);
  await assert.rejects(f.controller.pull(), /not available/u);
  assert.equal(await f.git(f.local, "rev-parse", "HEAD"), head);
  assert.equal(await fs.readFile(path.join(f.local, "content.txt"), "utf8"), "dirty\n");
});

test("committed final-tree conflict is predicted before mutation", async t => {
  const f = await fixture(t);
  const head = await f.commit(f.local, "content.txt", "local\n");
  await f.incoming("content.txt", "upstream\n");
  const prediction = await f.controller.check();
  assert.equal(prediction.state, "conflict");
  assert.deepEqual(prediction.conflicts, ["content.txt"]);
  await assert.rejects(f.controller.pull(), /not available/u);
  assert.equal(await f.git(f.local, "rev-parse", "HEAD"), head);
});

test("replay-only conflict aborts and restores HEAD and unrelated dirty work", async t => {
  const f = await fixture(t);
  await f.commit(f.local, "content.txt", "intermediate\n");
  const head = await f.commit(f.local, "content.txt", "original\n");
  await f.incoming("content.txt", "upstream\n");
  await fs.writeFile(path.join(f.local, "untracked.txt"), "keep me\n");
  await fs.writeFile(path.join(f.local, "auxiliary.txt"), "autostashed dirty\n");
  assert.equal((await f.controller.check()).state, "available");
  await assert.rejects(f.controller.pull(), /conflicted/u);
  assert.equal(await f.git(f.local, "rev-parse", "HEAD"), head);
  assert.equal(await fs.readFile(path.join(f.local, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(await fs.readFile(path.join(f.local, "auxiliary.txt"), "utf8"), "autostashed dirty\n");
  assert.equal(await f.git(f.local, "status", "--porcelain"), "M auxiliary.txt\n?? untracked.txt");
});

test("no upstream is unavailable without a network attempt or warning", async t => {
  const f = await fixture(t);
  await f.git(f.local, "branch", "--unset-upstream");
  const result = await f.controller.check();
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "no upstream");
  assert.deepEqual(f.warnings, []);
});

test("pull waits for the worktree transition and rechecks dirt inside the lease", async t => {
  const f = await fixture(t);
  const head = await f.git(f.local, "rev-parse", "HEAD");
  await f.incoming("content.txt", "remote\n");
  assert.equal((await f.controller.check()).state, "available");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = f.transitions.run(f.local, async () => {
    entered();
    await gate;
    await fs.writeFile(path.join(f.local, "content.txt"), "new dirty\n");
  });
  await ready;
  const pulling = f.controller.pull();
  release();
  await holding;
  await assert.rejects(pulling, /not available/u);
  assert.equal(await f.git(f.local, "rev-parse", "HEAD"), head);
});

test("repair failure is read and dismissal preserves journal identity and requires done", async t => {
  const f = await fixture(t);
  const journalPath = path.join(f.temporary.path, "data", ...INSTALLATION_REPAIR_JOURNAL_SEGMENTS);
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const journal: InstallationRepairJournal = {
    version: 1, id: randomUUID(), phase: "installing", fromSha: null, toSha: null,
    logPath: "repair.log", lastError: null, createdAt: 1, updatedAt: 1,
    failure: { at: 1, message: "install needed repair", logPath: "repair.log" },
  };
  await fs.writeFile(journalPath, JSON.stringify(journal));
  assert.deepEqual((await f.controller.check(false)).failure, journal.failure);
  await assert.rejects(f.controller.dismissFailure(), /not complete/u);
  assert.deepEqual(JSON.parse(await fs.readFile(journalPath, "utf8")), journal);
  await fs.writeFile(journalPath, JSON.stringify({ ...journal, phase: "done" }));
  await f.controller.dismissFailure();
  const saved: InstallationRepairJournal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  assert.equal(saved.failure, null);
  assert.equal(saved.id, journal.id);
  assert.equal(saved.phase, "done");
  assert.equal(f.controller.read().failure, null);
});

test("invalid repair journal warns without publishing rejected contents", async t => {
  const f = await fixture(t);
  const journalPath = path.join(f.temporary.path, "data", ...INSTALLATION_REPAIR_JOURNAL_SEGMENTS);
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await fs.writeFile(journalPath, '{"secret":"private-value"}');
  assert.equal((await f.controller.check(false)).failure, null);
  assert.equal(f.warnings.length, 1);
  assert.ok(!f.warnings[0]?.includes("private-value"));
});

test("failed fetch stays unavailable through local recomputes and logs each failure once", async t => {
  const f = await fixture(t);
  await f.incoming("remote.txt", "new\n");
  const warnings: string[] = [];
  let fetchFails = true;
  const controller = new WorkbenchInstallationUpdateController({
    repoRoot: f.local, dataRoot: path.join(f.temporary.path, "data"), transitions: f.transitions,
    projectId: async () => null, warn: warning => warnings.push(warning),
    git: async args => {
      if (args[0] === "fetch" && fetchFails) return { code: 1, stdout: "", stderr: "private network details" };
      const result = await execute("git", args, { cwd: f.local, windowsHide: true });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    },
  });
  t.after(() => controller.dispose());
  assert.equal((await controller.check()).state, "unavailable");
  assert.equal((await controller.check()).state, "unavailable");
  assert.equal((await controller.check(false)).state, "unavailable");
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0]?.includes("private network details"));
  fetchFails = false;
  assert.equal((await controller.check()).state, "available");
});

test("start owns one injected schedule and watcher and disposal stops both", async t => {
  const f = await fixture(t);
  let schedules = 0, watchers = 0, stoppedSchedules = 0, stoppedWatchers = 0;
  const controller = new WorkbenchInstallationUpdateController({
    repoRoot: f.local, dataRoot: path.join(f.temporary.path, "data"), transitions: f.transitions,
    projectId: async () => null, warn: warning => assert.fail(warning),
    schedule: () => { schedules++; return () => { stoppedSchedules++; }; },
    watch: () => { watchers++; return () => { stoppedWatchers++; }; },
  });
  controller.start();
  controller.start();
  await controller.dispose();
  assert.deepEqual([schedules, watchers, stoppedSchedules, stoppedWatchers], [1, 1, 1, 1]);
  controller.start();
  assert.equal(schedules, 1);
});

test("bursts coalesce without losing a scheduled fetch behind an active check", async t => {
  const f = await fixture(t);
  let tick!: () => void, changed!: () => void, release!: () => void, entered!: () => void, readAgain!: () => void;
  const firstFetch = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const secondRead = new Promise<void>(resolve => { readAgain = resolve; });
  let fetches = 0, reads = 0;
  const controller = new WorkbenchInstallationUpdateController({
    repoRoot: f.local, dataRoot: path.join(f.temporary.path, "data"), transitions: f.transitions,
    projectId: async () => { if (++reads === 2) readAgain(); return null; }, warn: warning => assert.fail(warning),
    schedule: callback => { tick = callback; return () => {}; },
    watch: callback => { changed = callback; return () => {}; },
    git: async args => {
      if (args[0] === "fetch") {
        fetches++;
        if (fetches === 1) { entered(); await gate; }
      }
      const result = await execute("git", args, { cwd: f.local, windowsHide: true });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    },
  });
  controller.start();
  await firstFetch;
  changed();
  tick();
  changed();
  release();
  await secondRead;
  await controller.dispose();
  assert.equal(fetches, 2);
});
