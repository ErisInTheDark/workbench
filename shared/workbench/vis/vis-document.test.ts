/* No production exports. Protect vis CSS marker detection and where compiled CSS lands in the rendered document. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderVisDocument, visWantsCss } from "./vis-document";

test("the CSS marker is found in any attribute order and repeated calls agree", () => {
  const source = `<html><head><link href="x" rel='workbench-css' /></head></html>`;
  assert.equal(visWantsCss(source), true);
  assert.equal(visWantsCss(source), true);
  assert.equal(visWantsCss(`<link rel="stylesheet" href="a.css">`), false);
});

test("compiled CSS replaces the marker at the very start of head, ahead of the document's own styles", () => {
  const rendered = renderVisDocument(`<html><head><style>p{color:red}</style><link rel="workbench-css"></head><body></body></html>`, "html", ".a{b:c}");
  assert.equal(rendered, `<html><head><style>.a{b:c}</style><style>p{color:red}</style></head><body></body></html>`);
});

test("documents without a head gain one, and CSS cannot close its style element early", () => {
  assert.equal(renderVisDocument(`<html><body>x</body></html>`, "html", "a{}"), `<html><head><style>a{}</style></head><body>x</body></html>`);
  assert.equal(renderVisDocument(`<p>x</p>`, "html", `a{content:"</style>"}`), `<head><style>a{content:"<\\/style>"}</style></head><p>x</p>`);
});

test("without CSS the marker is still removed and nothing else changes", () => {
  assert.equal(renderVisDocument(`<head><link rel="workbench-css"></head>`, "html", null), `<head></head>`);
});

test("svg is wrapped in a page with the CSS first", () => {
  const rendered = renderVisDocument(`<svg viewBox="0 0 1 1"></svg>`, "svg", ".x{}");
  assert.ok(rendered.startsWith("<!doctype html><html><head><style>.x{}</style>"));
  assert.ok(rendered.includes(`<body><svg viewBox="0 0 1 1"></svg></body>`));
});
