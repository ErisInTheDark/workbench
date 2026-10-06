/*
 * No exports. Tests protect Markdown paragraph structure across merged simple cross-agent messages.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import ThreadAgentMessageBody from "./ThreadAgentMessageBody";

test("merged simple versions retain each message and its Markdown paragraphs", () => {
  const html = renderToStaticMarkup(createElement(ThreadAgentMessageBody, {
    parts: [
      { markdown: "full one", userVisibleSimpleVersion: "first paragraph\n\nsecond paragraph" },
      { markdown: "full two", userVisibleSimpleVersion: "third **paragraph**" },
    ],
  }));

  assert.equal((html.match(/<p(?: |>)/gu) ?? []).length, 3);
  assert.match(html, /first paragraph/u);
  assert.match(html, /second paragraph/u);
  assert.match(html, /third <strong>paragraph<\/strong>/u);
});
