/*
 * Exports:
 * - No production exports; tests protect transcript asset validation, immutable delivery, and missing-file behavior. Keywords: transcript, asset, http, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import WorkbenchTranscriptAssetController from "./WorkbenchTranscriptAssetController.ts";

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
  const assetRoot = path.join(root, ".workbench", "transcripts", "codex", "threads", threadId, "assets");
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(assetRoot, asset), Buffer.from([1, 2, 3]));
  const controller = new WorkbenchTranscriptAssetController(root);
  try {
    const valid = await request(controller, `/orchestrator/transcript-assets/codex/${threadId}/${asset}`);
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.headers["Content-Type"], "image/png");
    assert.equal(valid.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.deepEqual([...valid.body], [1, 2, 3]);

    const invalid = await request(controller, "/orchestrator/transcript-assets/codex/../secret.png");
    assert.equal(invalid.statusCode, 400);

    const missing = await request(controller, `/orchestrator/transcript-assets/codex/${threadId}/${"b".repeat(64)}.webp`);
    assert.equal(missing.statusCode, 404);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
