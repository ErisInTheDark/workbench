/*
 * Exports:
 * - No production exports; Node tests cover exact and provider-shaped thread harness candidate ordering. Keywords: thread, harness, routing, candidates, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getWorkbenchThreadHarnessCandidates } from "./thread-harness-candidates.ts";

test("uses exact local thread harness knowledge without probing other providers", () => {
  assert.deepEqual(getWorkbenchThreadHarnessCandidates("shared-shape", "copilot"), ["copilot"]);
});

test("prefers provider-shaped thread ids while retaining ordered legacy fallbacks", () => {
  assert.deepEqual(getWorkbenchThreadHarnessCandidates("ses_opencode"), ["opencode", "codex", "copilot"]);
  assert.deepEqual(getWorkbenchThreadHarnessCandidates("019f-codex"), ["codex", "copilot", "opencode"]);
});
