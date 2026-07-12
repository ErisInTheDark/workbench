/*
 * Exports:
 * - No production exports; Node tests cover shell command summary matching and argument semantics. Keywords: thread, command, matcher, powershell, ripgrep, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getThreadCommandDisplay } from "./thread-command-matchers.ts";

const PROJECT_ROOT = "C:/git/web/workbench";

test("PowerShell ripgrep summaries do not treat an uppercase context value as the query", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'rg -n -C 8 "rotate|selectedHarness|onHarness|HarnessIcon|harness" webapp/components/workbench.tsx | Select-Object -First 180'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg,powershell.select-object-limit");
  assert.equal(
    display.summaryText,
    'Search for "rotate|selectedHarness|onHarness|HarnessIcon|harness" in webapp/components/workbench.tsx -> Take first 180',
  );
});

test("PowerShell ripgrep summaries preserve lowercase count flags as non-consuming", () => {
  const display = getThreadCommandDisplay({
    command: "rg -n -c needle webapp/components/workbench.tsx",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg");
  assert.equal(display.summaryText, 'Search for "needle" in webapp/components/workbench.tsx');
});
