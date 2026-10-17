/*
 * No exports. Interaction wards for the mounted rich editor: typed shortcuts, key commands, structural keys and
 * selection-leave canonicalisation must leave every intermediate state savable with the expected markdown.
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

test("typing into an empty document saves the typed paragraph", () => withPanel("", async panel => {
  await caretAtEnd(panel);
  await panel.type("hello world");
  assert.equal(await panel.save(), "hello world\n");
}));

for (const level of [1, 2, 3, 4, 5, 6]) {
  test(`typing ${"#".repeat(level)} and a space starts a level ${level} heading`, () => withPanel("", async panel => {
    await caretAtEnd(panel);
    await panel.type(`${"#".repeat(level)} title`);
    assert.equal(panel.editor.firstElementChild?.tagName, `H${level}`);
    assert.equal(await panel.save(), `${"#".repeat(level)} title\n`);
  }));
}

test("dash shortcut builds a list and an empty item's enter leaves it", () => withPanel("", async panel => {
  await caretAtEnd(panel);
  await panel.type("- one\ntwo");
  assert.equal(await panel.save(), "- one\n- two\n");
  await panel.press("Enter");
  await panel.press("Enter");
  await panel.type("after");
  assert.equal(await panel.save(), "- one\n- two\n\nafter\n");
}));

test("ordered and quote text become blocks once the caret moves on", () => withPanel("", async panel => {
  await caretAtEnd(panel);
  await panel.type("1. first");
  assert.equal(panel.editor.querySelector("ol"), null, "the block holding the caret is left alone");
  await panel.type("\n> quoted\nend");
  assert.equal(await panel.save(), "1. first\n\n> quoted\n\nend\n");
}));

test("enter splits a paragraph and backspace joins it again", () => withPanel("onetwo\n", async panel => {
  await panel.caret("one|two");
  await panel.press("Enter");
  assert.equal(await panel.save(), "one\n\ntwo\n");
  await panel.caret("|two");
  await panel.press("Backspace");
  assert.equal(await panel.save(), "onetwo\n");
}));

test("shift enter keeps a soft line break inside the paragraph", () => withPanel("one\n", async panel => {
  await panel.caret("one|");
  await panel.press("Enter", { shift: true });
  await panel.type("two");
  assert.equal(await panel.save(), "one\ntwo\n");
}));

test("two soft line breaks in a paragraph stay savable", () => withPanel("one\n", async panel => {
  await panel.caret("one|");
  await panel.press("Enter", { shift: true });
  await panel.press("Enter", { shift: true });
  await panel.type("two");
  await panel.save();
}));

test("a soft line break in a heading stays savable", () => withPanel("# one\n", async panel => {
  await panel.caret("one|");
  await panel.press("Enter", { shift: true });
  await panel.type("two");
  await panel.save();
}));

test("typed lines that look like markdown after a soft break stay literal", () => withPanel("one\n", async panel => {
  await panel.caret("one|");
  await panel.press("Enter", { shift: true });
  await panel.type("- not a list");
  await panel.caret("|one");
  const saved = await panel.save();
  assert.equal(saved.split("\n").length, 3, `soft break must not split blocks: ${JSON.stringify(saved)}`);
}));

test("typed html-looking text stays literal text", () => withPanel("", async panel => {
  await caretAtEnd(panel);
  await panel.type("use <del>tags</del> literally");
  await panel.save();
}));

test("typing a space before formatted text keeps the space", () => withPanel("hello **world**\n", async panel => {
  await panel.caret("hello |world");
  await panel.type("there ");
  assert.equal(await panel.save(), "hello there **world**\n");
}));

test("typed html comment text stays literal text instead of becoming a comment", () => withPanel("", async panel => {
  await caretAtEnd(panel);
  await panel.type("<!-- not a note -->");
  assert.equal(panel.editor.querySelector("[data-comment-thread]"), null);
  assert.equal(await panel.save(), "\\<!-- not a note -->\n");
}));

for (const { name, keys, markdown } of [
  { name: "bold", keys: { key: "b", ctrl: true }, markdown: "alpha **beta** gamma\n" },
  { name: "italic", keys: { key: "i", ctrl: true }, markdown: "alpha *beta* gamma\n" },
  { name: "code", keys: { key: "`", ctrl: true }, markdown: "alpha `beta` gamma\n" },
  { name: "delete", keys: { key: "x", ctrl: true, shift: true }, markdown: "alpha <del>beta</del> gamma\n" },
  { name: "insert", keys: { key: "a", ctrl: true, shift: true }, markdown: "alpha <ins>beta</ins> gamma\n" },
]) {
  test(`${name} shortcut toggles the selected word on and off`, () => withPanel("alpha beta gamma\n", async panel => {
    const { key, ...modifiers } = keys;
    await panel.select("alpha [beta] gamma");
    await panel.press(key, modifiers);
    assert.equal(await panel.save(), markdown);
    await panel.select("alpha [beta] gamma");
    await panel.press(key, modifiers);
    assert.equal(await panel.save(), "alpha beta gamma\n");
  }));
}

test("a pending bold toggle formats only the text typed while it is on", () => withPanel("start\n", async panel => {
  await panel.caret("start|");
  await panel.press("b", { ctrl: true });
  await panel.type("bold");
  await panel.press("b", { ctrl: true });
  await panel.type(" plain");
  assert.equal(await panel.save(), "start**bold** plain\n");
}));

test("boundary whitespace stays inside a fresh mark until the caret leaves its block", () => withPanel("alpha beta gamma\n\nnext\n", async panel => {
  await panel.select("alpha [beta ]gamma");
  await panel.press("b", { ctrl: true });
  const editing = panel.editor.firstElementChild!;
  assert.equal(editing.querySelector("strong")?.textContent, "beta ", "the block holding the caret keeps its raw run");
  assert.equal(await panel.save(), "alpha **beta** gamma\n\nnext\n");
  await panel.caret("ne|xt");
  assert.equal(editing.querySelector("strong")?.textContent, "beta", "leaving the block canonicalises its run");
  assert.equal(await panel.save(), "alpha **beta** gamma\n\nnext\n");
}));

test("tab and shift tab at an item start nest and un-nest it", () => withPanel("- one\n- two\n", async panel => {
  await panel.caret("|two");
  await panel.press("Tab");
  assert.equal(await panel.save(), "- one\n  - two\n");
  await panel.caret("|two");
  await panel.press("Tab", { shift: true });
  assert.equal(await panel.save(), "- one\n- two\n");
}));

test("backspace at a top-level item start turns it into a paragraph", () => withPanel("- one\n- two\n", async panel => {
  await panel.caret("|two");
  await panel.press("Backspace");
  assert.equal(await panel.save(), "- one\n\ntwo\n");
}));

for (const { command, markdown } of [
  { command: "h1", markdown: "# alpha\n\nbeta\n" },
  { command: "h2", markdown: "## alpha\n\nbeta\n" },
  { command: "h3", markdown: "### alpha\n\nbeta\n" },
  { command: "quote", markdown: "> alpha\n\nbeta\n" },
] as const) {
  test(`${command} toolbar command toggles the caret's block and back`, () => withPanel("alpha\n\nbeta\n", async panel => {
    await panel.caret("al|pha");
    await panel.toolbar(command);
    assert.equal(await panel.save(), markdown);
    await panel.toolbar(command);
    assert.equal(await panel.save(), "alpha\n\nbeta\n");
  }));
}

test("list toolbar commands wrap selected paragraphs, switch list type, and unwrap an item", () => withPanel("one\n\ntwo\n\nthree\n", async panel => {
  await panel.select("[onetwo]");
  await panel.toolbar("unordered-list");
  assert.equal(await panel.save(), "- one\n- two\n\nthree\n");
  await panel.caret("o|ne");
  await panel.toolbar("ordered-list");
  assert.equal(await panel.save(), "1. one\n2. two\n\nthree\n");
  await panel.caret("t|wo");
  await panel.toolbar("ordered-list");
  assert.equal(await panel.save(), "1. one\n\ntwo\n\nthree\n");
}));

test("enter on an empty nested item moves it out one level", () => withPanel("- top\n  - child\n", async panel => {
  await panel.caret("child|");
  await panel.press("Enter");
  await panel.press("Enter");
  await panel.type("next");
  assert.equal(await panel.save(), "- top\n  - child\n- next\n");
}));

test("undo walks back through savable states to the document before typing", () => withPanel("start\n", async panel => {
  await panel.caret("start|");
  await panel.type(" more");
  assert.equal(await panel.save(), "start more\n");
  const seen: string[] = [];
  for (let step = 0; step < " more".length && seen.at(-1) !== "start\n"; step += 1) {
    await panel.press("z", { ctrl: true });
    seen.push(await panel.save());
  }
  assert.equal(seen.at(-1), "start\n", `undo states: ${JSON.stringify(seen)}`);
}));
