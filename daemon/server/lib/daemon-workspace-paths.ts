/*
 * Exports:
 * - DAEMON_PROJECT_ID: fixed project id of the daemon's own catalogue entry.
 * - daemonWorkspaceRoot: hidden Workbench-owned folder the daemon project uses as its root and agent cwd.
 * - isDaemonWorkspacePath: whether a path is the daemon workspace or inside it.
 * - ensureDaemonWorkspace: create the daemon workspace folder.
 */
import fs from "node:fs/promises";
import path from "node:path";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

export const DAEMON_PROJECT_ID = "daemon";

// Providers and Workbench tools all require a cwd; daemon threads get a private scratch folder instead of a repo.
export const daemonWorkspaceRoot = path.join(resolveWorkbenchDataRoot(), "daemon", "workspace");

function comparable(filePath: string) {
  const resolved = path.resolve(filePath).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isDaemonWorkspacePath(filePath: string) {
  const candidate = comparable(filePath);
  const root = comparable(daemonWorkspaceRoot);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function ensureDaemonWorkspace() {
  await fs.mkdir(daemonWorkspaceRoot, { recursive: true });
}
