/* No production exports. Protect safe, serializable native component output. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readThreadComponentStyle, readThreadComponentTree } from "./thread-component-tree";

test("component trees preserve data and reject executable element props", () => {
  const tree = { $workbench: "element", type: "div", props: { children: [{ $workbench: "element", type: "kit:Option", props: { title: "one" } }] } };
  assert.deepEqual(readThreadComponentTree(tree), tree);
  assert.throws(() => readThreadComponentTree({ $workbench: "element", type: "div", props: { onClick: "alert(1)" } }));
  assert.throws(() => readThreadComponentTree({ $workbench: "element", type: "script", props: {} }));
});

test("ordinary prop objects with type and props remain data", () => {
  const data = { type: "record", props: { label: "ordinary data" } };
  const tree = { $workbench: "element", type: "kit:Table", props: { rows: [[data]] } };
  assert.deepEqual(readThreadComponentTree(tree), tree);
});

test("ordinary form controls can appear as native template markup", () => {
  const tree = { $workbench: "element", type: "label", props: {
    children: [{ $workbench: "element", type: "input", props: { defaultValue: "hello" } }],
  } };
  assert.deepEqual(readThreadComponentTree(tree), tree);
});

test("component links can only leave Workbench, never navigate its tab", () => {
  const link = (href: string, props: Record<string, unknown> = {}) => ({ $workbench: "element", type: "a", props: { href, children: "x", ...props } });
  for (const href of ["https://trello.com/c/abc", "http://example.com", "mailto:someone@example.com"]) {
    assert.doesNotThrow(() => readThreadComponentTree(link(href)), href);
  }
  for (const href of ["#section", "/thread/workbench/abc", "../x", "./x", "thread", "javascript:alert(1)", " java\tscript:x"]) {
    assert.throws(() => readThreadComponentTree(link(href)), href);
  }
  assert.throws(() => readThreadComponentTree(link("https://example.com", { target: "_self" })));
  assert.throws(() => readThreadComponentTree({ $workbench: "element", type: "kit:Callout", props: { href: "https://example.com" } }));
});

test("component output cannot automatically fetch remote data", () => {
  const image = { $workbench: "element", type: "img", props: { src: "https://example.com/private" } };
  const style = { $workbench: "element", type: "div", props: { style: { backgroundImage: "u\\72l(https://example.com/private)" } } };
  const swatch = { $workbench: "element", type: "kit:Swatch", props: { color: "url(https://example.com/private)" } };
  const text = { $workbench: "element", type: "p", props: { children: "See https://example.com" } };
  assert.throws(() => readThreadComponentTree(image));
  assert.throws(() => readThreadComponentTree(style));
  assert.throws(() => readThreadComponentTree(swatch));
  assert.deepEqual(readThreadComponentTree(text), text);
  assert.throws(() => readThreadComponentStyle({
    path: "skill", revision: "a".repeat(64), css: '@import url("https://example.com/a; b");',
  }));
});
