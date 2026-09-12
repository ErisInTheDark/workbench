/*
 * Exports:
 * - No production exports; tests preserve agent/mode/file-link bootstrap while excluding hidden title commands.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexThreadBootstrapInstructions, buildThreadTitleBootstrapInstructions } from "./thread-bootstrap.ts";

test("Codex bootstrap preserves shared instructions without injecting task-title behavior", () => {
  const value = buildCodexThreadBootstrapInstructions({
    harness: "codex",
    routeUrl: "http://localhost/thread/one",
    threadId: "one",
    workbenchLibraryInstructions: "library instructions",
  });
  assert.match(value ?? "", /library instructions/u);
  assert.match(value ?? "", /set-state/u);
  assert.doesNotMatch(value ?? "", /wb task set/u);
});

test("managed task title instructions expose set and get commands", () => {
  const value = buildThreadTitleBootstrapInstructions();
  assert.match(value, /wb task set --title "<short title>" \[--current-title "<exact current title>"\]/u);
  assert.match(value, /wb task get/u);
  assert.doesNotMatch(value, /wb thread title/u);
});
