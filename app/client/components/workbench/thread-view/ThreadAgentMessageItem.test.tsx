/*
 * No exports. Tests protect recipient attribution in flat outgoing bubbles without changing standalone disclosure nesting.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import ThreadAgentMessageItem, {
  ThreadAgentMessageBubble,
  ThreadAgentMessageTarget,
} from "./ThreadAgentMessageItem";

const recipient = createElement(ThreadAgentMessageTarget, { fallbackName: "Iris" });

test("a flat outgoing bubble names its recipient without adding a disclosure", () => {
  const html = renderToStaticMarkup(createElement(
    ThreadAgentMessageBubble,
    { children: "message body", recipient },
  ));

  assert.match(html, /Messaged/u);
  assert.match(html, /Iris/u);
  assert.equal((html.match(/<details/gu) ?? []).length, 0);
});

test("the standalone outgoing item keeps one disclosure and no duplicate bubble header", () => {
  const html = renderToStaticMarkup(createElement(
    ThreadAgentMessageItem,
    { children: "message body", fallbackName: "Iris" },
  ));

  assert.equal((html.match(/<details/gu) ?? []).length, 1);
  assert.equal((html.match(/Messaged/gu) ?? []).length, 1);
});
