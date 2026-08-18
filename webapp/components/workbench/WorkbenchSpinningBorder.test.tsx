/*
 * Exports:
 * - No production exports; Node tests protect shared motion-path ownership and PrimaryButton integration. Keywords: workbench, pending, border, motion path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import PrimaryButton from "./PrimaryButton";
import WorkbenchSpinningBorder from "./WorkbenchSpinningBorder";

test("spinning borders render two opposed motion-path elements", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchSpinningBorder, {
    radius: "50cqb",
  }));

  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.equal(html.match(/data-workbench-spinning-border-trail="true"/gu)?.length, 2);
  assert.match(html, /workbench-spinning-border-trail-first/u);
  assert.match(html, /workbench-spinning-border-trail-second/u);
  assert.match(html, /--workbench-spinning-border-radius:50cqb/u);
});

test("PrimaryButton uses the shared border for pending pills", () => {
  const html = renderToStaticMarkup(createElement(PrimaryButton, {
    children: "Committing...",
    pendingHalo: true,
  }));

  assert.match(html, />Committing\.\.\.</u);
  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.match(html, /inset-\[2px\]/u);
});
