/*
 * No exports. Canonicalisation fixtures for the mounted rich editor: each folder under canonicalisation-fixtures holds
 * input.md or input.html, the canonical editor DOM (after.html), and the markdown the real save button writes (output.md).
 * Run with UPDATE_EDITOR_FIXTURES=1 to regenerate goldens; a blocked save never produces output.md. EDITOR_FIXTURE=<substring> narrows the run.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import MountedFilePanel from "./testing/MountedFilePanel";
import { markdownToHtml } from "./markdown/markdown-html-render";
import { renderedWords, visibleWords } from "./testing/editor-text";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "canonicalisation-fixtures");
const UPDATE = process.env.UPDATE_EDITOR_FIXTURES === "1";

function read(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8").replaceAll("\r\n", "\n") : null;
}

async function openFixture(directory: string) {
  const markdown = read(path.join(directory, "input.md"));
  const html = read(path.join(directory, "input.html"));
  assert.ok((markdown === null) !== (html === null), "fixture needs exactly one of input.md or input.html");
  if (markdown !== null) {
    return { panel: await MountedFilePanel.open(markdown), source: markdown, words: renderedWords(markdownToHtml(markdown)), fromMarkdown: true };
  }
  const panel = await MountedFilePanel.open("");
  await panel.replaceHtml(html!.trim());
  return { panel, source: html!, words: renderedWords(html!), fromMarkdown: false };
}

function golden(file: string, actual: string) {
  const expected = read(file);
  if (UPDATE && expected !== actual) writeFileSync(file, actual);
  else if (expected === null) assert.fail(`missing ${path.basename(file)}; run with UPDATE_EDITOR_FIXTURES=1`);
  else assert.equal(actual, expected, path.basename(file));
}

const ONLY = process.env.EDITOR_FIXTURE;

for (const name of readdirSync(FIXTURES).sort().filter(name => !ONLY || name.includes(ONLY))) {
  const directory = path.join(FIXTURES, name);
  test(`canonicalisation fixture ${name}`, async () => {
    const { panel, source, words, fromMarkdown } = await openFixture(directory);
    const html = `${panel.html}\n`;
    let output: string;
    try {
      golden(path.join(directory, "after.html"), html);
      output = await panel.save();
    } catch (error) {
      if (UPDATE) rmSync(path.join(directory, "output.md"), { force: true });
      throw error;
    } finally {
      panel.dispose();
    }
    golden(path.join(directory, "output.md"), output);

    const reopened = await MountedFilePanel.open(output);
    try {
      assert.equal(await reopened.save(), output, "saved markdown must be a fixpoint when reopened");
      // The live editor keeps some pasted structure (root text, empty paragraphs) that only a fresh render rewrites.
      if (fromMarkdown) assert.equal(`${reopened.html}\n`, html, "reopening saved markdown must rebuild the same editor DOM");
      assert.deepEqual(visibleWords(reopened.editor), words, `visible words changed for ${JSON.stringify(source)}`);
    } finally {
      reopened.dispose();
    }
  });
}
