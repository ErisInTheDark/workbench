/*
 * Exports:
 * - No production exports; Node tests cover shell command summary matching and argument semantics. Keywords: thread, command, matcher, powershell, ripgrep, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadCommandOutcomeDisplay,
  parseWorkbenchSubagentCommand,
} from "./thread-command-matchers.ts";

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
  assert.equal(
    display.ongoingSummaryText,
    'Searching for "rotate|selectedHarness|onHarness|HarnessIcon|harness" in webapp/components/workbench.tsx -> Taking first 180',
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
  assert.equal(display.ongoingSummaryText, 'Searching for "needle" in webapp/components/workbench.tsx');
});

test("Workbench subagent commands share one semantic parser", () => {
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent wait --id child-thread"), {
    action: "wait",
    message: null,
    threadIds: ["child-thread"],
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb.cmd subagent message --id "child thread" --message continue'), {
    action: "message",
    message: "continue",
    threadIds: ["child thread"],
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent stop --id='child-thread'"), {
    action: "stop",
    message: null,
    threadIds: ["child-thread"],
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent wait --id child-thread; Write-Output done"), {
    action: "wait",
    message: null,
    threadIds: ["child-thread"],
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb subagent message --message "Use the safer `route`" --id child-thread'), {
    action: "message",
    message: "Use the safer `route`",
    threadIds: ["child-thread"],
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent profiles"), {
    action: "profiles",
    message: null,
    threadIds: [],
  });
  assert.equal(parseWorkbenchSubagentCommand("wb thread recall --thread child-thread"), null);

  const display = getThreadCommandDisplay({
    command: "wb subagent wait --id child-thread",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(display.claimedBy, "workbench-cli.subagent");
  assert.equal(display.summaryText, "Waited for subagent");
  assert.equal(display.ongoingSummaryText, "Waiting for subagent");

  const multiplexedDisplay = getThreadCommandDisplay({
    command: "wb subagent wait --id child-thread --id other-child",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(multiplexedDisplay.claimedBy, "workbench-cli.subagent");
  assert.equal(multiplexedDisplay.summaryText, "Waited for 2 subagents");
  assert.equal(multiplexedDisplay.ongoingSummaryText, "Waiting for 2 subagents");
});

test("command execution outcomes select the explicit ongoing tense", () => {
  const display = getThreadCommandDisplay({
    command: "rg needle webapp",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(getThreadCommandExecutionOutcome("inProgress", null), "inProgress");
  assert.equal(getThreadCommandExecutionOutcome("failed", 124), "timedOut");
  assert.equal(getThreadCommandExecutionOutcome("completed", 124), "timedOut");
  assert.equal(getThreadCommandExecutionOutcome("failed", 1), "failed");
  assert.equal(getThreadCommandExecutionOutcome("declined", null), "declined");
  assert.equal(getThreadCommandExecutionOutcome("completed", 0), "completed");

  assert.equal(getThreadCommandOutcomeDisplay(display, "inProgress").summaryText, 'Searching for "needle" in webapp');
  assert.equal(getThreadCommandOutcomeDisplay(display, "timedOut").summaryText, 'Timed out searching for "needle" in webapp');
  assert.equal(getThreadCommandOutcomeDisplay(display, "failed").summaryText, 'Failed searching for "needle" in webapp');
  assert.equal(getThreadCommandOutcomeDisplay(display, "declined").summaryText, 'Declined searching for "needle" in webapp');
});

test("raw commands receive an explicit ongoing fallback", () => {
  const display = getThreadCommandDisplay({
    command: "mystery-command --flag",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.summaryText, "mystery-command --flag");
  assert.equal(display.ongoingSummaryText, "Running mystery-command --flag");
  assert.equal(getThreadCommandOutcomeDisplay(display, "timedOut").summaryText, "Timed out running mystery-command --flag");
});
