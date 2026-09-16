/*
 * Exports:
 * - No production exports; tests preserve managed task title commands.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildThreadTitleBootstrapInstructions } from "./thread-bootstrap.ts";

test("managed task title instructions expose set and get commands", () => {
  const value = buildThreadTitleBootstrapInstructions();
  assert.match(value, /wb task set --title "<short title>" \[--current-title "<exact current title>"\]/u);
  assert.match(value, /wb task get/u);
  assert.doesNotMatch(value, /wb thread title/u);
});
