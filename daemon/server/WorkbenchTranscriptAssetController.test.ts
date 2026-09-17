/*
 * Exports:
 * - No production exports; tests protect transcript asset validation, immutable delivery, and missing-file behavior.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import WorkbenchTranscriptAssetController from "./WorkbenchTranscriptAssetController.ts";
import WorkbenchTranscriptAssetStore from "./database/transcript/WorkbenchTranscriptAssetStore.ts";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository.ts";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema.ts";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native-later": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-later"),
    "native-owner": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-owner"),
  },
  NativeTurnId: {
    "first": fixtureIdentitySchemas.NativeTurnIdSchema.parse("first"),
    "later": fixtureIdentitySchemas.NativeTurnIdSchema.parse("later"),
  },
  ProjectId: {
    "project": testProjectIds.project,
  },
};

class TestResponse {
  body = new Uint8Array();
  headers: Record<string, number | string> = {};
  statusCode = 200;

  end(value: string | Uint8Array = "") {
    this.body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  }

  writeHead(statusCode: number, headers: Record<string, number | string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

async function request(controller: WorkbenchTranscriptAssetController, url: string) {
  const response = new TestResponse();
  await controller.handleHttpRequest(
    { method: "GET", url } as import("node:http").IncomingMessage,
    response as unknown as import("node:http").ServerResponse,
  );
  return response;
}

test("transcript assets enforce the allowlist and serve immutable typed bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-transcript-asset-"));
  const threadId = "dGhyZWFk";
  const asset = `${"a".repeat(64)}.png`;
  const controller = new WorkbenchTranscriptAssetController({
    readTranscriptAsset: async input => input.threadId === threadId && input.assetName === asset
      ? { bytes: new Uint8Array([1, 2, 3]), byteLength: 3, mimeType: "image/png", digest: "a".repeat(64), assetUrl: "" }
      : null,
  });
  try {
    const canonical = await request(controller, `/daemon/transcript-assets/${threadId}/${asset}`);
    assert.equal(canonical.statusCode, 200);
    assert.deepEqual([...canonical.body], [1, 2, 3]);
    const valid = await request(controller, `/daemon/transcript-assets/codex/${threadId}/${asset}`);
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.headers["Content-Type"], "image/png");
    assert.equal(valid.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.deepEqual([...valid.body], [1, 2, 3]);

    const invalid = await request(controller, "/daemon/transcript-assets/codex/../secret.png");
    assert.equal(invalid.statusCode, 400);

    const missing = await request(controller, `/daemon/transcript-assets/codex/${threadId}/${"b".repeat(64)}.webp`);
    assert.equal(missing.statusCode, 404);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("canonical asset requests retain native URLs without exposing another thread's bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-transcript-identity-asset-"));
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const observe = (nativeThreadId: string) => identities.observe({
    native: { harness: "codex", nativeLocation: root, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
    projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: root, title: "Assets", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const owner = observe("native-owner");
  const other = observe("native-other");
  identities.observeTurn({
    kind: "turn", threadId: owner.threadId, turnId: fixtureIdentityValues.NativeTurnId.first, nativeThreadId: fixtureIdentityValues.NativeThreadId["native-owner"],
    nativeTurnId: fixtureIdentityValues.NativeTurnId["first"], nativeLocation: root, harnessId: "codex", state: "completed",
    createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
  });
  // Represent an already-associated second execution, without adding a handoff API.
  database.prepare(`INSERT INTO workbench_pending_import_threads
    (thread_id, harness_id, native_location, native_thread_id, discovered_at, last_seen_at)
    VALUES (?, 'codex', ?, 'native-later', 2, 2)`).run(owner.threadId, root);
  identities.observeTurn({
    kind: "turn", threadId: owner.threadId, turnId: fixtureIdentityValues.NativeTurnId.later, nativeThreadId: fixtureIdentityValues.NativeThreadId["native-later"],
    nativeTurnId: fixtureIdentityValues.NativeTurnId["later"], nativeLocation: root, harnessId: "codex", state: "completed",
    createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
  });
  const store = new WorkbenchTranscriptAssetStore(database);
  const saved = store.write({ threadId: "native-owner", bytes: Buffer.from([4, 5, 6]), mimeType: "image/png" });
  const asset = `${saved.digest}.png`;
  const encoded = encodeTranscriptPathSegment("native-owner");
  const controller = new WorkbenchTranscriptAssetController({
    readTranscriptAsset: async (input) => store.read(input),
  });
  try {
    const canonical = await request(controller, saved.assetUrl.replace(/^\/api\//u, "/daemon/"));
    assert.equal(canonical.statusCode, 200);
    assert.deepEqual([...canonical.body], [4, 5, 6]);
    for (const reference of [owner.threadId, "native-owner", encoded]) {
      const response = await request(controller, `/daemon/transcript-assets/codex/${reference}/${asset}`);
      assert.equal(response.statusCode, 200);
      assert.deepEqual([...response.body], [4, 5, 6]);
    }
    assert.equal((await request(controller, `/daemon/transcript-assets/codex/${other.threadId}/${asset}`)).statusCode, 404);
  } finally {
    database.close();
    await fs.rm(root, { force: true, recursive: true });
  }
});
