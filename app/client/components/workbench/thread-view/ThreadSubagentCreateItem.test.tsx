/*
 * Exports:
 * - No production exports; tests protect active subagent creation disclosure defaults.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadSubagentCreateItem from "./ThreadSubagentCreateItem";

function renderCreate(active: boolean) {
  return renderToStaticMarkup(createElement(ThreadSubagentCreateItem, {
    active,
    children: "Create instructions",
    fallbackName: "Lily",
    fallbackTitle: "Inspect disclosures",
    profileId: "profile",
  }));
}

test("active subagent creation starts open and completed creation starts closed", () => {
  assert.match(renderCreate(true), /<details[^>]*\bopen=/u);
  assert.doesNotMatch(renderCreate(false), /<details[^>]*\bopen=/u);
});
