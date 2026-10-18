/*
 * No exports. Wards for source mode in the mounted file panel: the toggle hands the same draft and history between the
 * rich editor and the markdown text, toolbar commands and keybinds edit the text as markdown, suggest mode forks the
 * block being typed in, and saves write exactly the text shown, line endings included.
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

test("the toggle shows the file's markdown, saves it as typed and renders it again", () => withPanel("# Title\n\nsome *text*\n", async panel => {
  await panel.caret("so|me");
  await panel.toolbar("source");
  assert.equal(panel.source.hidden, false);
  assert.equal(panel.editor.hidden, true);
  assert.equal(panel.sourceCaretText, "# Title\n\nso|me *text*\n");

  await panel.typeSource("!");
  assert.equal(await panel.save(), "# Title\n\nso!me *text*\n");

  await panel.pressSource("e", { ctrl: true });
  assert.equal(panel.editor.hidden, false);
  assert.equal(panel.editor.querySelector("em")?.textContent, "text");
  assert.equal(panel.caretText, "so!|me text");
}));

test("toolbar commands and keybinds edit the markdown text", () => withPanel("hello world\n", async panel => {
  await panel.caret("|hello");
  await panel.toolbar("source");
  await panel.selectSource("[world]");
  await panel.pressSource("b", { ctrl: true });
  assert.equal(panel.sourceCaretText, "hello **[world]**\n");
  await panel.toolbar("h2");
  assert.equal(panel.source.value, "## hello **world**\n");
  await panel.selectSource("world**|");
  await panel.pressSource("Enter");
  await panel.typeSource("- a");
  await panel.pressSource("Enter");
  await panel.typeSource("b");
  assert.equal(await panel.save(), "## hello **world**\n- a\n- b\n");
}));

test("undo and redo cross the toggle, restoring text in either mode", () => withPanel("one\n", async panel => {
  await panel.caret("one|");
  await panel.toolbar("source");
  await panel.typeSource(" two");
  await panel.toolbar("source");
  assert.equal(panel.editor.textContent, "one two");
  await panel.toolbar("undo");
  assert.equal(panel.editor.textContent, "one");
  await panel.toolbar("source");
  await panel.toolbar("redo");
  assert.equal(panel.source.value, "one two\n");
}));

test("suggest mode forks the block typed in into a suggestion of its old and new text", () => withPanel("keep\n\nchange me\n", async panel => {
  await panel.caret("|keep");
  await panel.toolbar("source");
  panel.panel.setReviewMode("suggest");
  await panel.selectSource("change| me");
  await panel.typeSource("d");
  await panel.typeSource("!");
  assert.equal(await panel.save(), "keep\n\n<del>\n\nchange me\n\n</del>\n<ins>\n\nchanged! me\n\n</ins>\n");
}));

test("a CRLF file keeps its line endings through source edits", () => withPanel("a\r\n\r\nb\r\n", async panel => {
  await panel.caret("|a");
  await panel.toolbar("source");
  await panel.selectSource("b|");
  await panel.typeSource("c");
  assert.equal(await panel.save(), "a\r\n\r\nbc\r\n");
}));
