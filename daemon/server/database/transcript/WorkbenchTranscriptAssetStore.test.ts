/* No production exports. Protect worker BLOB round-trip, immutable digests and thread-scoped reads. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { test } from "node:test";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { selectRows } from "workbench-shared/database/workbench-database-statements";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import Database from "better-sqlite3";
import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptAssetStore from "./WorkbenchTranscriptAssetStore.ts";

/** One thread with one turn holding item `item` (row 1) of `type`. */
function threadWithItem(database: Database.Database, type: string) {
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
  database.prepare("INSERT INTO workbench_harnesses(id) VALUES ('codex')").run();
  database.prepare(`INSERT INTO workbench_threads
    (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
    VALUES ('thread', ?, '/project', 'thread', 1, 1, 1, 1)`).run(testProjectIds.project);
  database.prepare(`INSERT INTO thread_turns
    (id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
    VALUES ('turn', 'thread', 0, 'codex', '/project', 'thread', 'completed', 1)`).run();
  database.prepare("INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES ('item', 'thread')").run();
  database.prepare(`INSERT INTO thread_items
    (id, public_id, thread_id, turn_id, item_position, type, created_at, updated_at)
    VALUES (1, 'item', 'thread', 'turn', 0, ?, 1, 1)`).run(type);
}

test("a call's skill component is kept once per call and component, so a later render never replaces it", () => {
  const database = new Database(":memory:");
  try {
    threadWithItem(database, "operation");
    const store = new WorkbenchTranscriptAssetStore(database);
    const target = { threadId: "thread", itemId: "item", skillPath: "/skills/devops/SKILL.md", component: "BuildList" };
    const first = { $workbench: "element" as const, type: "div", props: { children: "with result" } };
    const expired = { $workbench: "element" as const, type: "div", props: { children: "result expired" } };
    assert.equal(store.readCallComponent(target), null);
    assert.deepEqual(store.writeCallComponent(target, first), first);
    assert.deepEqual(store.writeCallComponent(target, expired), first);
    assert.deepEqual(store.writeCallComponent({ ...target, component: "BuildCard" }, expired), expired);
    // A line's inline components keep a slot each, apart from the call's own component and from each other.
    const bug = { $workbench: "element" as const, type: "span", props: { children: "Bug" } };
    const internal = { $workbench: "element" as const, type: "span", props: { children: "Internal" } };
    assert.deepEqual(store.writeCallComponent({ ...target, slot: "{\"name\":\"Bug\"}" }, bug), bug);
    assert.deepEqual(store.writeCallComponent({ ...target, slot: "{\"name\":\"Internal\"}" }, internal), internal);
    assert.deepEqual(store.readCallComponent({ ...target, slot: "{\"name\":\"Bug\"}" }), bug);
    assert.deepEqual(store.readCallComponent(target), first);
    assert.throws(() => store.writeCallComponent({ ...target, itemId: "missing" }, first), /not in this thread/u);
    database.prepare("DELETE FROM thread_items WHERE id = 1").run();
    assert.equal(database.prepare("SELECT COUNT(*) FROM transcript_asset_refs").pluck().get(), 0);
  } finally {
    database.close();
  }
});

test("a rendered component is retained with its owning message and cannot be replaced", () => {
  const database = new Database(":memory:");
  try {
    threadWithItem(database, "assistantMessage");
    const markup = '<Card content="hello" />';
    const secondMarkup = '<Card content="again" />';
    database.prepare(`INSERT INTO thread_item_assistant_messages(item_id, state, phase, text)
      VALUES (1, 'completed', 'commentary', ?)`).run(`${markup}\n${secondMarkup}`);
    const store = new WorkbenchTranscriptAssetStore(database);
    const target = { threadId: "thread", itemId: "item", markup };
    const original = { $workbench: "element" as const, type: "div", props: { children: "original" } };
    const changed = { $workbench: "element" as const, type: "div", props: { children: "changed" } };
    assert.deepEqual(store.writeComponent(target, original), original);
    assert.deepEqual(store.writeComponent(target, changed), original);
    assert.deepEqual(store.readComponent(target), original);
    assert.deepEqual(store.writeComponent({ ...target, markup: secondMarkup }, changed), changed);
    assert.equal(store.readComponent({ ...target, threadId: "other" }), null);
    database.prepare("DELETE FROM thread_items WHERE id = 1").run();
    assert.equal(database.prepare("SELECT COUNT(*) FROM transcript_asset_refs").pluck().get(), 0);
  } finally {
    database.close();
  }
});

