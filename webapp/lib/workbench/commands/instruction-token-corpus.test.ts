/* No production exports. Tests protect the runtime-source boundary and source-only syntax stripping used by token measurement. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildWorkbenchInstructionTokenCorpus } from "./instruction-token-corpus";

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
      "{workbench.rendering}",
    ].join("\n"));
    await writeFile(path.join(root, "nested", "a.md"), [
      "Keep a.",
      "<!-- failure rationale",
      "on two lines -->",
      "<custom-tag value=\"hidden\">Keep inner.</custom-tag>",
      "{{runtime.value}}",
    ].join("\n"));
    await writeFile(path.join(root, "nested", "ignored-template-prompt.md"), "Do not count this authoring guide.");
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
    assert.doesNotMatch(corpus.content, /available|failure rationale|runtime\.value|workbench\.rendering|custom-tag|authoring guide|\{\}/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
