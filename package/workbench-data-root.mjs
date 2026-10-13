/*
 * Exports:
 * - default resolveWorkbenchDataRoot: resolve per-user OS data storage without installed dependencies.
 */
import os from "node:os";
import path from "node:path";

export default function resolveWorkbenchDataRoot({
  environment = process.env, homeDirectory = os.homedir(), platform = process.platform,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = environment.WORKBENCH_DATA_ROOT?.trim();
  if (override) return paths.resolve(override);
  if (platform === "win32") {
    return paths.resolve(environment.LOCALAPPDATA?.trim() || paths.join(homeDirectory, "AppData", "Local"), "inthedark", "wb");
  }
  if (platform === "darwin") return paths.resolve(homeDirectory, "Library", "Application Support", "inthedark", "wb");
  const xdg = environment.XDG_DATA_HOME?.trim();
  return paths.resolve(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(homeDirectory, ".local", "share"), "inthedark", "wb");
}
