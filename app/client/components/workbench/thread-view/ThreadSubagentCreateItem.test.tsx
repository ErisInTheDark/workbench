/*
 * Exports:
 * - No production exports; tests protect standalone disclosure defaults and unwrapped coordination content.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadSubagentCreateItem from "./ThreadSubagentCreateItem";

function renderCreate(active: boolean, unwrapped = false) {
  return renderToStaticMarkup(createElement(ThreadSubagentCreateItem, {
    active,
    children: "Create instructions",
    fallbackName: "Lily",
    fallbackTitle: "Inspect disclosures",
    profileId: "profile",
    unwrapped,
  }));
}

test("active subagent creation starts open and completed creation starts closed", () => {
  assert.match(renderCreate(true), /<details[^>]*\bopen=/u);
  assert.doesNotMatch(renderCreate(false), /<details[^>]*\bopen=/u);
});

test("unwrapped subagent creation exposes its prompt without a nested disclosure", () => {
  const html = renderCreate(false, true);
  assert.doesNotMatch(html, /<details/u);
  assert.match(html, /Create instructions/u);
});
