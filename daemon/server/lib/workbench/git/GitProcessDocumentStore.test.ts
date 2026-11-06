/*
 * No production exports. Tests listed process documents leave Git's view and refuse tracked or claimed paths, backups chain only on
 * change and survive deletion, restores write bytes without touching unlisted files, and retention takes the backups with the thread.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { processDocumentsRef } from "workbench-shared/workbench/git/git-arc-storage";

import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";
import GitArcRetentionController from "./GitArcRetentionController";
import GitProcessDocumentStore from "./GitProcessDocumentStore";
import GitTestFixtureCache from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const thread = { harness: "codex" as const, threadId: "thread" };
const other = { harness: "codex" as const, threadId: "other" };
const ref = processDocumentsRef("codex", "thread");

async function fixture(context: TestContext) {
  const copied = await new GitTestFixtureCache().copyFresh(CONTROLLER_BASE_FIXTURE);
  context.after(copied.dispose);
  const repository = await WorkbenchGitRepository.open(copied.root);
  const write = async (name: string, text: string) => await fs.writeFile(path.join(copied.root, name), text);
  const read = async (name: string) => await fs.readFile(path.join(copied.root, name), "utf8");
  const status = async () => await repository.run(["status", "--porcelain", "--untracked-files=all"]);
  return { read, repository, root: copied.root, status, store: new GitProcessDocumentStore(repository), write };
}

test("a listed document leaves Git's view until every thread listing it drops it", async (context) => {
  const { status, store, write } = await fixture(context);
  await write("notes.md", "notes\n");
  assert.match(await status(), /notes\.md/u);
  await store.admit(thread, ["notes.md"]);
  await store.admit(other, ["notes.md"]);
  assert.doesNotMatch(await status(), /notes\.md/u);
  await store.admit(thread, []);
  assert.doesNotMatch(await status(), /notes\.md/u, "the other thread still lists it");
  await store.admit(other, []);
  assert.match(await status(), /notes\.md/u);
});

test("a linked worktree sharing the exclude file never drops the main checkout's block", async (context) => {
  const { repository, root, status, store, write } = await fixture(context);
  const linkedRoot = `${root}-linked`;
  await repository.run(["worktree", "add", "--quiet", "--detach", linkedRoot]);
  context.after(async () => await fs.rm(linkedRoot, { recursive: true, force: true }));
  const linked = new GitProcessDocumentStore(await WorkbenchGitRepository.open(linkedRoot));
  await write("notes.md", "notes\n");
  await store.admit(thread, ["notes.md"]);
  await linked.admit(thread, []);
  assert.doesNotMatch(await status(), /notes\.md/u);
  await linked.backup(thread, ["other.md"]);
  await linked.admit(thread, []);
  assert.doesNotMatch(await status(), /notes\.md/u);
  await store.admit(thread, []);
  assert.match(await status(), /notes\.md/u);
});

test("tracked and claimed paths refuse, hiding nothing", async (context) => {
  const { root, status, store, write } = await fixture(context);
  await assert.rejects(store.admit(thread, ["one.txt"]), /Tracked files/u);
  await new WorkbenchGitCheckpointController().createAndStartPlan({ cwd: root, threadId: "owner", intentName: "owner", paths: ["claimed.md"] });
  await write("claimed.md", "work\n");
  await write("free.md", "free\n");
  await assert.rejects(store.admit(thread, ["free.md", "claimed.md"]), /Claimed files/u);
  assert.match(await status(), /free\.md/u);
});

test("backups chain on the previous one only when a document changed, and keep what was deleted", async (context) => {
  const { repository, root, store, write } = await fixture(context);
  await write("notes.md", "one\n");
  await write("plan.md", "plan\n");
  const paths = ["notes.md", "plan.md"];
  const first = await store.backup(thread, paths);
  assert.ok(first);
  assert.deepEqual((await repository.readCommit(first)).parents, []);
  assert.equal(await store.backup(thread, paths), null);
  await write("notes.md", "two\n");
  const second = await store.backup(thread, paths);
  assert.ok(second);
  assert.deepEqual((await repository.readCommit(second)).parents, [first]);
  assert.equal(await repository.readRef(ref), second);
  await fs.rm(path.join(root, "plan.md"));
  const third = await store.backup(thread, paths);
  assert.ok(third);
  assert.deepEqual(await repository.listTreePaths(third), ["notes.md"]);
  assert.deepEqual(await repository.listTreePaths(second), ["notes.md", "plan.md"]);
});

test("a thread with nothing to back up writes nothing", async (context) => {
  const { repository, store } = await fixture(context);
  assert.equal(await store.backup(thread, ["missing.md"]), null);
  assert.equal(await repository.readRef(ref), null);
});

test("restore writes exact bytes from the named backup, even for a deleted file", async (context) => {
  const { read, root, store, write } = await fixture(context);
  await write("notes.md", "good\r\n");
  await store.admit(thread, ["notes.md"]);
  await store.backup(thread, ["notes.md"]);
  await write("notes.md", "better\n");
  await store.backup(thread, ["notes.md"]);
  await write("notes.md", "mangled");
  await store.restore(thread, 0, ["notes.md"]);
  assert.equal(await read("notes.md"), "better\n");
  await fs.rm(path.join(root, "notes.md"));
  await store.restore(thread, 1, ["notes.md"]);
  assert.equal(await read("notes.md"), "good\r\n");
});

test("restore refuses unlisted files, absent files and missing backups without writing", async (context) => {
  const { read, store, write } = await fixture(context);
  await assert.rejects(store.restore(thread, 0, ["notes.md"]), /no process document backups/u);
  await write("notes.md", "kept\n");
  await store.admit(thread, ["notes.md", "other.md"]);
  await store.backup(thread, ["notes.md", "other.md"]);
  await assert.rejects(store.restore(thread, 5, ["notes.md"]), /no process document backup 5/u);
  await assert.rejects(store.restore(thread, 0, ["other.md"]), /Not in that/u);
  await write("notes.md", "landing\n");
  await store.admit(thread, []);
  await assert.rejects(store.restore(thread, 0, ["notes.md"]), /Not listed/u);
  assert.equal(await read("notes.md"), "landing\n");
});

test("the checkpoint controller routes the backup ref to the store and needs paths", async (context) => {
  const { read, root, store, write } = await fixture(context);
  const controller = new WorkbenchGitCheckpointController();
  await write("notes.md", "good\n");
  await store.admit(thread, ["notes.md"]);
  await store.backup(thread, ["notes.md"]);
  await write("notes.md", "bad\n");
  const input = { checkpointCommit: "process-documents", cwd: root, harness: "codex", threadId: "thread" };
  await assert.rejects(controller.restore({ ...input, confirmRestore: true }), /needs paths/u);
  const restored = await controller.restore({ ...input, paths: ["notes.md"] });
  assert.deepEqual(restored.restoredPaths, ["notes.md"]);
  assert.equal(await read("notes.md"), "good\n");
});

test("retention takes a thread's backups with the rest of its Git history", async (context) => {
  const { repository, root, store, write } = await fixture(context);
  await write("notes.md", "notes\n");
  await store.backup(thread, ["notes.md"]);
  assert.ok(await repository.readRef(ref));
  await new GitArcRetentionController().pruneThread({ cwd: root, durableProposalIds: [], harness: "codex", threadId: "thread" });
  assert.equal(await repository.readRef(ref), null);
});
