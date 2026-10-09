/*
 * No production exports. Protect Windows scheduled-task XML and registration boundaries.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory.ts";
import WindowsServiceStartup from "./WindowsServiceStartup.ts";

const execFileAsync = promisify(execFile);

test("Windows host registration emits valid XML", {
  skip: process.platform !== "win32" && "Windows XML parsing requires PowerShell",
}, async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-windows-startup-");
  context.after(() => temporary.dispose());
  const root = path.join(temporary.path, "root");
  const dataRoot = path.join(temporary.path, "data");
  const executable = path.join(root, "daemon", "host", "bin", `windows-${process.arch}`, "workbench-daemon-host.exe");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture");
  let taskPath: string | null = null;
  const startup = new WindowsServiceStartup({
    root, dataRoot, home: temporary.path, nodePath: process.execPath,
    stage: { stage: async () => executable },
    run: async (_command, args) => {
      const xml = args.indexOf("/XML");
      taskPath = args[xml + 1] ?? null;
      return "";
    },
  });

  await startup.configure(false);

  assert.ok(taskPath);
  await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "& { param([string]$path) $ErrorActionPreference = 'Stop'; $document = [xml]::new(); $document.Load($path) }",
    taskPath,
  ]);
});
