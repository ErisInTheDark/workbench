/*
 * No production exports. Rendered regression checks protect folder address emphasis.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkbenchProjectLocationLabel from "./WorkbenchProjectLocationLabel";

test("location labels separate optional host and worktree name", () => {
  const plain = renderToStaticMarkup(createElement(WorkbenchProjectLocationLabel, {
    displayPath: "workbench", hostname: "tower-of-floof",
  }));
  const qualified = renderToStaticMarkup(createElement(WorkbenchProjectLocationLabel, {
    displayPath: "tower-of-floof:/+convex-lab", hostname: "tower-of-floof",
  }));
  assert.match(plain, />workbench</u);
  assert.doesNotMatch(plain, /tower-of-floof/u);
  assert.match(qualified, />tower-of-floof:\/</u);
  assert.match(qualified, /<strong[^>]*>\+convex-lab<\/strong>/u);
});
