/* No production exports. Tests protect the runtime-source boundary and source-only syntax stripping used by token measurement. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildProjectInstructionTokenCorpus,
  buildWorkbenchInstructionTokenCorpus,
} from "./instruction-token-corpus";

test("builds one deterministic corpus without authoring or control syntax", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-instruction-tokens-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "z.md"), [
      "---",
      "name: hidden",
      "---",
      "<available:thing>",
      "Keep z.",
      "</available:thing>",
      "{./nested/*}",
      "{workbench.rendering}",
    ].join("\n"));
    await writeFile(path.join(root, "nested", "a.md"), [
      "Keep a.",
      "<!-- failure rationale",
      "on two lines -->",
      "<custom-tag value=\"hidden\">Keep inner.</custom-tag>",
      "{{runtime.value}}",
    ].join("\n"));
    await writeFile(path.join(root, "nested", "ignored.template.md"), "Do not count this authoring guide.");
    await writeFile(path.join(root, "ignored.txt"), "Do not count this file.");

    const corpus = await buildWorkbenchInstructionTokenCorpus(root);

    assert.deepEqual(corpus.files, ["nested/a.md", "z.md"]);
    assert.equal(corpus.content, [
      "Keep a.",
      "",
      "",
      "Keep inner.",
      "",
      "Keep z.",
    ].join("\n"));
    assert.doesNotMatch(corpus.content, /available|failure rationale|runtime\.value|workbench\.rendering|nested\/\*|custom-tag|authoring guide|\{\}/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("builds the active cwd-owned AGENTS tree without source comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-instruction-tokens-"));
  const cwd = path.join(root, "nested");
  try {
    await mkdir(cwd);
    await Promise.all([
      writeFile(path.join(root, "AGENTS.md"), "root rule\n<!-- source note -->\n{./leaf}\n```md\n<!-- literal example -->\n```"),
      writeFile(path.join(root, "leaf.md"), "base leaf"),
      writeFile(path.join(root, "leaf.override.md"), "active leaf"),
      writeFile(path.join(cwd, "AGENTS.md"), "nested base"),
      writeFile(path.join(cwd, "AGENTS.override.md"), "nested active"),
    ]);

    const corpus = buildProjectInstructionTokenCorpus({
      cwd,
      roots: [{ rootPath: root }],
    });

    assert.ok(corpus.content.indexOf("root rule") < corpus.content.indexOf("active leaf"));
    assert.ok(corpus.content.indexOf("active leaf") < corpus.content.indexOf("nested active"));
    assert.match(corpus.content, /<!-- literal example -->/u);
    assert.doesNotMatch(corpus.content, /source note|base leaf|nested base|\{\.\/leaf\}/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
