/*
 * No production exports. Regression wards protect thread emphasis delimiter pairing, colour tag streaming, fenced code scoping and editor-profile separation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isThreadMarkdownSectionBreak, parseBlocks, parseInlineMarkdown, parseThreadMarkdownSections } from "./markdown-parse";

test("attachment mentions are not filesystem links and code examples remain literal", () => {
  const nodes = parseInlineMarkdown("#[attach:2] #[attach:removed] `#[attach:3]`", { profile: "thread" });
  assert.deepEqual(nodes.filter(node => node.type !== "text").map(node => node.type), [
    "attachmentMention", "attachmentMention", "code",
  ]);
});

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

test("a fence opened on a list item's first line is a code child that closes at the item's indent", () => {
  const blocks = parseBlocks([
    "- ````ts",
    "  event?(data: string): void",
    "  ````",
    "",
    "after",
  ].join("\n"));

  assert.deepEqual(blocks.filter(block => block.type !== "break").map(block => block.type), ["ul", "paragraph"]);
  if (blocks[0]?.type !== "ul") return;
  assert.equal(blocks[0].items[0]?.text, "");
  assert.deepEqual(blocks[0].items[0]?.children, [{ type: "code", language: "ts", text: "event?(data: string): void" }]);
});

test("thread plans, notices and disclosures close after a list item fence", () => {
  const markdown = [
    "<plan>",
    "- ````ts",
    "  code",
    "  ````",
    "</plan>",
    "",
    "<details><summary>more</summary>",
    "- ```ts",
    "  code",
    "  ```",
    "</details>",
    "",
    "<notice title=\"n\" color=\"blue\">",
    "- ```ts",
    "  code",
    "  ```",
    "</notice>",
    "",
    "tail",
  ].join("\n");
  const sections = parseThreadMarkdownSections(markdown);

  assert.deepEqual(sections.map(section => section.kind), ["plan", "prose"]);
  assert.deepEqual(
    parseBlocks(sections[1]!.markdown, { profile: "thread" }).filter(block => block.type !== "break").map(block => block.type),
    ["details", "notice", "paragraph"],
  );
});

test("thread inline html formatting tags parse like their markdown equivalents", () => {
  const thread = { profile: "thread" } as const;
  const cases = [
    ["<b>x</b>", "strong"], ["<STRONG>x</STRONG>", "strong"],
    ["<i>x</i>", "em"], ["<em>x</em>", "em"],
    ["<s>x</s>", "delete"], ["<strike>x</strike>", "delete"], ["<del>x</del>", "delete"],
    ["<ins>x</ins>", "insert"], ["<mark>x</mark>", "mark"],
    ["<u>x</u>", "underline"], ["<sub>x</sub>", "subscript"], ["<sup>x</sup>", "superscript"],
  ] as const;
  for (const [markdown, type] of cases) {
    assert.deepEqual(parseInlineMarkdown(markdown, thread), [{ children: [{ text: "x", type: "text" }], type }], markdown);
  }

  assert.deepEqual(parseInlineMarkdown("<b>a <b>b</b> c</b>", thread).map(node => node.type), ["strong"]);
  assert.deepEqual(parseInlineMarkdown("<code>**x**</code> <kbd>Ctrl</kbd>", thread), [
    { text: "**x**", type: "code" }, { text: " ", type: "text" }, { text: "Ctrl", type: "code" },
  ]);
  assert.deepEqual(parseInlineMarkdown("a<br>b<br/>c<BR />d", thread).map(node => node.type), ["text", "break", "text", "break", "text", "break", "text"]);
  assert.deepEqual(parseInlineMarkdown("<b>unclosed", thread), [{ text: "<b>unclosed", type: "text" }]);
  assert.equal(parseInlineMarkdown('<b class="x">attrs</b>', thread).some(node => node.type === "strong"), false);
});

const PARTIAL = { partial: true, profile: "thread" } as const;

test("partial thread text closes unclosed formatting at the frontier and stays literal once settled", () => {
  for (const [markdown, type] of [
    ["**bold text ", "strong"], ["*it ", "em"], ["~~gone ", "delete"], ["`code here ", "code"],
    ["<b>bold ", "strong"], ["<sup>up ", "superscript"], ['<u data-mark="x">tagged ', "markTag"], ["<!-- note ", "inlineComment"],
  ] as const) {
    assert.equal(parseInlineMarkdown(markdown, PARTIAL)[0]?.type, type, markdown);
    assert.equal(parseInlineMarkdown(markdown, { profile: "thread" })[0]?.type, "text", markdown);
  }
  assert.deepEqual(parseInlineMarkdown("**a *b ", PARTIAL), [
    { children: [{ text: "a ", type: "text" }, { children: [{ text: "b ", type: "text" }], type: "em" }], type: "strong" },
  ]);
});

test("partial thread text hides its unfinished frontier token, even inside optimistic formatting", () => {
  assert.deepEqual(parseInlineMarkdown("see app/client/Fo", PARTIAL), [{ text: "see ", type: "text" }]);
  assert.deepEqual(parseInlineMarkdown('ok <icon color="re', PARTIAL), [{ text: "ok ", type: "text" }]);
  assert.deepEqual(parseInlineMarkdown("**bold app/cli", PARTIAL), [{ children: [{ text: "bold ", type: "text" }], type: "strong" }]);
  // A plain word cannot change shape as it grows, so it shows.
  assert.deepEqual(parseInlineMarkdown("**bold wor", PARTIAL), [{ children: [{ text: "bold wor", type: "text" }], type: "strong" }]);
  assert.deepEqual(parseInlineMarkdown("**done** then wor", { profile: "thread", partial: false }).at(-1), { text: " then wor", type: "text" });
});

test("an unclosed partial icon stays a bare marker so later text is not recoloured", () => {
  const nodes = parseInlineMarkdown('<icon color="red" type="x">blocked ', PARTIAL);
  assert.deepEqual(nodes.map(node => node.type), ["threadIcon", "text"]);
  assert.equal(nodes[0]?.type === "threadIcon" && nodes[0].children, null);
});

test("thread colour tags wrap inline markdown and colour streamed text before their closer arrives", () => {
  assert.deepEqual(parseInlineMarkdown('<color color="red">a **b**</color> c', { profile: "thread" }), [
    { children: [{ text: "a ", type: "text" }, { children: [{ text: "b", type: "text" }], type: "strong" }], color: "red", type: "threadColor" },
    { text: " c", type: "text" },
  ]);
  assert.deepEqual(parseInlineMarkdown('<color color="#FF8800">streaming wor', PARTIAL), [
    { children: [{ text: "streaming wor", type: "text" }], color: "#ff8800", type: "threadColor" },
  ]);
  assert.deepEqual(parseInlineMarkdown("ok <colo", PARTIAL), [{ text: "ok ", type: "text" }]);
  assert.ok(parseInlineMarkdown('<color color="red">a</color>').every(node => node.type === "text"));
});

test("partial thread blocks hide unfinished frontier lines and close open containers", () => {
  const types = (markdown: string) => parseBlocks(markdown, PARTIAL).filter(block => block.type !== "break").map(block => block.type);

  assert.deepEqual(types("para\n\n| a | b |\n| --"), ["paragraph"]);
  assert.deepEqual(types("para\n\n| a | b |\n| --- | --- |"), ["paragraph"]);
  assert.deepEqual(types("| a | b |\n| --- | --- |\n| 1 | 2"), ["table"]);
  assert.deepEqual(types("text\n```t"), ["paragraph"]);
  assert.deepEqual(types("text\n\n#"), ["paragraph"]);
  assert.deepEqual(types("text\n\n12"), ["paragraph"]);
  assert.deepEqual(types("text\n\n- word"), ["paragraph", "ul"]);
  assert.deepEqual(types("<details>\n<summary>"), []);
  assert.deepEqual(types("<details>\n<summary>wh"), ["details"]);
  assert.deepEqual(parseBlocks("```ts\ncode\n``", PARTIAL), [{ language: "ts", text: "code", type: "code" }]);

  const [notice] = parseBlocks('<notice title="n" color="blue">\nbody ', PARTIAL);
  assert.equal(notice?.type === "notice" && notice.text, "body");
  const [emptyNotice] = parseBlocks('<notice title="n" color="blue">\n', PARTIAL);
  assert.equal(emptyNotice?.type === "notice" && emptyNotice.text, "");
  const [details] = parseBlocks("<details>\n<summary>why so ", PARTIAL);
  assert.equal(details?.type === "details" && details.summary, "why so");

  assert.deepEqual(types('<notice title="n" color="blue">\nbody'), ["notice"]);
  assert.equal(parseBlocks('<notice title="n" color="blue">\nbody', { profile: "thread" }).some(block => block.type === "notice"), false);
});

test("editor markdown only reads its review html tags so saves never rewrite other html", () => {
  assert.deepEqual(parseInlineMarkdown("<del>a</del><ins>b</ins><mark>c</mark>").map(node => node.type), ["delete", "insert", "mark"]);
  for (const markdown of ["<b>x</b>", "<u>x</u>", "<DEL>x</DEL>", "a<br>b"]) {
    assert.deepEqual(parseInlineMarkdown(markdown), [{ text: markdown, type: "text" }], markdown);
  }
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

test("editor identifiers keep underscore runs literal so saving never rewrites them", () => {
  assert.deepEqual(
    parseInlineMarkdown("word_part_name and mcp__wb__tool", { profile: "editor" }),
    [{ type: "text", text: "word_part_name and mcp__wb__tool" }],
  );
});
