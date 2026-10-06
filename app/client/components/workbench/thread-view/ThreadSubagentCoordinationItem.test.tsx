/*
 * No exports. Tests protect the single coordination disclosure's lifecycle wording and flat bubble body.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import ThreadSubagentCoordinationItem from "./ThreadSubagentCoordinationItem";

const participants = [
  { key: "iris", label: "Iris" },
  { key: "rose", label: "Rose" },
];

test("settled coordination renders one disclosure with a frozen duration and flat bubbles", () => {
  const html = renderToStaticMarkup(createElement(
    ThreadSubagentCoordinationItem,
    { durationMs: 80_000, participants },
    createElement("div", { "data-conversation-bubble": true }, "hello"),
  ));

  assert.match(html, /Coordinated with/u);
  assert.match(html, /Iris/u);
  assert.match(html, /Rose/u);
  assert.match(html, /1m/u);
  assert.equal((html.match(/<details/gu) ?? []).length, 1);
  assert.match(html, /data-conversation-bubble="true"/u);
});

test("active coordination uses live wording without adding an inner wait disclosure", () => {
  const html = renderToStaticMarkup(createElement(
    ThreadSubagentCoordinationItem,
    { active: true, durationMs: 80_000, participants },
    createElement("div", { "data-conversation-bubble": true }, "hello"),
  ));

  assert.match(html, /Coordinating with/u);
  assert.doesNotMatch(html, /Coordinated with/u);
  assert.doesNotMatch(html, /Wait(?:ed|ing) for/u);
  assert.equal((html.match(/<details/gu) ?? []).length, 1);
});
