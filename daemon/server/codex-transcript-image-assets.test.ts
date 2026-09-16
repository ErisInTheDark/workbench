/*
 * No exports. Protect recorder-independent, repeat-safe image admission.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import externalizeCodexTranscriptInlineImages from "./codex-transcript-image-assets";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import { NativeThreadIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";

test("image admission preserves bytes and URLs without creating a JSON recorder", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wb-assets-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(storageRoot, "workbench.sqlite3") });
  try {
    await database.observeThreadIdentities([{
      native: { harness: "codex", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse("thread") },
      projectId: ProjectIdSchema.parse("local:///project"), projectRoot: "/project", title: "image",
      createdAt: 1, updatedAt: 1, activityAt: 1,
    }]);
    const bytes = Buffer.from("test image bytes");
    const value = { type: "image", url: `data:image/png;base64,${bytes.toString("base64")}` };
    const context = { assets: database, threadId: "thread" };
    const first = await externalizeCodexTranscriptInlineImages(value, context);
    const second = await externalizeCodexTranscriptInlineImages(value, context);
    assert.deepEqual(first.value, second.value);
    const parts = first.value.url.split("/");
    const retained = await database.readTranscriptAsset({ threadId: parts.at(-2)!, assetName: parts.at(-1)! });
    assert.ok(retained);
    assert.deepEqual(Buffer.from(retained.bytes), bytes);
  } finally { await database.close(); await fs.rm(storageRoot, { recursive: true, force: true }); }
});
