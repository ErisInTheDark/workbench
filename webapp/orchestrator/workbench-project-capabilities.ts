/*
 * Exports:
 * - WorkbenchProjectCapabilities/getWorkbenchProjectCapabilities: derive exact-cwd capabilities for the running Workbench project. Keywords: workbench, cwd, capability, MCP, reload.
 */
import path from "node:path";

export interface WorkbenchProjectCapabilities {
  reloadScopes: boolean;
}

function comparablePath(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = path.resolve(trimmed).replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getWorkbenchProjectCapabilities(cwd: string | null | undefined, workbenchProjectRoot: string): WorkbenchProjectCapabilities {
  return { reloadScopes: comparablePath(cwd) === comparablePath(workbenchProjectRoot) };
}
