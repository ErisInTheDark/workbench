/* No production exports. Protect JSX invocation boundaries and attribute reading around quoted values and expressions. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listThreadComponentResultNames, mapThreadComponentSources, readThreadComponentAttributes, readThreadComponentMarkup,
  resolveThreadComponentSource,
} from "./thread-component-markup";

test("attributes keep expressions whole across nested braces and quoted delimiters", () => {
  assert.deepEqual(readThreadComponentAttributes(`<Board cards={[{ a: "}" }, { b: '{' }]} title="x &amp; y" open data-id='7' />`), [
    { name: "cards", kind: "expression", source: `[{ a: "}" }, { b: '{' }]` },
    { name: "title", kind: "text", value: "x & y" },
    { name: "open", kind: "flag" },
    { name: "data-id", kind: "text", value: "7" },
  ]);
  assert.deepEqual(readThreadComponentAttributes("<Card>"), []);
});

test("attributes refuse spreads and unterminated values", () => {
  assert.throws(() => readThreadComponentAttributes("<Card {...props} />"), /spread/u);
  assert.throws(() => readThreadComponentAttributes("<Card a=b />"), /Invalid component attribute value/u);
  assert.throws(() => readThreadComponentAttributes("<Card a={} />"), /Empty/u);
});

test("result references are found in nested invocations once each", () => {
  assert.deepEqual(listThreadComponentResultNames(`<A x="@result:one">\n<B y={'@result:two'} z="@result:one" />\n</A>`), ["one", "two"]);
});

test("component invocation consumes the complete tag, not delimiters in props", () => {
  const markup = '<TrelloCard labels={[1, 3]} content="a /> b" />';
  const parsed = readThreadComponentMarkup(`${markup} afterwards`);
  assert.equal(parsed?.name, "TrelloCard");
  assert.equal(parsed?.source, markup);
  assert.equal(parsed?.end, markup.length);
  assert.equal(readThreadComponentMarkup('<TrelloCard labels={[1, 3]}'), null);
});

test("component bodies keep markdown and fenced examples inside their closing tag", () => {
  const markup = "<FirstComponent>\n<SecondComponent />\n\n**markdown** and 1 < 2\n\n```md\n</FirstComponent>\n```\n</FirstComponent>";
  assert.equal(readThreadComponentMarkup(`${markup}\nafter`)?.source, markup);
});

test("merged message components retain the identity of their original message", () => {
  const markup = "<Card />";
  const sources = [
    { itemId: "first", sourceText: markup, start: 0, end: markup.length },
    { itemId: "second", sourceText: markup, start: markup.length + 2, end: markup.length * 2 + 2 },
  ];
  assert.equal(resolveThreadComponentSource(sources, 0, markup.length)?.itemId, "first");
  assert.equal(resolveThreadComponentSource(sources, markup.length + 2, markup.length * 2 + 2)?.itemId, "second");
  assert.equal(resolveThreadComponentSource(sources, markup.length - 1, markup.length + 3), null);
});

test("repeated text in merged messages maps to each original item in order", () => {
  const markup = "<Card />";
  const sources = mapThreadComponentSources(`${markup}\n\n${markup}`, [
    { itemId: "first", sourceText: markup }, { itemId: "second", sourceText: markup },
  ]);
  assert.equal(resolveThreadComponentSource(sources, 0, markup.length)?.itemId, "first");
  assert.equal(resolveThreadComponentSource(sources, markup.length + 2, markup.length * 2 + 2)?.itemId, "second");
});
