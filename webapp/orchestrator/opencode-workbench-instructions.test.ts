/*
 * Exports:
 * - No production exports; Node tests cover OpenCode thread identity injection for wb commands. Keywords: opencode, thread, identity, environment, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOpenCodeSystemReplacementPluginSource } from "./opencode-workbench-instructions";

test("injects the active OpenCode session as the managed Workbench thread id", () => {
  const source = buildOpenCodeSystemReplacementPluginSource();
  assert.match(source, /"shell\.env"/u);
  assert.match(source, /output\.env\.WORKBENCH_THREAD_ID = input\.sessionID/u);
});
