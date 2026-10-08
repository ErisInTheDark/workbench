/*
 * Exports:
 * - spawnDetached: start a fire-and-forget OS helper, resolving once it spawned and rejecting when it cannot start.
 * - openUrl: open a URL in the platform's default browser.
 */
import { spawn } from "node:child_process";

export async function spawnDetached(command: string, args: string[], detached = process.platform !== "win32") {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached, shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function openUrl(url: string, platform = process.platform) {
  // url.dll avoids cmd.exe `start` quoting, where `&` in a URL would split the command.
  if (platform === "win32") await spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url], false);
  else if (platform === "darwin") await spawnDetached("open", [url]);
  else await spawnDetached("xdg-open", [url]);
}
