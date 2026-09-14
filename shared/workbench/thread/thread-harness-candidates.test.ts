/*
 * Exports:
 * - No production exports; tests protect exact identity and installed-only discovery.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getWorkbenchThreadHarnessCandidates } from "./thread-harness-candidates.ts";

test("uses exact local thread harness knowledge without probing other providers", () => {
  assert.deepEqual(getWorkbenchThreadHarnessCandidates("shared-shape", "copilot"), ["copilot"]);
});

test("native-looking ids cannot select an uninstalled implementation", () => {
  assert.deepEqual(getWorkbenchThreadHarnessCandidates("ses_opencode"), ["codex"]);
  assert.deepEqual(getWorkbenchThreadHarnessCandidates("019f-codex"), ["codex"]);
});
