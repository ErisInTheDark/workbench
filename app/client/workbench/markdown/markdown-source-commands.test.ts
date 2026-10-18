/*
 * No exports. Wards for source-mode commands: toolbar formats toggle as markdown text in the file's style, Enter and
 * Tab continue and nest list lines, and suggest mode forks an edited block into a suggestion that reads back as one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseBlocks } from "./markdown-parse";
import {
  applySourceCommand,
  continueSourceBlock,
  forkSourceSuggestion,
  indentSourceLines,
  readSourceFormats,
  type SourceCommand,
  type SourceText,
} from "./markdown-source-commands";
import { DEFAULT_MARKDOWN_STYLE } from "./markdown-style";

/** `|` marks a caret and `[...]` a selection. */
function marked(source: string): SourceText {
  const caret = source.indexOf("|");
  if (caret >= 0 && !source.includes("[")) return { end: caret, start: caret, text: source.replace("|", "") };
  const start = source.indexOf("[");
  const end = source.indexOf("]") - 1;
  return { end, start, text: source.replace("[", "").replace("]", "") };
}

function show({ end, start, text }: SourceText) {
  return start === end ? `${text.slice(0, start)}|${text.slice(start)}` : `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
}

function run(source: string, command: SourceCommand, author: string | null = "Chiri") {
  return show(applySourceCommand(marked(source), command, { author, style: DEFAULT_MARKDOWN_STYLE }));
}

test("inline formats wrap a selection and unwrap it again, in the file's delimiters", () => {
  assert.equal(run("say [hi] there", "bold"), "say **[hi]** there");
  assert.equal(run("say **[hi]** there", "bold"), "say [hi] there");
  assert.equal(run("say [**hi**] there", "bold"), "say [hi] there");
  assert.equal(run("a |b", "inline-code"), "a `|`b");
  assert.equal(
    show(applySourceCommand(marked("[x]"), "italic", { author: null, style: { ...DEFAULT_MARKDOWN_STYLE, emphasis: "_" } })),
    "_[x]_",
  );
});

test("clear formatting drops markers in and right around the selection, keeping snake_case words", () => {
  assert.equal(run("say **[hi]** there", "clear-format"), "say [hi] there");
  assert.equal(run("[my_var *x* `y` <del>z</del>]", "clear-format"), "[my_var x y z]");
});

test("block formats toggle line prefixes across every touched line", () => {
  assert.equal(run("[one\ntwo]", "h2"), "## [one\n## two]");
  assert.equal(run("## [one]", "h2"), "[one]");
  assert.equal(run("# |title", "h3"), "### |title");
  assert.equal(run("[a\nb]", "ordered-list"), "1. [a\n2. b]");
  assert.equal(run("1. [a\n2. b]", "unordered-list"), "- [a\n- b]");
  assert.equal(run("- [a\n- b]", "unordered-list"), "[a\nb]");
  assert.equal(run("> [q]", "quote"), "[q]");
});

test("code blocks fence the touched lines, tables open below them and comments sign with the author", () => {
  assert.equal(run("[let x]", "code-block"), "```\n[let x]\n```");
  assert.equal(run("[```\nlet x\n```]", "code-block"), "[let x]");
  assert.equal(run("intro|", "table"), "intro\n\n| | |  |\n| --- | --- |\n|  |  |");
  assert.equal(run("the [fox] ran", "comment"), "the <mark>fox</mark><!-- [Chiri]: | --> ran");
  assert.equal(run("x|", "comment", null), "x<!-- | -->");
});

test("toolbar state reads the caret's line and open delimiters", () => {
  const formats = readSourceFormats(marked("## a **b|** c"), DEFAULT_MARKDOWN_STYLE);
  assert.equal(formats.block, "h2");
  assert.equal(formats.inline.bold, true);
  assert.equal(formats.inline.italic, false);
  assert.equal(readSourceFormats(marked("```\nco|de\n```"), DEFAULT_MARKDOWN_STYLE).block, "code");
});

test("Enter continues list and quote lines, ends an empty item and leaves code and prose alone", () => {
  assert.equal(show(continueSourceBlock(marked("- one|"))!), "- one\n- |");
  assert.equal(show(continueSourceBlock(marked("  3) three|"))!), "  3) three\n  4) |");
  assert.equal(show(continueSourceBlock(marked("- one\n- |"))!), "- one\n|");
  assert.equal(show(continueSourceBlock(marked("> said|"))!), "> said\n> |");
  assert.equal(continueSourceBlock(marked("plain|")), null);
  assert.equal(continueSourceBlock(marked("```\n- x|\n```")), null);
});

test("Tab nests list lines by the file's indent and indents prose at the caret", () => {
  assert.equal(show(indentSourceLines(marked("- a\n- |b"), false, 4)), "- a\n    - |b");
  assert.equal(show(indentSourceLines(marked("- a\n    - |b"), true, 4)), "- a\n- |b");
  assert.equal(show(indentSourceLines(marked("wo|rd"), false, 2)), "wo  |rd");
});

test("suggest mode forks the touched block so the edit lands in a suggestion's new side", () => {
  const fork = forkSourceSuggestion(marked("first\n\nsec|ond\n\nthird"))!;
  assert.equal(show(fork), "first\n\n<del>\n\nsecond\n\n</del>\n<ins>\n\nsec|ond\n\n</ins>\n\nthird");
  assert.deepEqual(parseBlocks(fork.text).filter((block) => block.type !== "break").map((block) => block.type), ["paragraph", "suggestion", "paragraph"]);
  assert.equal(forkSourceSuggestion(marked(fork.text.slice(0, fork.start) + "|" + fork.text.slice(fork.start))), null);

  const insertion = forkSourceSuggestion(marked("a\n|\nb"))!;
  assert.equal(show(insertion), "a\n<ins>\n\n|\n\n</ins>\nb");
});
