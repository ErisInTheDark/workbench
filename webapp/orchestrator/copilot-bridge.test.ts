/*
 * Exports:
 * - No production exports; regression test keeps selector filtering at the final joined Copilot system-message boundary. Keywords: copilot, instructions, filter.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("filters the final joined Copilot system message with bridge-owned selectors", async () => {
  const source = await readFile(path.join(__dirname, "copilot-bridge.ts"), "utf8");
  const joinIndex = source.indexOf("const content = joinSystemMessageSections");
  const filterIndex = source.indexOf("filterWorkbenchInstructionContent(content", joinIndex);
  assert.ok(joinIndex >= 0);
  assert.ok(filterIndex > joinIndex);
  assert.match(source.slice(filterIndex, filterIndex + 500), /harness: "copilot"/u);
  assert.match(source.slice(filterIndex, filterIndex + 500), /shell: process\.platform/u);
});
