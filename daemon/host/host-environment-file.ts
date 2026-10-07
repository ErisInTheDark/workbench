/*
 * Exports:
 * - hostEnvironmentFilePath: per-installation file the Linux host unit reads through `EnvironmentFile=`.
 * - default recordHostEnvironment: persist a terminal session's PATH for the Linux host.
 */
import fs from "node:fs/promises";
import path from "node:path";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";

export function hostEnvironmentFilePath(dataRoot = resolveWorkbenchDataRoot()) {
  return path.join(dataRoot, "service", "host-environment");
}

/**
 * systemd starts user units with a minimal PATH, so tools the user installed through their shell profile are
 * missing. Only terminal entry points record PATH; desktop launches keep the last terminal value.
 */
export default async function recordHostEnvironment({
  dataRoot, environment = process.env, platform = process.platform,
}: { dataRoot?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  if (platform !== "linux") return;
  const value = environment.PATH;
  if (!value) return;
  // Single quotes are literal in systemd environment files: no escapes, specifiers or `$` expansion.
  if (/['\r\n\u0000]/u.test(value)) throw new Error("PATH contains characters a systemd environment file cannot hold literally.");
  const file = hostEnvironmentFilePath(dataRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `PATH='${value}'\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}
