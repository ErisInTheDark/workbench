/* No exports. Tests protect forward/reverse import closure and fresh on-disk resolution. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ProjectImportGraph from "./ProjectImportGraph";

test("walks runtime edges, cycles and importers without following erased types", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "import-graph-"));
  const file = (name: string) => path.join(root, `${name}.ts`);
  try {
    const files = {
      input: "export const value = 1",
      owner: 'import "./input"; export * from "./cycle"; import type { Shape } from "./types";',
      cycle: 'import "./owner"; void import("./dynamic");',
      dynamic: "export const dynamic = true",
      consumer: 'const owner = require("./owner");',
      types: 'export interface Shape {}',
      unrelated: 'export const unused = true',
    };
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(file(name), content)));
    const graph = new ProjectImportGraph(root, Object.keys(files).map(file));
    assert.deepEqual(graph.closure([file("owner")]), new Set(["owner", "input", "cycle", "dynamic"].map(file)));
    assert.deepEqual(graph.closure([file("input")], "importers"), new Set(["input", "owner", "cycle", "consumer"].map(file)));
    await writeFile(file("owner"), 'import "./unrelated";');
    const fresh = new ProjectImportGraph(root, Object.keys(files).map(file));
    assert.deepEqual(fresh.closure([file("owner")]), new Set(["owner", "unrelated"].map(file)));
    await writeFile(file("owner"), 'import "./missing";');
    assert.throws(() => new ProjectImportGraph(root, Object.keys(files).map(file)).closure([file("owner")]), /missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
