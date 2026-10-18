/*
 * No exports. Review wards for the mounted rich editor: unedited markdown survives edits elsewhere byte for byte, suggest
 * mode turns changes into resolvable suggestions without moving the caret, mark tags annotate words one tag at a time and
 * round-trip as `u` elements, and comment threads round-trip as html comments.
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

const FOREIGN_MARKDOWN = [
  "Setext heading",
  "==============",
  "",
  "* star bullets",
  "* stay stars",
  "",
  "Some __underscore strong__ and _underscore em_.",
  "A paragraph right before a list:",
  "- tight item",
  "- second",
  "",
  "1) paren ordered",
  "2) list",
  "",
  "***",
  "",
].join("\n");

test("editing one block writes every other block back exactly as it was read", () => withPanel(FOREIGN_MARKDOWN, async panel => {
  await panel.caret("before a list:|");
  await panel.type(" yes");
  const saved = await panel.save();
  assert.equal(saved, FOREIGN_MARKDOWN.replace("before a list:", "before a list: yes"), JSON.stringify(saved));
}));

test("line endings and a missing final newline survive an edit", () => withPanel("one\r\n\r\ntwo", async panel => {
  await panel.caret("two|");
  await panel.type("!");
  assert.equal(await panel.save(), "one\r\n\r\ntwo!");
}));

test("typing in suggest mode keeps the caret's block in place and saves a suggestion", () => withPanel("alpha beta\n\nkeep\n", async panel => {
  panel.panel.setReviewMode("suggest");
  const block = panel.editor.firstElementChild;
  await panel.caret("alpha| beta");
  await panel.type("X");
  assert.equal(panel.editor.firstElementChild, block, "the edited block is the suggestion's new side, not a copy");
  assert.ok(block?.hasAttribute("data-suggestion"));
  assert.equal(await panel.save(), "<del>\n\nalpha beta\n\n</del>\n<ins>\n\nalphaX beta\n\n</ins>\n\nkeep\n");
}));

test("undoing a suggested change by hand leaves no suggestion", () => withPanel("alpha beta\n", async panel => {
  panel.panel.setReviewMode("suggest");
  await panel.caret("alpha| beta");
  await panel.type("X");
  await panel.select("alpha[X] beta");
  await panel.press("Backspace");
  assert.equal(await panel.save(), "alpha beta\n", panel.html);
  assert.equal(panel.editor.querySelector("[data-suggestion]"), null);
}));

for (const { action, markdown } of [
  { action: "accept", markdown: "alphaX beta\n\nkeep\n" },
  { action: "reject", markdown: "alpha beta\n\nkeep\n" },
] as const) {
  test(`${action}ing a suggestion keeps one side`, () => withPanel("alpha beta\n\nkeep\n", async panel => {
    panel.panel.setReviewMode("suggest");
    await panel.caret("alpha| beta");
    await panel.type("X");
    await panel.resolveSuggestion(action);
    assert.equal(await panel.save(), markdown);
    assert.equal(panel.editor.querySelector("[data-suggestion]"), null);
  }));
}

test("a suggestion read from markdown resolves to its original", () => withPanel("<del>\n\nold words\n\n</del>\n<ins>\n\nnew words\n\n</ins>\n", async panel => {
  await panel.caret("new| words");
  await panel.resolveSuggestion("reject");
  assert.equal(await panel.save(), "old words\n");
}));

test("editing a suggestion's original column rewrites its original side", () => withPanel("<del>\n\nold words\n\n</del>\n<ins>\n\nnew words\n\n</ins>\n", async panel => {
  await panel.caret("new| words");
  const original = document.querySelector<HTMLElement>("[data-suggestion-row-old]");
  assert.ok(original);
  const text = document.createTreeWalker(original, NodeFilter.SHOW_TEXT).nextNode() as Text;
  text.data = "older words";
  original.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  assert.equal(await panel.save(), "<del>\n\nolder words\n\n</del>\n<ins>\n\nnew words\n\n</ins>\n");
  await panel.caret("new| words");
  await panel.resolveSuggestion("reject");
  assert.equal(await panel.save(), "older words\n");
}));

const MARK_TAGS = [{ color: "red", name: "bad" }, { color: "purple", name: "rethink" }] as const;

function suggesting(panel: MountedFilePanel) {
  panel.panel.setReviewMode("suggest");
  panel.panel.setMarkTags(MARK_TAGS);
}

test("a mark tag keybind tags the selection without suggesting a change, swaps tags, and takes its own tag off", () => withPanel("alpha beta gamma\n", async panel => {
  suggesting(panel);
  await panel.select("alpha [beta] gamma");
  await panel.press("1", { alt: true });
  assert.equal(await panel.save(), "alpha <u data-mark=\"bad\">beta</u> gamma\n");
  assert.equal(panel.editor.querySelector("[data-suggestion]"), null, "a tag annotates; it is not a suggested change");
  assert.equal(window.getSelection()?.toString(), "beta", "the tagged words stay selected for the next tag");

  await panel.press("2", { alt: true });
  assert.equal(await panel.save(), "alpha <u data-mark=\"rethink\">beta</u> gamma\n", "words carry one tag at a time");
  await panel.press("2", { alt: true });
  assert.equal(await panel.save(), "alpha beta gamma\n");
}));

test("a caret tags its word, and untags the whole run it sits in", () => withPanel("alpha beta gamma\n", async panel => {
  suggesting(panel);
  await panel.caret("gam|ma");
  await panel.press("1", { alt: true });
  assert.equal(await panel.save(), "alpha beta <u data-mark=\"bad\">gamma</u>\n");
  await panel.select("alpha [beta gamma]");
  await panel.press("1", { alt: true });
  assert.equal(await panel.save(), "alpha <u data-mark=\"bad\">beta gamma</u>\n");
  await panel.caret("be|ta");
  await panel.press("1", { alt: true });
  assert.equal(await panel.save(), "alpha beta gamma\n");
}));

test("a mark tag keybind tags the live selection, not one a closed toolbar menu preserved", () => withPanel("alpha beta gamma\n", async panel => {
  suggesting(panel);
  await panel.caret("al|pha");
  panel.panel.beginToolbarInteraction(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await panel.select("alpha beta [gamma]");
  await panel.press("1", { alt: true });
  assert.equal(await panel.save(), "alpha beta <u data-mark=\"bad\">gamma</u>\n");
}));

test("mark tag keybinds do nothing while editing or for unassigned digits", () => withPanel("alpha beta\n", async panel => {
  panel.panel.setMarkTags(MARK_TAGS);
  await panel.select("alpha [beta]");
  await panel.press("1", { alt: true });
  panel.panel.setReviewMode("suggest");
  await panel.press("3", { alt: true });
  assert.equal(await panel.save(), "alpha beta\n");
}));

test("tagged words read from markdown save exactly when their block is rewritten", () => withPanel("say <u data-mark=\"needs &quot;work&quot;\">**this** one</u> now\n", async panel => {
  await panel.caret("now|");
  await panel.type("!");
  assert.equal(await panel.save(), "say <u data-mark=\"needs &quot;work&quot;\">**this** one</u> now!\n");
}));

test("text that looks like a mark tag stays literal", () => withPanel("plain\n", async panel => {
  await panel.caret("plain|");
  await panel.type(" <u data-mark=\"x\">y</u>");
  assert.equal(await panel.save(), "plain \\<u data-mark=\"x\">y\\</u>\n");
}));

test("commenting on selected words highlights them and threads replies", () => withPanel("alpha beta gamma\n", async panel => {
  await panel.select("alpha [beta] gamma");
  await panel.toolbar("comment");
  panel.panel.comments.submitDraft("why?", null);
  assert.equal(await panel.save(), "alpha <mark>beta</mark><!-- why? --> gamma\n");

  const [thread] = panel.panel.comments.getSnapshot().threads;
  assert.ok(thread);
  panel.panel.comments.reply(thread.id, "because", "Chiri V");
  assert.equal(await panel.save(), "alpha <mark>beta</mark><!-- why? --><!-- [Chiri V]: because --> gamma\n");

  panel.panel.comments.resolve(thread.id);
  assert.equal(await panel.save(), "alpha beta gamma\n");
}));

test("commenting with a collapsed caret adds a comment line after the block", () => withPanel("one\n\ntwo\n", async panel => {
  await panel.caret("one|");
  await panel.toolbar("comment");
  panel.panel.comments.submitDraft("needs work", null);
  assert.equal(await panel.save(), "one\n<!-- needs work -->\n\ntwo\n");

  const [thread] = panel.panel.comments.getSnapshot().threads;
  panel.panel.comments.resolve(thread!.id);
  assert.equal(await panel.save(), "one\n\ntwo\n");
}));

test("comment threads keep their authors and exact source", () => withPanel("text <mark>here</mark><!--@agent:  look --> end\n<!-- @chiri: block note -->\n", async panel => {
  panel.panel.comments.refresh();
  const threads = panel.panel.comments.getSnapshot().threads;
  assert.deepEqual(threads.map(thread => thread.comments.map(({ author, body }) => ({ author, body }))), [
    [{ author: "agent", body: "look" }],
    [{ author: "chiri", body: "block note" }],
  ]);
  await panel.caret("end|");
  await panel.type("!");
  assert.equal(await panel.save(), "text <mark>here</mark><!--@agent:  look --> end!\n<!-- @chiri: block note -->\n");
}));

test("editing a note's author or body rewrites only that note, and an emptied body keeps it", () => withPanel("one\n<!-- @chiri: first --><!-- second -->\n", async panel => {
  panel.panel.comments.refresh();
  const [thread] = panel.panel.comments.getSnapshot().threads;
  panel.panel.comments.editComment(thread!.id, 1, { author: "Lily Pad", body: "second" });
  assert.equal(await panel.save(), "one\n<!-- @chiri: first -->\n<!-- [Lily Pad]: second -->\n");
  panel.panel.comments.editComment(thread!.id, 0, { author: "chiri", body: "  " });
  assert.equal(await panel.save(), "one\n<!-- @chiri: first -->\n<!-- [Lily Pad]: second -->\n");
}));
