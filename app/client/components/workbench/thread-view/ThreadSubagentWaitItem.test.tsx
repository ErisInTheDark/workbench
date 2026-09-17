/*
 * Exports:
 * - No production exports; tests protect active subagent wait disclosure defaults.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadSubagentWaitItem from "./ThreadSubagentWaitItem";

function renderWait(outcome: "completed" | "inProgress") {
  return renderToStaticMarkup(createElement(ThreadSubagentWaitItem, {
    disclosureContent: "Wait details",
    entries: [{ fallbackName: "Lily", targetKey: "lily" }],
    outcome,
  }));
}

test("active subagent waits start open and completed waits start closed", () => {
  assert.match(renderWait("inProgress"), /<details[^>]*\bopen=/u);
  assert.doesNotMatch(renderWait("completed"), /<details[^>]*\bopen=/u);
});
