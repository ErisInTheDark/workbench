/*
 * No exports. Link wards for the mounted rich editor: Ctrl+K links the selection, the caret's word or new text and edits
 * or removes the caret's whole link; typing `[text](url)` becomes a link; text typed at a link's edge stays outside it;
 * every result saves through the save guard.
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

async function link(panel: MountedFilePanel, href: string, text?: string) {
  await panel.press("k", { ctrl: true });
  assert.ok(panel.panel.links.getSnapshot().draft, "Ctrl+K opens the link draft");
  return panel.panel.links.submitDraft(href, text);
}

test("Ctrl+K links the selection and leaves the caret after it", () => withPanel("read the docs today\n", async panel => {
  await panel.select("read the [docs] today");
  assert.equal(await link(panel, "docs/basic.md"), true);
  assert.equal(await panel.save(), "read the [docs](docs/basic.md) today\n");
  assert.equal(panel.caretText, "read the docs| today");
}));

test("a link holding formatting stays one link when its paragraph is edited", () => withPanel("see [the **rule** list](a.md) now\n", async panel => {
  await panel.caret("now|");
  await panel.type("!");
  assert.equal(await panel.save(), "see [the **rule** list](a.md) now!\n");
}));

test("Ctrl+K in a link edits all of it, and an empty address removes it", () => withPanel("see [the **rule** list](a.md) now\n", async panel => {
  await panel.caret("the ru|le list");
  await panel.press("k", { ctrl: true });
  const draft = panel.panel.links.getSnapshot().draft;
  assert.equal(draft?.editing, true);
  assert.equal(draft?.href, "a.md", "the draft starts from the link's address");
  panel.panel.links.submitDraft("rules/README.md");
  assert.equal(await panel.save(), "see [the **rule** list](rules/README.md) now\n");

  await panel.caret("the |rule list");
  await link(panel, "");
  assert.equal(await panel.save(), "see the **rule** list now\n");
}));

test("Ctrl+K on a word links the word", () => withPanel("hello world\n", async panel => {
  await panel.caret("wor|ld");
  await link(panel, "https://example.com");
  assert.equal(await panel.save(), "hello [world](https://example.com)\n");
}));

test("Ctrl+K away from any word asks for text and inserts it linked", () => withPanel("see\n", async panel => {
  await panel.caret("see|");
  await panel.type(" ");
  await panel.press("k", { ctrl: true });
  assert.equal(panel.panel.links.getSnapshot().draft?.needsText, true);
  panel.panel.links.submitDraft("www.fox.dev", "fox");
  await panel.type("!");
  assert.equal(await panel.save(), "see [fox](https://www.fox.dev)!\n");
}));

test("an address that would run a script keeps the draft open and changes nothing", () => withPanel("click me\n", async panel => {
  await panel.select("click [me]");
  assert.equal(await link(panel, "javascript:alert(1)"), false);
  assert.ok(panel.panel.links.getSnapshot().draft);
  panel.panel.links.cancelDraft();
  assert.equal(panel.panel.links.getSnapshot().draft, null);
  assert.equal(panel.disk.writes.length, 0);
  assert.equal(window.getSelection()?.toString(), "me", "cancelling gives the selection back");
}));

test("an address markdown would cut short is stored so it reads back whole", () => withPanel("fox\n", async panel => {
  await panel.select("[fox]");
  await link(panel, "https://en.wikipedia.org/wiki/Fox_(disambiguation)");
  assert.equal(await panel.save(), "[fox](https://en.wikipedia.org/wiki/Fox_%28disambiguation%29)\n");
}));

test("typing a markdown link turns it into a link, and typing on stays outside it", () => withPanel("start\n", async panel => {
  await panel.caret("start|");
  await panel.type(" [docs](docs/basic.md)");
  assert.equal(panel.editor.querySelector("a")?.textContent, "docs");
  await panel.type(" next");
  assert.equal(await panel.save(), "start [docs](docs/basic.md) next\n");
}));

test("typed images and unsafe addresses stay text", () => withPanel("x\n", async panel => {
  await panel.caret("x|");
  await panel.type(" ![a](b.png) [c](javascript:void)");
  assert.equal(panel.editor.querySelector("a"), null);
}));

test("text typed at either edge of a link stays outside it, and inside it joins it", () => withPanel("[link](u.md)\n", async panel => {
  await panel.caret("link|");
  await panel.type("s");
  await panel.caret("|link");
  await panel.type("a");
  await panel.caret("li|nk");
  await panel.type("-");
  assert.equal(await panel.save(), "a[li-nk](u.md)s\n");
}));

test("linking in suggest mode suggests the change", () => withPanel("alpha beta\n", async panel => {
  panel.panel.setReviewMode("suggest");
  await panel.select("alpha [beta]");
  await link(panel, "b.md");
  assert.equal(await panel.save(), "<del>\n\nalpha beta\n\n</del>\n<ins>\n\nalpha [beta](b.md)\n\n</ins>\n");
}));

test("clicking a link places the caret instead of following it, and Ctrl+click opens it", () => withPanel("see [docs](docs/a.md)\n", async panel => {
  const opened: string[] = [];
  panel.panel.links.setOpenHandler((href) => opened.push(href));
  const anchor = panel.editor.querySelector("a")!;
  const click = (ctrlKey: boolean) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey });
    anchor.firstChild!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(click(false), true, "the app's link navigation sees a handled click");
  assert.deepEqual(opened, []);
  assert.equal(click(true), true);
  assert.deepEqual(opened, ["docs/a.md"]);
}));

test("Ctrl+K in source mode writes the link as markdown text", () => withPanel("see docs\n", async panel => {
  await panel.toolbar("source");
  await panel.selectSource("see [docs]");
  await panel.pressSource("k", { ctrl: true });
  assert.equal(panel.sourceCaretText, "see [docs](|)\n");
}));
