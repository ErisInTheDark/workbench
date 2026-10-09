/* No exports. Tests protect the coordination disclosure's flat bubble body. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import ThreadSubagentCoordinationItem from "./ThreadSubagentCoordinationItem";

test("coordination renders one disclosure around its flat bubble body", () => {
  const html = renderToStaticMarkup(createElement(
    ThreadSubagentCoordinationItem,
    { participants: [] },
    createElement("div", { "data-conversation-bubble": true }, "hello"),
  ));

  assert.equal((html.match(/<details/gu) ?? []).length, 1);
});
