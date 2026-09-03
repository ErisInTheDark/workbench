/* No production exports. Tests protect project AGENTS ownership, ordering, overrides, imports, freshness, and root bounds. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { WorkbenchProjectRoot } from "workbench-shared/types";
import { buildProjectInstructionContent } from "./project-instruction-files";

async function write(rootPath: string, relativePath: string, content: string) {
  const filePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function withProject(run: (rootPath: string) => Promise<void>) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "project-instruction-files-"));
  try {
    await run(rootPath);
  } finally {
    await fs.rm(rootPath, { force: true, recursive: true });
  }
}

function root(rootPath: string, id = "project"): WorkbenchProjectRoot {
  return {
    id,
    isPrimary: true,
    name: id,
    relativePath: id,
    rootPath,
  };
}

test("resolves the owning root-to-cwd chain with active imports and no source narration", async () => {
  await withProject(async (rootPath) => {
    const cwd = path.join(rootPath, "packages", "app");
    await Promise.all([
      write(rootPath, "AGENTS.md", "root\n{./rules/base}\n{./rules/*}"),
      write(rootPath, "rules/base.md", "base rule"),
      write(rootPath, "rules/base.override.md", "overridden base"),
      write(rootPath, "rules/a.md", "glob a"),
      write(rootPath, "rules/b.md", "glob b"),
      write(rootPath, "packages/AGENTS.md", "unused package base"),
      write(rootPath, "packages/AGENTS.override.md", "package override"),
      write(rootPath, "packages/app/AGENTS.md", "app rule"),
    ]);

    assert.equal(buildProjectInstructionContent({
      cwd,
      roots: [root(rootPath)],
    }), [
      "root",
      "overridden base",
      "glob a",
      "",
      "glob b",
      "",
      "overridden base",
      "",
      "package override",
      "",
      "app rule",
    ].join("\n"));
  });
});

test("uses the deepest overlapping workspace root", async () => {
  await withProject(async (rootPath) => {
    const nestedRoot = path.join(rootPath, "nested");
    const cwd = path.join(nestedRoot, "cwd");
    await Promise.all([
      write(rootPath, "AGENTS.md", "outer rule"),
      write(nestedRoot, "AGENTS.md", "inner rule"),
      fs.mkdir(cwd, { recursive: true }),
    ]);

    assert.equal(buildProjectInstructionContent({
      cwd,
      roots: [root(rootPath, "outer"), root(nestedRoot, "inner")],
    }), "inner rule");
  });
});

test("reads project instructions fresh for each generation", async () => {
  await withProject(async (rootPath) => {
    await write(rootPath, "AGENTS.md", "{./current}");
    await write(rootPath, "current.md", "revision one");
    const context = { cwd: rootPath, roots: [root(rootPath)] };

    assert.equal(buildProjectInstructionContent(context), "revision one");
    await write(rootPath, "current.override.md", "revision two");
    assert.equal(buildProjectInstructionContent(context), "revision two");
  });
});

test("reports missing imports, cycles, empty globs, and root escapes with their chains", async () => {
  await withProject(async (rootPath) => {
    const context = { cwd: rootPath, roots: [root(rootPath)] };

    await write(rootPath, "AGENTS.md", "{./missing}");
    assert.throws(
      () => buildProjectInstructionContent(context),
      /does not exist in project instructions[\s\S]*AGENTS\.md -> missing/u,
    );

    await Promise.all([
      write(rootPath, "AGENTS.md", "{./cycle-a}"),
      write(rootPath, "cycle-a.md", "{./cycle-b}"),
      write(rootPath, "cycle-b.md", "{./cycle-a}"),
    ]);
    assert.throws(
      () => buildProjectInstructionContent(context),
      /cycle detected in project instructions[\s\S]*AGENTS\.md -> cycle-a\.md -> cycle-b\.md -> cycle-a\.md/u,
    );

    await write(rootPath, "AGENTS.md", "{./empty/*}");
    assert.throws(
      () => buildProjectInstructionContent(context),
      /glob is empty in project instructions[\s\S]*AGENTS\.md -> empty\/\*/u,
    );

    await write(rootPath, "AGENTS.md", "{./../outside}");
    assert.throws(
      () => buildProjectInstructionContent(context),
      /escapes project instructions[\s\S]*AGENTS\.md -> \.\/\.\.\/outside/u,
    );
  });
});
