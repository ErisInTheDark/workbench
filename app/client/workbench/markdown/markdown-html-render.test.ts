/*
 * No production exports. Protect ordered-list ordinals and repo file identity in rich-editor HTML.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToHtml } from "./markdown-html-render";

test("rich-editor HTML renders every ordered-list source ordinal literally", () => {
  const html = markdownToHtml([
    "3. alpha",
    "3. beta",
    "9007199254740993) gamma",
  ].join("\n"));
  const ordinals = Array.from(html.matchAll(/<li\svalue="(\d+)"/gu), (match) => match[1]);

  assert.deepEqual(ordinals, ["3", "3", "9007199254740993"]);
});

test("unordered-list items do not gain ordered values", () => {
  const html = markdownToHtml("- alpha\n- beta");

  assert.doesNotMatch(html, /<li\svalue=/u);
});

test("repo markdown links show repo identity while preserving their absolute open target", () => {
  const path = `/data/.cache/repos/mounts/github.com/openai/codex/${"a".repeat(40)}/src/file.ts`;
  const html = markdownToHtml(`[custom label](${path}:12)`);
  assert.ok(html.includes("repo:codex:"));
  assert.ok(html.includes("custom label"));
  assert.ok(html.includes(`data-project-file-absolute-path="${path}"`));
});
