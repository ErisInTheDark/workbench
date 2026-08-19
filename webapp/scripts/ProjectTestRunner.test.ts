/* No production exports. Regression wards cover deterministic TypeScript test discovery, exclusions, overlap deduplication, and empty selections. Keywords: tests, discovery, TSX, ordering. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ProjectTestRunner from "./ProjectTestRunner";

test("discovers TypeScript tests exactly once in stable order and skips generated trees", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-test-discovery-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([
    writeFile(path.join(root, "alpha.test.tsx"), ""),
    writeFile(path.join(root, "alpha.tsx"), ""),
    mkdir(path.join(root, "nested"), { recursive: true }).then(() => writeFile(path.join(root, "nested", "beta.test.ts"), "")),
    mkdir(path.join(root, "generated"), { recursive: true }).then(() => writeFile(path.join(root, "generated", "ignored.test.ts"), "")),
    mkdir(path.join(root, "node_modules"), { recursive: true }).then(() => writeFile(path.join(root, "node_modules", "ignored.test.tsx"), "")),
  ]);

  const discovered = await new ProjectTestRunner(root).discoverTestFiles(["nested", ".", "alpha.test.tsx"]);

  assert.deepEqual(discovered.map((file) => path.relative(root, file).replaceAll("\\", "/")), [
    "alpha.test.tsx",
    "nested/beta.test.ts",
  ]);
});

test("fails clearly when no TypeScript tests match", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-empty-test-discovery-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(() => new ProjectTestRunner(root).run(), /No \.test\.ts or \.test\.tsx files found under: \./u);
});

test("prewarms selected fixtures before starting the Node test process", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-prewarm-order-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const testFile = path.join(root, "prepared.test.ts");
  await writeFile(testFile, "");
  const events: string[] = [];

  class RecordingRunner extends ProjectTestRunner {
    protected override async runTestFiles(files: readonly string[]) {
      events.push(`run:${files.map((file) => path.basename(file)).join(",")}`);
      return { exitCode: 0, signal: null };
    }
  }

  const runner = new RecordingRunner(root, async (files) => {
    events.push(`prewarm:${files.map((file) => path.basename(file)).join(",")}`);
  });
  assert.deepEqual(await runner.run(), { exitCode: 0, signal: null });
  assert.deepEqual(events, ["prewarm:prepared.test.ts", "run:prepared.test.ts"]);
});
