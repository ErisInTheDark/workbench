/*
 * No production exports. Regression wards protect literal ordered-list ordinals in rich-editor HTML. Keywords: markdown, ordered list, ordinal, HTML.
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
