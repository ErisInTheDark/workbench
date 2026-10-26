/*
 * Exports:
 * - runBundledNpm: run npm through the daemon Node's own bundled npm, so installs never depend on PATH.
 * - commitStagedDirectory: rename a verified staging directory over its target, so readers only ever see a complete install.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const WINDOWS_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const COMMIT_RENAME_RETRIES = 12;

function bundledNpmCli() {
  const directory = path.dirname(process.execPath);
  const candidates = [
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`The daemon's Node runtime at ${process.execPath} has no bundled npm.`);
  return found;
}

/** Rejects with npm's failure; its stderr rides on the error. */
export async function runBundledNpm(args: string[], signal: AbortSignal) {
  await run(process.execPath, [bundledNpmCli(), ...args], { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Windows briefly locks freshly written files (antivirus, indexers, watchers), so a locked rename backs off for up to
 * ~17s before failing.
 */
export async function commitStagedDirectory(staging: string, target: string, signal?: AbortSignal) {
  await rm(target, { recursive: true, force: true });
  for (let attempt = 0; ; attempt++) {
    try { return await rename(staging, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !WINDOWS_LOCK_CODES.has(code) || attempt >= COMMIT_RENAME_RETRIES) throw error;
      await delay(Math.min(100 * 2 ** attempt, 2_000), undefined, { signal });
    }
  }
}
