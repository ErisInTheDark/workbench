/*
 * No production exports. Tests protect a shell step reading as one plain command line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getThreadCommandDisplay } from "../../../workbench/thread/thread-command-matchers";
import ThreadCommandDisplay from "./ThreadCommandDisplay";

test("an unmatched shell command is its own text, without a shell label or code chip", () => {
  const command = "wb debug socket --process app";
  const display = getThreadCommandDisplay({ command, commandActions: [], cwd: "C:/repo", shell: "pwsh" });
  const html = renderToStaticMarkup(createElement(ThreadCommandDisplay, { command, display, output: "" }));
  assert.doesNotMatch(html, /pwsh:/u);
  assert.doesNotMatch(html, /<code/u);
  assert.match(html, /wb debug socket --process app/u);
});
