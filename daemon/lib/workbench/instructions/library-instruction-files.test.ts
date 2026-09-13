/* No production exports. Tests protect active Workbench Library imports, overrides, runtime opacity, and bounded import failures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createLibraryInstructionFileGeneration } from "./library-instruction-files";

async function write(rootPath: string, relativePath: string, content: string) {
  const filePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function withLibrary(
  run: (rootPath: string) => Promise<void>,
) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "library-instruction-files-"));
  try {
    await run(rootPath);
  } finally {
    await fs.rm(rootPath, { force: true, recursive: true });
  }
}

test("resolves direct, globbed, recursive, and overridden instruction files", async () => {
  await withLibrary(async (rootPath) => {
    await Promise.all([
      write(rootPath, "AGENTS.md", "start\n{./direct}\n{./explicit.md}\n{./mechanics/*}\nend"),
      write(rootPath, "direct.md", "base direct"),
      write(rootPath, "direct.override.md", "override direct"),
      write(rootPath, "empty.md", "base empty"),
      write(rootPath, "empty.override.md", ""),
      write(rootPath, "explicit.md", "explicit file"),
      write(rootPath, "mechanics/a.md", "a: {./nested/value}"),
      write(rootPath, "mechanics/b.md", "base b"),
      write(rootPath, "mechanics/b.override.md", "override b"),
      write(rootPath, "mechanics/nested/value.md", "base nested"),
      write(rootPath, "mechanics/nested/value.override.md", "override nested"),
      write(rootPath, "mechanics/z.template.md", "template must stay out"),
    ]);

    const generation = createLibraryInstructionFileGeneration({ rootPath });
    assert.equal(generation.read("empty").content, "");
    assert.equal(generation.render("AGENTS"), [
      "start",
      "override direct",
      "explicit file",
      "a: override nested",
      "",
      "override b",
      "end",
    ].join("\n"));
  });
});

test("mapped rendering attributes imported output to the active source file", async () => {
  await withLibrary(async (rootPath) => {
    await Promise.all([
      write(rootPath, "AGENTS.md", "start\n{./mechanics/*}\nend"),
      write(rootPath, "mechanics/status.md", "base status"),
      write(rootPath, "mechanics/status.override.md", "heading\n<available:thread-status>\nbody"),
    ]);

    const rendered = createLibraryInstructionFileGeneration({ rootPath }).renderWithSources("AGENTS.md");
    const outputStart = rendered.content.indexOf("<available:thread-status>");
    const source = rendered.sources.find((candidate) => (
      candidate.outputStart <= outputStart && candidate.outputEnd > outputStart
    ));

    assert.equal(rendered.content, "start\nheading\n<available:thread-status>\nbody\nend");
    assert.equal(source?.absolutePath, path.join(rootPath, "mechanics/status.override.md"));
    const sourceStart = (source?.sourceStart ?? 0) + outputStart - (source?.outputStart ?? 0);
    assert.equal(source?.sourceContent.slice(sourceStart, sourceStart + "<available:thread-status>".length), "<available:thread-status>");
  });
});

test("runtime values remain opaque after recursive imports", async () => {
  await withLibrary(async (rootPath) => {
    await Promise.all([
      write(rootPath, "AGENTS.md", "{value}\n{unknown}\n{./leaf}"),
      write(rootPath, "leaf.md", "leaf {value}"),
      write(rootPath, "secret.md", "must not load"),
    ]);

    const output = createLibraryInstructionFileGeneration({ rootPath }).render("AGENTS.md", {
      value: "{./secret}\n{another.slot}",
    });
    assert.equal(output, [
      "{./secret}",
      "{another.slot}",
      "{unknown}",
      "leaf {./secret}",
      "{another.slot}",
    ].join("\n"));
    assert.doesNotMatch(output, /must not load/u);
  });
});

test("reports missing files, empty globs, path escapes, and cycles with their import chains", async () => {
  await withLibrary(async (rootPath) => {
    await Promise.all([
      write(rootPath, "missing.md", "{./nope}"),
      write(rootPath, "empty.md", "{./nothing/*}"),
      write(rootPath, "escape.md", "{./../outside}"),
      write(rootPath, "cycle-a.md", "{./cycle-b}"),
      write(rootPath, "cycle-b.md", "{./cycle-a}"),
    ]);
    const generation = createLibraryInstructionFileGeneration({ rootPath });

    assert.throws(
      () => generation.render("missing.md"),
      /does not exist[\s\S]*missing\.md -> nope/u,
    );
    assert.throws(
      () => generation.render("empty.md"),
      /glob is empty[\s\S]*empty\.md -> nothing\/\*/u,
    );
    assert.throws(
      () => generation.render("escape.md"),
      /escapes the Workbench Library[\s\S]*escape\.md -> \.\/\.\.\/outside/u,
    );
    assert.throws(
      () => generation.render("cycle-a.md"),
      /cycle detected[\s\S]*cycle-a\.md -> cycle-b\.md -> cycle-a\.md/u,
    );
  });
});
