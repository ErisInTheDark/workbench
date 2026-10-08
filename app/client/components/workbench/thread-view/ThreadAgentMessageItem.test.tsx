/*
 * No exports. Tests protect recipient attribution in flat outgoing bubbles without changing standalone disclosure nesting.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import ThreadAgentMessageItem, {
  ThreadAgentMessageBubble,
  ThreadAgentMessageClaimRelease,
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

test("a claim release attachment previews three file links behind one ellipsis toggle", () => {
  const html = renderToStaticMarkup(createElement(
    ThreadAgentMessageClaimRelease,
    { paths: ["src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts"], projectId: "project" },
  ));

  assert.match(html, /src\/one\.ts/u);
  assert.match(html, /src\/two\.ts/u);
  assert.match(html, /src\/three\.ts/u);
  assert.doesNotMatch(html, /src\/four\.ts/u);
  assert.match(html, /aria-label="Show all released files"/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.equal((html.match(/aria-label="Show all released files"/gu) ?? []).length, 1);
});
