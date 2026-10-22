/* Exports: none; real Git tests protect incremental peer bundles, tracking-ref-only receives, peer counts and unsent
 * history marks read against received tracking refs. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchGitPeerTransport from "./WorkbenchGitPeerTransport";
import WorkbenchGitRefs from "./WorkbenchGitRefs";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const execute = promisify(execFile);
const senderAddress = { daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-00000000000a"), projectId: ProjectIdSchema.parse("sender") };

async function repository(root: string) {
  await fs.mkdir(root, { recursive: true });
  const git = async (...args: string[]) => (await execute("git", args, {
    cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
  await git("init", "-b", "main");
  for (const [key, value] of [["user.name", "Workbench test"], ["user.email", "test@workbench.invalid"],
    ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git("config", key, value);
  const commit = async (file: string) => {
    await fs.writeFile(path.join(root, file), `${file}\n`);
    await git("add", file);
    await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  const repository = new WorkbenchGitRepository(root);
  return { root, git, commit, transport: new WorkbenchGitPeerTransport(repository), refs: new WorkbenchGitRefs(repository) };
}

/** Sender and receiver share one base commit, as two clones of one project do. */
async function fixture(t: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("git-peer-");
  t.after(() => temporary.dispose());
  const sender = await repository(path.join(temporary.path, "sender"));
  const receiver = await repository(path.join(temporary.path, "receiver"));
  const base = await sender.commit("base.txt");
  await receiver.git("fetch", "--quiet", path.join(temporary.path, "sender"), "main");
  await receiver.git("reset", "--hard", base);
  const transfer = async () => {
    const haves = await receiver.transport.haves(senderAddress, "main");
    const sent = await sender.transport.bundle("main", haves, new AbortController().signal);
    const bytes = sent.bundle ? await buffer(sent.bundle) : null;
    await sent.done;
    const tip = await receiver.transport.receive(senderAddress, "main", sent.tip, bytes ? Readable.from(bytes) : null,
      new AbortController().signal);
    return { tip, bytes };
  };
  return { sender, receiver, base, transfer };
}

test("a receive moves only the peer's tracking ref and later bundles carry only new commits", async t => {
  const f = await fixture(t);
  const first = await f.sender.commit("one.txt");
  const sent = await f.transfer();
  assert.equal(sent.tip, first);
  assert.ok(sent.bytes);
  const tracking = WorkbenchGitPeerTransport.trackingRef(senderAddress, "main");
  assert.equal(await f.receiver.git("rev-parse", tracking), first);
  assert.equal(await f.receiver.git("rev-parse", "HEAD"), f.base);
  assert.equal(await f.receiver.git("status", "--porcelain"), "");

  const second = await f.sender.commit("two.txt");
  const incremental = await f.transfer();
  assert.equal(await f.receiver.git("rev-parse", tracking), second);
  // The second bundle lists the first commit as a prerequisite instead of carrying it again.
  assert.match(incremental.bytes!.toString("latin1"), new RegExp(`^-${first}`, "mu"));

  const repeat = await f.transfer();
  assert.equal(repeat.bytes, null);
  assert.equal(repeat.tip, second);
});

test("a corrupt bundle leaves no tracking ref and no spool behind", async t => {
  const f = await fixture(t);
  const tip = await f.sender.commit("one.txt");
  await assert.rejects(f.receiver.transport.receive(senderAddress, "main", tip,
    Readable.from([Buffer.from("# v2 git bundle\nnot really\n")]), new AbortController().signal));
  assert.equal(await f.receiver.git("for-each-ref", "refs/remotes"), "");
  const spool = path.join(await f.receiver.git("rev-parse", "--absolute-git-dir"), "workbench-peer");
  assert.deepEqual(await fs.readdir(spool), []);
});

test("positions count commits each side lacks against the peer's tracking ref", async t => {
  const f = await fixture(t);
  await f.sender.commit("theirs-1.txt");
  await f.sender.commit("theirs-2.txt");
  await f.transfer();
  await f.receiver.commit("mine.txt");
  const position = await f.receiver.refs.position([senderAddress]);
  assert.equal(position.branch, "main");
  assert.deepEqual(position.peers.map(({ ahead, behind }) => ({ ahead, behind })), [{ ahead: 1, behind: 2 }]);
});

test("commit previews show only transferable history in either direction and expand beyond three", async t => {
  const f = await fixture(t);
  const incoming = [];
  for (const name of ["one", "two", "three", "four", "five"]) incoming.push(await f.sender.commit(`${name}.txt`));
  const outgoing = await f.receiver.commit("local.txt");
  await f.transfer();
  await fs.writeFile(path.join(f.receiver.root, "dirty.txt"), "keep me");
  const before = await f.receiver.git("status", "--porcelain");
  const request = { peer: senderAddress, branch: "main", action: "pull" as const, all: false };
  const preview = await f.receiver.transport.commits(request);
  assert.equal(preview.total, 5);
  assert.deepEqual(preview.commits.map(commit => commit.commit), incoming.slice(-3).reverse());
  const full = await f.receiver.transport.commits({ ...request, all: true });
  assert.deepEqual(full.commits.map(commit => commit.commit), [...incoming].reverse());
  assert.equal(full.commits[0]?.subject, "five.txt");
  const send = await f.receiver.transport.commits({ ...request, action: "send" });
  assert.deepEqual(send.commits.map(commit => commit.commit), [outgoing]);
  assert.equal(await f.receiver.git("rev-parse", "HEAD"), outgoing);
  assert.equal(await f.receiver.git("status", "--porcelain"), before);
});

test("history marks commits missing from a fetched peer as unsent", async t => {
  const f = await fixture(t);
  await f.transfer();
  const mine = await f.receiver.commit("mine.txt");
  const history = await f.receiver.refs.history({ limit: 10, peers: [senderAddress] });
  assert.deepEqual(history.commits.map(({ commit, unsent }) => ({ commit, unsent })),
    [{ commit: mine, unsent: true }, { commit: f.base, unsent: false }]);
});

test("commit previews reject a changed branch or missing tracking history instead of showing an empty list", async t => {
  const f = await fixture(t);
  const request = { peer: senderAddress, branch: "main", action: "pull" as const, all: false };
  await assert.rejects(f.receiver.transport.commits(request), /fetched/u);
  await f.transfer();
  await f.receiver.git("checkout", "-b", "other");
  await assert.rejects(f.receiver.transport.commits(request), /branch/u);
});
