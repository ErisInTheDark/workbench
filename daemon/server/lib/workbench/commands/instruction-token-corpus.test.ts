/* Exports: none. Tests protect resolved instruction sources, sections, and source-only syntax stripping. */
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
      "Preamble z.",
      "## Z policy",
      "<available:thing>",
      "Keep z.",
      "</available:thing>",
      "{./nested/*}",
      "{workbench.rendering}",
    ].join("\n"));
    await writeFile(path.join(root, "nested", "a.md"), [
      "Preamble a.",
      "# A policy",
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
      "Preamble a.",
      "# A policy",
      "Keep a.",
      "",
      "",
      "Keep inner.",
      "",
      "Preamble z.",
      "## Z policy",
      "",
      "Keep z.",
    ].join("\n"));
    assert.deepEqual(corpus.sources.map(({ path, sections }) => ({
      path,
      sections: sections.map(({ endLine, heading, startLine }) => ({ endLine, heading, startLine })),
    })), [
      {
        path: "nested/a.md",
        sections: [
          { endLine: 1, heading: null, startLine: 1 },
          { endLine: 7, heading: "# A policy", startLine: 2 },
        ],
      },
      {
        path: "z.md",
        sections: [
          { endLine: 4, heading: null, startLine: 1 },
          { endLine: 10, heading: "## Z policy", startLine: 5 },
        ],
      },
    ]);
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
      writeFile(path.join(root, "leaf.md"), "# Inactive\nbase leaf"),
      writeFile(path.join(root, "leaf.override.md"), "leaf preamble\n## Active leaf\nactive leaf"),
      writeFile(path.join(cwd, "AGENTS.md"), "nested base"),
      writeFile(path.join(cwd, "AGENTS.override.md"), "## Nested\nnested active"),
    ]);

    const corpus = buildProjectInstructionTokenCorpus({
      cwd,
      roots: [{ rootPath: root }],
    });

    assert.ok(corpus.content.indexOf("root rule") < corpus.content.indexOf("active leaf"));
    assert.ok(corpus.content.indexOf("active leaf") < corpus.content.indexOf("nested active"));
    assert.match(corpus.content, /<!-- literal example -->/u);
    assert.doesNotMatch(corpus.content, /source note|base leaf|nested base|\{\.\/leaf\}/u);
    assert.deepEqual(corpus.files, ["AGENTS.md", "leaf.override.md", "nested/AGENTS.override.md"]);
    assert.deepEqual(
      corpus.sources.find(({ path }) => path === "leaf.override.md")?.sections
        .map(({ endLine, heading, startLine }) => ({ endLine, heading, startLine })),
      [
        { endLine: 1, heading: null, startLine: 1 },
        { endLine: 3, heading: "## Active leaf", startLine: 2 },
      ],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
