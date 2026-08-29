/*
 * No production exports. Node tests protect committed-artifact launch, shortcut installation, and Windows scope.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import WorkbenchDesktopLauncher from "./WorkbenchDesktopLauncher.ts";

function fixture(options: { launcherExists?: boolean; platform?: NodeJS.Platform } = {}) {
  const calls: Array<{ args: string[]; command: string; detached?: boolean }> = [];
  const root = path.resolve("C:/workbench");
  const launcher = new WorkbenchDesktopLauncher({
    launchDetached: async (command, args, commandOptions) => {
      calls.push({ args, command, detached: commandOptions.detached });
    },
    pathExists: async () => options.launcherExists ?? true,
    platform: options.platform ?? "win32",
    repositoryRootPath: root,
    runCommand: async (command, args) => {
      calls.push({ args, command });
    },
  });
  return { calls, launcher, root };
}

test("launches the existing native owner detached without rebuilding it", async () => {
  const target = fixture();
  await target.launcher.start();
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0]?.detached, true);
  assert.match(target.calls[0]?.command ?? "", /tray[\\/]bin[\\/]windows-x64[\\/]workbench-tray\.exe$/u);
  assert.deepEqual(target.calls[0]?.args, ["--workbench-root", target.root]);
});

test("shortcut installation invokes only the Windows adapter", async () => {
  const target = fixture();
  await target.launcher.installShortcut();
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0]?.command, "powershell.exe");
  assert.equal(target.calls.some((call) => call.detached), false);
});

test("reports a missing committed launcher without trying to build it", async () => {
  const target = fixture({ launcherExists: false });
  await assert.rejects(target.launcher.start(), /Restore the committed artifact or run pnpm build:tray/u);
  assert.deepEqual(target.calls, []);
});

test("rejects shortcut ownership on unsupported desktop platforms", async () => {
  const target = fixture({ platform: "linux" });
  await assert.rejects(target.launcher.installShortcut(), /Windows only/u);
  assert.deepEqual(target.calls, []);
});
