/*
 * No production exports. Regression wards protect which streaming blocks per-paragraph reveal shows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { holdStreamingBlocks } from "./markdown-hold";
import { parseBlocks, type ParsedBlock } from "./markdown-parse";

const parse = (markdown: string) => parseBlocks(markdown, { partial: true, profile: "thread" });

function shown(markdown: string) {
  return holdStreamingBlocks(parse(markdown), parse)
    .filter(block => block.type !== "break" && block.type !== "list-break")
    .map(describe);
}

function describe(block: ParsedBlock): string {
  if (block.type === "ul" || block.type === "ol") return `${block.type}:${block.items.map(item => item.text).join("|")}`;
  return "text" in block ? `${block.type}:${block.text}` : block.type;
}

test("the paragraph still arriving is held until something after it starts", () => {
  assert.deepEqual(shown("first paragraph\n\nsecond para"), ["paragraph:first paragraph"]);
  assert.deepEqual(shown("only paragraph so far"), []);
});

test("a heading waits for the paragraph beneath it to complete, then shows with it", () => {
  assert.deepEqual(shown("## Heading\n\nbody still arriving"), []);
  assert.deepEqual(shown("## Heading\n\nbody done\n\nnext block"), ["heading:Heading", "paragraph:body done"]);
});

test("a notice stays hidden, frame included, until its first inner block completes", () => {
  const opening = "intro\n\n<notice title=\"Heads up\" color=\"yellow\">\n";
  assert.deepEqual(shown(`${opening}inner still arriving`), ["paragraph:intro"]);
  assert.deepEqual(shown(`${opening}inner done\n\nmore inner`), ["paragraph:intro", "notice:inner done\n\nmore inner"]);
});

test("a heading before a held container keeps waiting with it", () => {
  assert.deepEqual(shown("## Notes\n\n<notice title=\"Heads up\" color=\"yellow\">\ninner still arriving"), []);
});

test("a streaming list shows only its completed items", () => {
  assert.deepEqual(shown("- one\n- two still"), ["ul:one"]);
  assert.deepEqual(shown("- one item"), []);
  assert.deepEqual(shown("- one\n- two\n- three ar"), ["ul:one|two"]);
});

test("code blocks are held whole until something follows them", () => {
  assert.deepEqual(shown("before\n\n```ts\nconst a = 1;"), ["paragraph:before"]);
});
