/*
 * No exports. Protect recorder-independent, repeat-safe image admission.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import externalizeCodexTranscriptInlineImages from "./codex-transcript-image-assets";

test("image admission preserves bytes and URLs without creating a JSON recorder", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wb-assets-"));
  try {
    const bytes = Buffer.from("test image bytes");
    const value = { type: "image", url: `data:image/png;base64,${bytes.toString("base64")}` };
    const context = { storageRoot, threadId: "thread" };
    const first = await externalizeCodexTranscriptInlineImages(value, context);
    const second = await externalizeCodexTranscriptInlineImages(value, context);
    assert.deepEqual(first.value, second.value);
    const parts = first.value.url.split("/");
    const directory = path.join(storageRoot, ".workbench/transcripts/codex/threads", parts.at(-2)!);
    assert.deepEqual(await fs.readFile(path.join(directory, "assets", parts.at(-1)!)), bytes);
    assert.deepEqual(await fs.readdir(directory), ["assets"]);
  } finally { await fs.rm(storageRoot, { recursive: true, force: true }); }
});
