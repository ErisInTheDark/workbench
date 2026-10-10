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

    assert.equal(store.collectOrphans(100), 1);
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
