/*
 * Exports:
 * - resolveCodexHome: resolve the configured or default Codex home.
 */
import os from "node:os";
import path from "node:path";

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env) {
  return path.resolve(env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
}
