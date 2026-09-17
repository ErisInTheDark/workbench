/* No production exports. Protect worker BLOB round-trip, immutable digests and thread-scoped reads. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { selectRows } from "workbench-shared/database/workbench-database-statements";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";

test("immutable image bytes cross the worker, deduplicate, reopen and remain thread scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-image-blob-"));
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
    await rm(root, { recursive: true, force: true });
  }
});
