/*
 * No production exports. Tests the managed PowerShell path and actionable missing-runtime failure.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory";
import {
  requireWorkbenchPowerShellExecutable,
  workbenchPowerShellExecutable,
} from "./windows-powershell-runtime";

test("the daemon requires the pinned absolute runtime and directs missing installs to repair", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-daemon-powershell-");
  context.after(() => temporary.dispose());
  const executable = workbenchPowerShellExecutable(temporary.path);
  assert.equal(path.isAbsolute(executable), true);
  await assert.rejects(requireWorkbenchPowerShellExecutable(temporary.path), /wb repair.*relaunch Workbench/u);
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture");
  assert.equal(await requireWorkbenchPowerShellExecutable(temporary.path), executable);
});
