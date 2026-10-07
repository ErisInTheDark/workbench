/*
 * No exports. Checkout desktop entry routes human start and shortcut commands to the native launcher adapter.
 */
import path from "node:path";

import recordHostEnvironment from "../../daemon/host/host-environment-file.ts";
import WorkbenchDesktopLauncher from "./WorkbenchDesktopLauncher.ts";

async function main() {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Managed agent threads cannot run the Workbench desktop launcher.");
  }
  const command = process.argv[2];
  if (command === "start") {
    // Terminal launches carry the user's shell PATH; the desktop shortcut bypasses this entry.
    try { await recordHostEnvironment(); }
    catch (error) {
      process.stderr.write(`Workbench host PATH was not recorded: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const launcher = new WorkbenchDesktopLauncher({
    repositoryRootPath: path.resolve(import.meta.dirname, "../.."),
  });
  if (command === "start") {
    await launcher.start();
    return;
  }
  if (command === "shortcut") {
    await launcher.installShortcut();
    return;
  }
  throw new Error("Usage: wb [shortcut]");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
