/*
 * No exports. Save-guard sweep over markdown on disk: token pairs behind every block prefix must open, save without
 * blocking or changing their words, and save again unchanged once reopened.
 */
import assert from "node:assert/strict";
import test from "node:test";
import MountedFilePanel from "./testing/MountedFilePanel";
import { markdownToHtml } from "./markdown/markdown-html-render";
import { renderedWords } from "./testing/editor-text";
import { checkReopenedFixpoint, checkSavedWords, reportSweep, type SweepFailure } from "./testing/save-guard-sweep";

const MARKDOWN_TOKENS = [
  "word", "**bold**", "*em*", "***both***", "`code`", "`a``b`", "<del>gone</del>", "<ins>new</ins>", "~~struck~~",
  "[link](https://example.test/)", "[rel](docs/a.md)", "<!-- note -->", "\\*", "snake_case", "2*3", "#hash", "a_b_",
  "a&nbsp;b",
];
const MARKDOWN_PREFIXES = ["", "# ", "> ", "- ", "1. ", "- top\n  - "];

/** Glued pairs probe delimiter interactions, which block prefixes do not change, so only bare lines sweep them. */
function markdownLines(first: string, glued: boolean) {
  return MARKDOWN_TOKENS.flatMap(second => glued ? [`${first} ${second}`, `${first}${second}`] : [`${first} ${second}`]);
}

for (const prefix of MARKDOWN_PREFIXES) for (const first of MARKDOWN_TOKENS) {
  test(`${JSON.stringify(`${prefix}${first}`)} token pairs save their words and stay stable`, async () => {
    const failures: SweepFailure[] = [];
    const lines = markdownLines(first, prefix === "");
    for (const line of lines) {
      const markdown = `${prefix}${line}\n`;
      const panel = await MountedFilePanel.open(markdown);
      let saved: string | null;
      try {
        saved = await checkSavedWords(panel, markdown, renderedWords(markdownToHtml(markdown)), failures);
      } finally {
        panel.dispose();
      }
      if (saved !== null) await checkReopenedFixpoint(markdown, saved, failures);
    }
    assert.equal(failures.length, 0, reportSweep(failures, lines.length));
  });
}
