/* No production exports. Protect native kit component composition from serialized template nodes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderThreadComponentNode } from "./thread-component-render";

test("serialized kit options render their initial selected content", () => {
  const html = renderToStaticMarkup(renderThreadComponentNode({
    $workbench: "element", type: "kit:Options",
    props: {
      label: "choices",
      children: [
        { $workbench: "element", type: "kit:Option", props: { title: "first", children: "first content" } },
        { $workbench: "element", type: "kit:Option", props: { title: "second", children: "second content" } },
      ],
    },
  }));
  assert.match(html, /first content/u);
  assert.doesNotMatch(html, /second content/u);
});
