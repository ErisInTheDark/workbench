/*
 * No exports. Wards for table editing in the mounted rich editor: keyboard cell boxes and their formatting, copy and
 * paste of boxes, row and column inserts with inherited formats, pruning of empty rows and columns the selection left
 * (undo bringing them back with the caret inside), and clearing formatting across blocks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import MountedFilePanel from "./testing/MountedFilePanel";

const GRID = "| a | b |\n| --- | --- |\n| c | d |\n";

async function withPanel(markdown: string, body: (panel: MountedFilePanel) => Promise<void>) {
  const panel = await MountedFilePanel.open(markdown);
  try {
    await body(panel);
  } finally {
    panel.dispose();
  }
}

/** Box a cell from the keyboard: select all its text, then Shift+Arrow out of it. */
async function boxCell(panel: MountedFilePanel, text: string) {
  await panel.select(`[${text}]`);
  await panel.press("ArrowRight", { shift: true });
}

test("Shift+Arrow boxes a fully selected cell, grows the box, and formats every boxed cell", () => withPanel(GRID, async panel => {
  await boxCell(panel, "a");
  assert.deepEqual(panel.boxedCells, ["a"]);
  await panel.press("ArrowRight", { shift: true });
  await panel.press("ArrowDown", { shift: true });
  assert.deepEqual(panel.boxedCells, ["a", "b", "c", "d"]);
  await panel.press("b", { ctrl: true });
  assert.equal(await panel.save(), "| **a** | **b** |\n| --- | --- |\n| **c** | **d** |\n");
  await panel.press("\\", { ctrl: true });
  assert.equal(await panel.save(), GRID);
}));

test("Arrows move a box without passing the table's edges, and typing replaces the focus cell", () => withPanel(GRID, async panel => {
  await boxCell(panel, "a");
  await panel.press("ArrowRight");
  await panel.press("ArrowRight");
  assert.deepEqual(panel.boxedCells, ["b"]);
  await panel.press("ArrowDown");
  await panel.type("x");
  assert.deepEqual(panel.boxedCells, []);
  assert.equal(await panel.save(), "| a | b |\n| --- | --- |\n| c | x |\n");
}));

test("Ctrl+A boxes the whole table, and again selects the whole document", () => withPanel(`intro\n\n${GRID}`, async panel => {
  await panel.caret("c|");
  await panel.press("a", { ctrl: true });
  assert.deepEqual(panel.boxedCells, ["a", "b", "c", "d"]);
  await panel.press("a", { ctrl: true });
  assert.deepEqual(panel.boxedCells, []);
  assert.equal(window.getSelection()?.toString().includes("intro"), true);
}));

test("a copied box pastes into one selected cell, growing the table, and a bigger box takes no paste", () => withPanel("| **a** | b |\n| --- | --- |\n| c | d |\n", async panel => {
  await boxCell(panel, "a");
  await panel.press("ArrowRight", { shift: true });
  const clipboard = await panel.copy();
  assert.equal(clipboard.get("text/plain"), "a\tb");
  await panel.press("Escape");
  await panel.caret("d|");
  await panel.paste(clipboard);
  assert.equal(await panel.save(), "| **a** | b |  |\n| --- | --- | --- |\n| c | **a** | b |\n");

  await panel.press("a", { ctrl: true });
  await panel.paste(new Map([["text/plain", "zz"]]));
  assert.equal(await panel.save(), "| **a** | b |  |\n| --- | --- | --- |\n| c | **a** | b |\n");
}));

test("an inserted row keeps the caret, is pruned once the caret leaves, and undo restores it with the caret inside", () => withPanel(GRID, async panel => {
  await panel.caret("d|");
  await panel.press("ArrowDown", { ctrl: true, alt: true });
  assert.equal(panel.editor.querySelectorAll("tr").length, 3);
  assert.equal(panel.caretText, "|");

  await panel.caret("|a");
  assert.equal(await panel.save(), GRID);

  await panel.toolbar("undo");
  assert.equal(panel.editor.querySelectorAll("tr").length, 3);
  assert.equal(panel.caretText, "|");
  await panel.toolbar("redo");
  assert.equal(panel.editor.querySelectorAll("tr").length, 2);
}));

test("a new row inherits a column's shared format for typing, and the format keybind turns it off", () => withPanel("| a | b |\n| --- | --- |\n| **x** | y |\n| **z** | w |\n", async panel => {
  await panel.caret("z|");
  await panel.press("ArrowDown", { ctrl: true, alt: true });
  await panel.type("n");
  assert.equal(await panel.save(), "| a | b |\n| --- | --- |\n| **x** | y |\n| **z** | w |\n| **n** |  |\n");

  await panel.press("ArrowDown", { ctrl: true, alt: true });
  await panel.press("b", { ctrl: true });
  await panel.type("p");
  assert.equal(await panel.save(), "| a | b |\n| --- | --- |\n| **x** | y |\n| **z** | w |\n| **n** |  |\n| p |  |\n");
}));

test("inserted columns sit beside the caret's column, and deleting a column moves the caret beside it", () => withPanel(GRID, async panel => {
  await panel.caret("a|");
  await panel.press("ArrowRight", { ctrl: true, alt: true });
  await panel.type("h");
  assert.equal(await panel.save(), "| a | h | b |\n| --- | --- | --- |\n| c |  | d |\n");
  panel.panel.runCommand("delete-column");
  assert.equal(await panel.save(), GRID);
}));

test("clear formatting strips marks across the blocks a selection touches", () => withPanel("**one** *two*\n\n**three**\n", async panel => {
  await panel.select("on[e twoth]ree");
  await panel.toolbar("clear-format");
  assert.equal(await panel.save(), "**on**e two\n\nth**ree**\n");
}));
