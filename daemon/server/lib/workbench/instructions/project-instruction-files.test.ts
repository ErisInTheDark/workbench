/* Exports: none. Tests protect project AGENTS ownership, ordering, provenance, overrides, worktree additions, imports, freshness, and root bounds. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test } from "node:test";

import type { WorkbenchProjectRoot } from "workbench-shared/types";
import {
  buildProjectInstructionContent,
  buildProjectInstructionContentWithSources,
} from "./project-instruction-files";

async function write(rootPath: string, relativePath: string, content: string) {
  const filePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function withProject(run: (rootPath: string) => Promise<void>) {
  const temporary = await WorkbenchTemporaryDirectory.create("project-instruction-files-");
  const rootPath = temporary.path;
  try {
    await run(rootPath);
  } finally {
    await temporary.dispose();
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

    const context = {
      cwd,
      roots: [root(rootPath)],
    };
    const expected = [
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
    ].join("\n");
    assert.equal(buildProjectInstructionContent(context), expected);
    const rendered = buildProjectInstructionContentWithSources(context);
    assert.equal(rendered?.content, expected);
    assert.deepEqual([
      ...new Set(rendered?.sources.map(({ absolutePath }) => (
        path.relative(rootPath, absolutePath).replaceAll("\\", "/")
      ))),
    ].sort(), [
      "AGENTS.md",
      "packages/AGENTS.override.md",
      "packages/app/AGENTS.md",
      "rules/a.md",
      "rules/b.md",
      "rules/base.override.md",
    ]);
  });
});

test("appends local instructions after each selected main file, including local-only directories", async () => {
  await withProject(async (rootPath) => {
    const cwd = path.join(rootPath, "nested");
    await Promise.all([
      write(rootPath, "AGENTS.md", "{./missing-inactive-import}"),
      write(rootPath, "AGENTS.override.md", "root override\n{./main-rule}"),
      write(rootPath, "main-rule.md", "imported main rule"),
      write(rootPath, "AGENTS.local.md", "root local\n{./local-rule}"),
      write(rootPath, "local-rule.md", "imported local rule"),
      write(rootPath, "nested/AGENTS.local.md", "nested local"),
    ]);
    const context = { cwd, roots: [root(rootPath)] };
    const rendered = buildProjectInstructionContentWithSources(context);
    assert.ok(rendered);
    const rules = ["root override", "imported main rule", "root local", "imported local rule", "nested local"];
    let previous = -1;
    for (const rule of rules) {
      const index = rendered.content.indexOf(rule);
      assert.ok(index > previous, `${rule} must follow the preceding instruction`);
      previous = index;
    }
    for (const source of rendered.sources) {
      const text = rendered.content.slice(source.outputStart, source.outputEnd);
      assert.equal(text, source.sourceContent.slice(source.sourceStart, source.sourceStart + text.length));
    }
    assert.ok(rendered.sources.some(({ absolutePath }) => absolutePath === path.join(cwd, "AGENTS.local.md")));

    await write(rootPath, "AGENTS.local.md", "revised local");
    const revised = buildProjectInstructionContent(context);
    assert.match(revised ?? "", /revised local/u);
    assert.doesNotMatch(revised ?? "", /root local|imported local rule/u);
  });
});

test("loads a standalone override through the normal import parser", async () => {
  await withProject(async (rootPath) => {
    await Promise.all([
      write(rootPath, "AGENTS.override.md", "{./rule}"),
      write(rootPath, "rule.md", "standalone override rule"),
    ]);
    assert.equal(buildProjectInstructionContent({ cwd: rootPath, roots: [root(rootPath)] }), "standalone override rule");
  });
});

test("local imports retain missing-file and root-boundary failures", async () => {
  await withProject(async (rootPath) => {
    const context = { cwd: rootPath, roots: [root(rootPath)] };
    await write(rootPath, "AGENTS.local.md", "{./missing}");
    assert.throws(
      () => buildProjectInstructionContent(context),
      /does not exist in project instructions[\s\S]*AGENTS\.local\.md -> missing/u,
    );
    await write(rootPath, "AGENTS.local.md", "{./../outside}");
    assert.throws(() => buildProjectInstructionContent(context), /escapes project instructions/u);
    await write(rootPath, "AGENTS.local.md", " \n ");
    assert.equal(buildProjectInstructionContent(context), null);
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
