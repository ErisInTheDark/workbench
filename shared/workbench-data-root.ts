/*
 * Exports:
 * - WorkbenchDataRootOptions: environment, home, and platform seams for user-data path resolution.
 * - default resolveWorkbenchDataRoot: resolve Workbench's per-user OS data directory.
 */
import os from "node:os";
import path from "node:path";

export interface WorkbenchDataRootOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export default function resolveWorkbenchDataRoot(options: WorkbenchDataRootOptions = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = environment.WORKBENCH_DATA_ROOT?.trim();
  if (override) return paths.resolve(override);

  const homeDirectory = options.homeDirectory ?? os.homedir();
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim()
      || paths.join(homeDirectory, "AppData", "Local");
    return paths.resolve(localAppData, "inthedark", "wb");
  }
  if (platform === "darwin") {
    return paths.resolve(homeDirectory, "Library", "Application Support", "inthedark", "wb");
  }
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  const dataHome = xdgDataHome && paths.isAbsolute(xdgDataHome)
    ? xdgDataHome
    : paths.join(homeDirectory, ".local", "share");
  return paths.resolve(dataHome, "inthedark", "wb");
}
