/*
 * Exports: none. Protect bounded, capability-only local catalogue reads.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import CodexModelCatalog from "./CodexModelCatalog";

test("missing metadata is unavailable, while supported bounds are read without unrelated model data", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-catalog-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const catalog = new CodexModelCatalog(home);
  assert.deepEqual(await catalog.read(), []);
  await writeFile(path.join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "configurable", context_window: 272_000, max_context_window: 872_000, instructions: "not capability data" },
    { slug: "fixed", context_window: 128_000, max_context_window: 128_000 },
    { slug: "unavailable" },
  ] }));
  assert.deepEqual(await catalog.read(), [
    { model: "configurable", defaultTokens: 272_000, maximumTokens: 872_000 },
    { model: "fixed", defaultTokens: 128_000, maximumTokens: 128_000 },
  ]);
  await writeFile(path.join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "changed", context_window: 300_000, max_context_window: 500_000 },
  ] }));
  assert.equal((await catalog.read())[0]?.model, "changed");
});

test("malformed or oversized metadata fails without exposing cached content", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-invalid-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const catalog = new CodexModelCatalog(home);
  const file = path.join(home, "models_cache.json");
  for (const source of [
    "PRIVATE_CONTENT malformed",
    JSON.stringify({ models: [{ slug: "PRIVATE_CONTENT", context_window: 300_000, max_context_window: 100_000 }] }),
    JSON.stringify({ models: [{ slug: "PRIVATE_CONTENT", context_window: "bad" }] }),
    "PRIVATE_CONTENT".repeat(400_000),
  ]) {
    await writeFile(file, source);
    await assert.rejects(catalog.read(), (error: Error) => {
      assert.equal(error.message.includes("PRIVATE_CONTENT"), false);
      return true;
    });
  }
});
