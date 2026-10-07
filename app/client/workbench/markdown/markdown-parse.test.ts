/*
 * No production exports. Regression wards protect thread emphasis delimiter pairing and editor-profile separation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isThreadMarkdownSectionBreak, parseBlocks, parseInlineMarkdown, parseThreadMarkdownSections } from "./markdown-parse";

test("thread sections split prose at top-level plans and mode changes only", () => {
  const markdown = [
    "intro **text**",
    "",
    "```md",
    "<plan>",
    "<set-state mode=\"Fake\" />",
    "```",
    "",
    "<notice title=\"n\" color=\"blue\">",
    "<plan>",
    "</notice>",
    "before mode <set-state mode=\"Inspect\" /> after mode",
    "<plan>",
    "step one",
    "</plan>",
    "",
    "tail",
  ].join("\r\n");
  const sections = parseThreadMarkdownSections(markdown);

  assert.deepEqual(sections.map(section => section.kind), ["prose", "stateChange", "prose", "plan", "prose"]);
  assert.match(sections[0]!.markdown, /^intro \*\*text\*\*\n\n```md\n<plan>\n<set-state mode="Fake" \/>\n```[\s\S]*<\/notice>\nbefore mode$/u);
  assert.equal(sections[2]!.markdown, "after mode");
  assert.equal(sections[4]!.markdown, "tail");
  // Rendering identifies the same breaks from parsed blocks.
  const options = { profile: "thread" } as const;
  assert.equal(parseBlocks(markdown, options).filter(block => isThreadMarkdownSectionBreak(block, options)).length, 2);
});

test("thread disclosures pair nested tags and leave fenced examples untouched", () => {
  const blocks = parseBlocks([
    "<details open><summary>outer **reason**</summary>",
    "before",
    "<details><summary>inner</summary>",
    "```md",
    "</details>",
    "```",
    "inside",
    "</details>",
    "after",
    "</details>",
  ].join("\n"), { profile: "thread" });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "details");
  if (blocks[0]?.type !== "details") return;
  assert.equal(blocks[0].open, true);
  assert.equal(blocks[0].summary, "outer **reason**");
  assert.match(blocks[0].text, /<details>\n<summary>inner<\/summary>/u);
  assert.match(blocks[0].text, /after$/u);
  assert.equal(parseBlocks("<details><summary>plain</summary>\nbody\n</details>")[0]?.type, "paragraph");
});

test("incomplete and unsupported thread disclosures remain literal", () => {
  for (const markdown of [
    "<details><summary>unfinished</summary>\nbody",
    '<details onclick="alert(1)"><summary>unsafe</summary>\nbody\n</details>',
    "<details>\nbody\n</details>",
  ]) {
    assert.equal(parseBlocks(markdown, { profile: "thread" }).some((block) => block.type === "details"), false);
  }
});

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

test("thread emphasis can end with punctuation before its closing star", () => {
  assert.deepEqual(
    parseInlineMarkdown("*batch two, no proposal until `globals.css` is gone.* next", { profile: "thread" }),
    [
      {
        type: "em",
        children: [
          { type: "text", text: "batch two, no proposal until " },
          { type: "code", text: "globals.css" },
          { type: "text", text: " is gone." },
        ],
      },
      { type: "text", text: " next" },
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
