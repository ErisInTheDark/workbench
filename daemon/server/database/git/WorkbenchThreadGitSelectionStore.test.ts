/* No production exports. Tests protect transactional selection isolation, batch restoration and scoped legacy import. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadGitSelectionStore from "./WorkbenchThreadGitSelectionStore";

async function fixture(context: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "selection-store-"));
  const database = new Database(path.join(root, "state.sqlite"));
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });
  const identities = new WorkbenchThreadIdentityRepository(database);
  for (const native of ["one", "two"]) identities.observe({
    native: { harness: "codex", nativeLocation: root, nativeThreadId: NativeThreadIdSchema.parse(native) },
    projectId: testProjectIds.fixture, projectRoot: root,
    title: native, createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  let now = 1_000_000;
  const store = new WorkbenchThreadGitSelectionStore(database, root, () => now);
  return { root, database, store, scope: { threadId: "one", worktreeRoot: root }, advance: () => { now += 300_000; } };
}

test("claimed batches isolate later selections and restore failures without crossing owners", async context => {
  const { root, store, scope, advance } = await fixture(context);
  store.execute({ kind: "add", scope, paths: ["first.txt"] });
  const batch = store.execute({ kind: "claim", scope });
  assert.equal(batch.kind, "claimed");
  if (batch.kind !== "claimed") return;
  assert.deepEqual(batch.selectedPaths, ["first.txt"]);
  store.execute({ kind: "add", scope, paths: ["later.txt", "first.txt"] });
  const otherThread = { ...scope, threadId: "two" };
  const otherRoot = { ...scope, worktreeRoot: path.join(root, "other") };
  for (const other of [otherThread, otherRoot]) {
    assert.throws(() => store.execute({ kind: "settle", scope: other, batchId: batch.batchId, outcome: "failed" }), /another owner/);
    assert.throws(() => store.execute({ kind: "claim", scope: other }), /no selected files/);
  }
  store.execute({ kind: "settle", scope, batchId: batch.batchId, outcome: "committed" });
  const next = store.execute({ kind: "claim", scope });
  assert.equal(next.kind, "claimed");
  if (next.kind !== "claimed") return;
  assert.deepEqual(next.selectedPaths, ["first.txt", "later.txt"]);
  store.execute({ kind: "add", scope, paths: ["new.txt"] });
  store.execute({ kind: "settle", scope, batchId: next.batchId, outcome: "failed" });
  const restored = store.execute({ kind: "claim", scope });
  assert.equal(restored.kind, "claimed");
  if (restored.kind !== "claimed") return;
  assert.deepEqual(restored.selectedPaths, ["first.txt", "later.txt", "new.txt"]);
  advance();
  assert.deepEqual(store.execute({ kind: "unstage", scope, paths: ["absent"] }), {
    kind: "selection", changedPaths: [], selectedPaths: ["first.txt", "later.txt", "new.txt"],
  });
  store.execute({ kind: "settle", scope, batchId: restored.batchId, outcome: "committed" });
  assert.deepEqual(store.execute({ kind: "unstage", scope, paths: ["."] }), {
    kind: "selection", changedPaths: ["first.txt", "later.txt", "new.txt"], selectedPaths: [],
  });
});

test("legacy selection conversion rolls back invalid markers and consumes each source once", async context => {
  const { root, database, store, scope } = await fixture(context);
  const worktreeHash = createHash("sha256").update(root).digest("hex");
  const nativeHash = createHash("sha256").update("one").digest("hex").slice(0, 12);
  const selected = path.join(root, ".state/thread-git/worktrees", worktreeHash, "threads", `one-${nativeHash}`, "selected");
  await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(selected, "a.json"), JSON.stringify({ version: 1, path: "imported.txt" }));
  await fs.writeFile(path.join(selected, "b.json"), JSON.stringify({ version: 1, path: "../escape.txt" }));
  assert.throws(() => store.execute({ kind: "add", scope, paths: ["new.txt"] }), /inside its worktree/);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM workbench_thread_git_selections").get(), { count: 0 });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM workbench_external_storage_imports").get(), { count: 0 });
  await fs.writeFile(path.join(selected, "b.json"), JSON.stringify({ version: 1, path: "second.txt" }));
  assert.deepEqual(store.execute({ kind: "add", scope, paths: ["new.txt"] }), {
    kind: "selection", changedPaths: ["new.txt"], selectedPaths: ["imported.txt", "new.txt", "second.txt"],
  });
  store.execute({ kind: "unstage", scope, paths: ["."] });
  await fs.writeFile(path.join(selected, "a.json"), "not json");
  assert.throws(() => store.execute({ kind: "claim", scope }), /no selected files/);
});
