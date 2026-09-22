/*
 * No production exports. Regression wards protect thread emphasis delimiter pairing and editor-profile separation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInlineMarkdown } from "./markdown-parse";

test("thread emphasis closes before punctuation without consuming the next phrase", () => {
  assert.deepEqual(
    parseInlineMarkdown("*the thread has 791 items*. the code does *not* prove it", { profile: "thread" }),
    [
      { type: "em", children: [{ type: "text", text: "the thread has 791 items" }] },
      { type: "text", text: ". the code does " },
      { type: "em", children: [{ type: "text", text: "not" }] },
      { type: "text", text: " prove it" },
    ],
  );
  assert.deepEqual(
    parseInlineMarkdown("*done*.Next", { profile: "thread" }),
    [
      { type: "em", children: [{ type: "text", text: "done" }] },
      { type: "text", text: ".Next" },
    ],
  );
});

test("thread emphasis leaves glob stars and intraword underscores literal", () => {
  assert.deepEqual(
    parseInlineMarkdown("src/*.ts and word_part_name, then *yes*!", { profile: "thread" }),
    [
      { type: "text", text: "src/*.ts and word_part_name, then " },
      { type: "em", children: [{ type: "text", text: "yes" }] },
      { type: "text", text: "!" },
    ],
  );
});

test("thread identifiers keep underscore runs literal while midword stars still emphasise", () => {
  assert.deepEqual(
    parseInlineMarkdown("mcp__wb__git_arc_status and foo*bar*baz", { profile: "thread" }),
    [
      { type: "text", text: "mcp__wb__git_arc_status and foo" },
      { type: "em", children: [{ type: "text", text: "bar" }] },
      { type: "text", text: "baz" },
    ],
  );
  assert.deepEqual(
    parseInlineMarkdown("__yes__ and _also_", { profile: "thread" }),
    [
      { type: "strong", children: [{ type: "text", text: "yes" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "also" }] },
    ],
  );
});

test("editor profile retains its existing intraword emphasis rule", () => {
  assert.deepEqual(
    parseInlineMarkdown("word_part_name", { profile: "editor" }),
    [
      { type: "text", text: "word" },
      { type: "em", children: [{ type: "text", text: "part" }] },
      { type: "text", text: "name" },
    ],
  );
});