test("immutable image bytes cross the worker, deduplicate, reopen and remain thread scoped", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-image-blob-");
  const root = temporary.path;
  const options = { databasePath: join(root, "workbench.sqlite3") };
  let database = new WorkbenchDatabaseController(options);
  try {
    const identities = await database.observeThreadIdentities(["first", "second"].map(id => ({
      native: { harness: "fixture-provider", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse(id) },
      projectId: testProjectIds.project, projectRoot: "/project",
      title: id, createdAt: 1, updatedAt: 1, activityAt: 1,
    })));
    const bytes = new Uint8Array([0, 255, 128, 1, 10, 13]);
    const input = { threadId: identities[0]!.threadId, bytes, mimeType: "image/png" as const };
    const asset = await database.writeTranscriptAsset(input);
    assert.deepEqual(await database.writeTranscriptAsset(input), asset);
    const assetName = `${asset.digest}.png`;
    assert.equal(await database.readTranscriptAsset({ threadId: identities[1]!.threadId, assetName }), null);
    await assert.rejects(database.readTranscriptAsset({ threadId: input.threadId, assetName, ownerThreadId: identities[1]!.threadId }), /another thread/);
    await assert.rejects(database.writeTranscriptAsset({ ...input, bytes: new Uint8Array([2]), expectedDigest: asset.digest }), /digest/);
    await assert.rejects(database.writeTranscriptAsset({ ...input, mimeType: "image/gif" }), /metadata/);
    await database.writeTranscriptAsset({ ...input, threadId: identities[1]!.threadId });
    assert.equal((await database.query(selectRows(evidenceTables.transcriptAssets))).length, 1);
    await database.close();
    database = new WorkbenchDatabaseController(options);
    const retained = await database.readTranscriptAsset({ threadId: input.threadId, assetName });
    assert.ok(retained);
    assert.deepEqual(retained.bytes, bytes);
    assert.equal(retained.byteLength, bytes.byteLength);
  } finally {
    await database.close();
    await temporary.dispose();
  }
});

test("orphan collection honours canonical references, shared content, and admission grace", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
    for (const threadId of ["first", "second"]) {
      database.prepare(`
        INSERT INTO workbench_threads
          (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
        VALUES (?, ?, '/project', ?, 1, 1, 1, 1)
      `).run(threadId, testProjectIds.project, threadId);
    }
    const store = new WorkbenchTranscriptAssetStore(database);
    const referenced = store.write({ threadId: "first", bytes: new Uint8Array([1]), mimeType: "image/png" });
    store.write({ threadId: "second", bytes: new Uint8Array([1]), mimeType: "image/png" });
    const orphan = store.write({ threadId: "first", bytes: new Uint8Array([2]), mimeType: "image/png" });
    const fresh = store.write({ threadId: "first", bytes: new Uint8Array([3]), mimeType: "image/png" });
    database.prepare("UPDATE transcript_assets SET created_at = 10").run();
    database.prepare("UPDATE transcript_assets SET created_at = 100 WHERE digest = ?").run(fresh.digest);
    const ownerThreadId = database.prepare(`
      SELECT thread_id FROM transcript_asset_addresses WHERE digest = ? ORDER BY thread_id LIMIT 1
    `).pluck().get(referenced.digest);
    database.prepare(`
      INSERT INTO transcript_asset_refs
        (id, thread_id, item_id, owner_kind, role, ref_index, asset_digest, created_at)
      VALUES ('shared', ?, NULL, 'thread', 'test', 0, ?, 10)
    `).run(ownerThreadId, referenced.digest);

    // The reachability scan is a pure read, so it can run off the writer before any collection.
    assert.deepEqual(store.listUnreachable(store.listOrphanCandidates(100), 100), [orphan.digest]);
    assert.equal(database.prepare("SELECT COUNT(*) FROM transcript_assets WHERE digest = ?").pluck().get(orphan.digest), 1);

    const collected = store.listOrphanCandidates(100).filter(digest => store.collectOrphan(digest, 100));
    assert.deepEqual(collected, [orphan.digest]);
    assert.equal(store.collectOrphan(referenced.digest, 100), false);
    assert.deepEqual(
      database.prepare("SELECT digest FROM transcript_assets ORDER BY digest").pluck().all(),
      [fresh.digest, referenced.digest].sort(),
    );
    assert.equal(database.prepare("SELECT COUNT(*) FROM transcript_asset_content WHERE digest = ?").pluck().get(orphan.digest), 0);
    assert.equal(database.prepare("SELECT COUNT(*) FROM transcript_asset_addresses WHERE digest = ?").pluck().get(orphan.digest), 0);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
