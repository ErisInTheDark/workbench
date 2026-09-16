/* No production exports. Protect immutable diff text, identity scope and worker reopen. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { NativeThreadIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchLegacyDiffArtifactStore from "./WorkbenchLegacyDiffArtifactStore.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";

test("legacy diff text retains its canonical owner and reopens through the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-legacy-diff-"));
  const options = { databasePath: join(root, "workbench.sqlite3") };
  const database = new Database(options.databasePath);
  let worker: WorkbenchDatabaseController | undefined;
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const identities = new WorkbenchThreadIdentityRepository(database);
    const threads = ["owner", "other"].map(id => identities.observe({
      native: { harness: "codex", nativeLocation: "/project", nativeThreadId: NativeThreadIdSchema.parse(id) },
      projectId: ProjectIdSchema.parse("local:///project"), projectRoot: "/project",
      title: id, createdAt: 1, updatedAt: 1, activityAt: 1,
    }));
    const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
    const artifactId = createHash("sha256").update(diff).digest("hex");
    const input = { threadId: "owner", artifactId, diff };
    const store = new WorkbenchLegacyDiffArtifactStore(database);
    assert.throws(() => store.write({ ...input, diff: "corrupt" }), /digest/);
    store.write(input);
    store.write(input);
    assert.equal(store.read({ threadId: "other", artifactId }), null);
    database.close();
    worker = new WorkbenchDatabaseController(options);
    assert.equal(await worker.readLegacyDiffArtifact({ threadId: threads[0]!.threadId, artifactId }), diff);
    assert.equal(await worker.readLegacyDiffArtifact({ threadId: "owner", artifactId }), diff);
    assert.equal(await worker.readLegacyDiffArtifact({ threadId: threads[1]!.threadId, artifactId }), null);
  } finally {
    await worker?.close();
    if (database.open) database.close();
    await rm(root, { recursive: true, force: true });
  }
});
