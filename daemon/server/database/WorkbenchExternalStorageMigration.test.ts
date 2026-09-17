/* No production exports. Protect atomic external imports and receipt-owned idempotence. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import WorkbenchExternalStorageMigration from "./WorkbenchExternalStorageMigration.ts";
import { installWorkbenchDatabaseSchema } from "./workbench-database-schema.ts";
import WorkbenchThreadIdentityRepository from "./thread-identity/WorkbenchThreadIdentityRepository.ts";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { createHash } from "node:crypto";
import WorkbenchTranscriptAssetStore from "./transcript/WorkbenchTranscriptAssetStore.ts";
import { encodeTranscriptPathSegment } from "../codex-transcript-normalizers.ts";
import WorkbenchLegacyDiffArtifactStore from "./git/WorkbenchLegacyDiffArtifactStore.ts";

test("image conversion validates bytes atomically and preserves deduplicated native URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-image-import-"));
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const identities = new WorkbenchThreadIdentityRepository(database);
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
    const artifactId = createHash("sha256").update(diff).digest("hex");
    const addresses: string[] = [];
    for (const nativeThreadId of ["first", "second"]) {
      identities.observe({
        native: { harness: "codex", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse(nativeThreadId) },
        projectId: testProjectIds.project, projectRoot: "/project",
        title: nativeThreadId, createdAt: 1, updatedAt: 1, activityAt: 1,
      });
      const address = encodeTranscriptPathSegment(nativeThreadId);
      addresses.push(address);
      const directory = path.join(root, "transcripts/codex/threads", address, "assets");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${digest}.png`), nativeThreadId === "first" ? bytes : Buffer.from("corrupt"));
    }
    const migration = new WorkbenchExternalStorageMigration(database, root);
    const diffDirectory = path.join(root, "git-checkpoint-diffs/threads/first");
    await mkdir(diffDirectory, { recursive: true });
    await writeFile(path.join(diffDirectory, `${artifactId}.diff`), diff);
    await assert.rejects(migration.run(), /transcripts/);
    assert.deepEqual(database.prepare("SELECT * FROM transcript_asset_content").all(), []);
    assert.deepEqual(database.prepare("SELECT * FROM workbench_external_storage_imports").all(), []);
    await writeFile(path.join(root, "transcripts/codex/threads", addresses[1]!, "assets", `${digest}.png`), bytes);
    await migration.run();
    assert.equal(new WorkbenchLegacyDiffArtifactStore(database).read({ threadId: "first", artifactId }), diff);
    assert.equal(new WorkbenchLegacyDiffArtifactStore(database).read({ threadId: "second", artifactId }), null);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM transcript_asset_content").get() as { n: number }).n, 1);
    for (const threadId of addresses) {
      assert.deepEqual(Buffer.from(new WorkbenchTranscriptAssetStore(database).read({ threadId, assetName: `${digest}.png` })!.bytes), bytes);
    }
    await writeFile(path.join(root, "transcripts/codex/threads", addresses[0]!, "assets", `${digest}.png`), "old rollback input");
    await migration.run();
    assert.deepEqual(Buffer.from(new WorkbenchTranscriptAssetStore(database).read({ threadId: addresses[0]!, assetName: `${digest}.png` })!.bytes), bytes);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capture-gap import retains owned obligations without reviving orphaned history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-gap-import-"));
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const thread = new WorkbenchThreadIdentityRepository(database).observe({
      native: { harness: "codex", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse("native") },
      projectId: testProjectIds.project, projectRoot: "/project",
      title: "retained", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const markerPath = path.join(root, "workbench-transcript-capture-gap.json");
    const marker = JSON.stringify({ version: 1, entries: [
      { id: "orphan", threadId: "missing", turnId: null, openedAt: 1, errorText: "failed", recoverability: "provider" },
      { id: "orphan-unrecoverable", threadId: "missing-too", turnId: null, openedAt: 1, errorText: "failed", recoverability: "unrecoverable" },
      { id: "gap", threadId: "native", turnId: null, openedAt: 1, errorText: "failed", recoverability: "provider" },
    ] });
    await writeFile(markerPath, marker);
    const warnings = t.mock.method(console, "warn", () => {});
    const migration = new WorkbenchExternalStorageMigration(database, root);
    database.prepare(`INSERT INTO transcript_capture_gaps(id, thread_id, turn_id, state, reason, opened_at, closed_at, error_text)
      VALUES ('gap', ?, NULL, 'reconciled', 'sqlite transcript settlement failed', 1, 2, 'failed')`).run(thread.threadId);
    await migration.run();
    assert.deepEqual(database.prepare("SELECT thread_id, state FROM transcript_capture_gaps").all(), [{ thread_id: thread.threadId, state: "open" }]);
    assert.deepEqual(database.prepare("SELECT id FROM workbench_threads").all(), [{ id: thread.threadId }]);
    assert.equal(await readFile(markerPath, "utf8"), marker);
    assert.equal(warnings.mock.callCount(), 1);
    database.exec("UPDATE transcript_capture_gaps SET state = 'reconciled', closed_at = 2");
    await migration.run();
    assert.deepEqual(database.prepare("SELECT state FROM transcript_capture_gaps").all(), [{ state: "reconciled" }]);
    assert.equal(warnings.mock.callCount(), 1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("catalogue import is atomic, retryable and cannot overwrite newer settings on reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-external-import-"));
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database);
    await mkdir(path.join(root, "settings"), { recursive: true });
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(path.join(root, "settings", "local-capabilities.json"), '{"browseRawCommandsEnabled":true}');
    await writeFile(path.join(root, "runtime", "browse-sessions.json"), '{"sessions":[{"name":12}]}');
    const migration = new WorkbenchExternalStorageMigration(database, root);
    await assert.rejects(migration.run(), /browse-sessions/);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM workbench_local_capabilities").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM workbench_external_storage_imports").get() as { count: number }).count, 0);
    await writeFile(path.join(root, "runtime", "browse-sessions.json"), JSON.stringify({
      sessions: [{ name: "session", lastActionAt: "2026-09-16T00:00:00.000Z", mode: "headless", threadId: "native-thread" }],
    }));
    await migration.run();
    assert.deepEqual(database.prepare("SELECT browse_raw_commands_enabled FROM workbench_local_capabilities").get(), { browse_raw_commands_enabled: 1 });
    assert.deepEqual(database.prepare("SELECT name, thread_id, mode FROM workbench_browse_sessions").all(), [{ name: "session", thread_id: "native-thread", mode: "headless" }]);
    database.prepare("UPDATE workbench_local_capabilities SET browse_raw_commands_enabled = 0").run();
    await writeFile(path.join(root, "settings", "local-capabilities.json"), "no longer valid JSON");
    await new WorkbenchExternalStorageMigration(database, root).run();
    assert.deepEqual(database.prepare("SELECT browse_raw_commands_enabled FROM workbench_local_capabilities").get(), { browse_raw_commands_enabled: 0 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("absent optional catalogues are consumed without creating filesystem fallbacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-external-empty-"));
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database);
    await new WorkbenchExternalStorageMigration(database, root).run();
    await mkdir(path.join(root, "settings"));
    await writeFile(path.join(root, "settings", "local-capabilities.json"), '{"browseRawCommandsEnabled":true}');
    await new WorkbenchExternalStorageMigration(database, root).run();
    assert.deepEqual(database.prepare("SELECT * FROM workbench_local_capabilities").all(), []);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
