/*
 * No exports. Wards for code blocks and tables in the mounted rich editor: typing, Enter, Tab, Backspace and paste keep
 * code multi-line plain text and tables a grid of one-line cells, toolbar and typed shortcuts create them, and every
 * state saves as the fence or pipe table it shows.
 */
import assert from "node:assert/strict";
import test from "node:test";
import MountedFilePanel from "./testing/MountedFilePanel";

async function withPanel(markdown: string, body: (panel: MountedFilePanel) => Promise<void>) {
  const panel = await MountedFilePanel.open(markdown);
  try {
    await body(panel);
  } finally {
    panel.dispose();
  }
}

async function caretAtEnd(panel: MountedFilePanel) {
  const last = panel.editor.lastElementChild!;
  await panel.caretIn(last, last.childNodes.length);
}

test("Enter in code keeps the line's indent, and Enter on an empty last line steps out below", () => withPanel("```ts\nif (a) {\n```\n", async panel => {
  await panel.caret("if (a) {|");
  await panel.press("Enter");
  await panel.type("go();");
  assert.equal(await panel.save(), "```ts\nif (a) {\ngo();\n```\n");
  await panel.press("Enter");
  await panel.press("Enter");
  await panel.type("after");
  assert.equal(await panel.save(), "```ts\nif (a) {\ngo();\n```\n\nafter\n");
}));

test("Tab indents code, and formatting shortcuts leave code untouched", () => withPanel("```\nx\n```\n", async panel => {
  await panel.caret("|x");
  await panel.press("Tab");
  await panel.press("b", { ctrl: true });
  await panel.type("y");
  assert.equal(await panel.save(), "```\n  yx\n```\n");
}));

test("a typed fence and a typed pipe row become a code block and a table", () => withPanel("", async panel => {
  await caretAtEnd(panel);
  await panel.type("```sh\npnpm i");
  assert.equal(panel.editor.firstElementChild?.tagName, "PRE");
  await panel.press("Enter");
  await panel.press("Enter");
  await panel.type("| a | b |\n1");
  assert.equal(await panel.save(), "```sh\npnpm i\n```\n\n| a | b |\n| --- | --- |\n| 1 |  |\n");
}));

test("Enter and Tab move between cells, adding rows, and Enter on an empty last row leaves the table", () => withPanel("| a | b |\n| :---: | --- |\n| 1 | 2 |\n", async panel => {
  await panel.caret("1|");
  await panel.press("Tab");
  await panel.type("|x");
  await panel.press("Tab");
  await panel.type("3");
  await panel.press("Enter");
  await panel.press("Enter");
  await panel.type("below");
  assert.equal(await panel.save(), "| a | b |\n| :---: | --- |\n| 1 | 2\\|x |\n| 3 |  |\n\nbelow\n");
}));

test("Backspace never merges cells, and removes an empty body row", () => withPanel("| a | b |\n| --- | --- |\n| 1 | 2 |\n", async panel => {
  await panel.caret("|2");
  await panel.press("Backspace");
  assert.equal(await panel.save(), "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  await panel.caret("2|");
  await panel.press("Enter");
  await panel.press("Backspace");
  assert.equal(panel.editor.querySelectorAll("tr").length, 2);
  assert.equal(panel.caretText, "2|");
}));

test("the toolbar turns paragraphs into one code block and back, and inserts a table", () => withPanel("one\n\ntwo\n", async panel => {
  await panel.select("[one\ntwo]".replace("\n", ""));
  await panel.toolbar("code-block");
  assert.equal(await panel.save(), "```\none\ntwo\n```\n");
  await panel.caret("o|ne");
  await panel.toolbar("code-block");
  assert.equal(await panel.save(), "one\n\ntwo\n");
  await panel.caret("two|");
  await panel.toolbar("table");
  await panel.type("h");
  // The empty column and body row the caret never entered are pruned as it moves.
  assert.equal(await panel.save(), "one\n\ntwo\n\n| h |\n| --- |\n");
}));
