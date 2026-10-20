/* No production exports. Wards for reading a sleep's duration from the command alone. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSleepCommandMs } from "./sleep-command";

test("PowerShell and POSIX sleeps read their duration", () => {
  for (const [command, ms] of [
    ["Start-Sleep -Seconds 120", 120_000],
    ["Start-Sleep -s 5", 5_000],
    ["Start-Sleep 3", 3_000],
    ["start-sleep -Milliseconds 250", 250],
    ["Start-Sleep 1.5", 1_500],
    ["sleep 10", 10_000],
    ["sleep 2m", 120_000],
    ["sleep 0.5s", 500],
  ] as const) {
    assert.equal(parseSleepCommandMs(command), ms, command);
  }
});

test("anything more than a lone sleep stays an ordinary command", () => {
  for (const command of ["sleep 5 && npm test", "Start-Sleep 2; Get-Process", "sleep", "sleep abc", "Start-Sleep -Seconds $wait", "sleeper 5"]) {
    assert.equal(parseSleepCommandMs(command), null, command);
  }
});
