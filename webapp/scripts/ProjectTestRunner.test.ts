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
