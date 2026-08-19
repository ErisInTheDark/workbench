/*
 * Exports:
 * - No production exports; tests preserve agent/mode/file-link bootstrap while excluding hidden title commands. Keywords: bootstrap, title, instructions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexThreadBootstrapInstructions, buildThreadTitleBootstrapInstructions } from "./thread-bootstrap.ts";

test("Codex bootstrap preserves shared instructions without injecting thread-title behavior", () => {
  const value = buildCodexThreadBootstrapInstructions({
    harness: "codex",
    routeUrl: "http://localhost/thread/one",
    threadId: "one",
    workbenchLibraryInstructions: "library instructions",
  });
  assert.match(value ?? "", /library instructions/u);
  assert.match(value ?? "", /set-state/u);
  assert.doesNotMatch(value ?? "", /wb thread title/u);
});

test("managed thread title instructions expose set and get commands", () => {
  const value = buildThreadTitleBootstrapInstructions({ harness: "codex", threadId: "one" });
  assert.match(value, /wb thread title --title "<short title>"/u);
  assert.match(value, /wb thread title get/u);
});
