/*
 * Exports:
 * - default renameWhenUnlocked: rename, backing off while Windows briefly locks a freshly written file or directory.
 */
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const WINDOWS_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 12;

/** Antivirus, indexers and watchers hold fresh entries for a moment; a locked rename backs off for up to ~17s. */
export default async function renameWhenUnlocked(from: string, to: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !WINDOWS_LOCK_CODES.has(code) || attempt >= RENAME_RETRIES) throw error;
      await delay(Math.min(100 * 2 ** attempt, 2_000), undefined, { signal });
    }
  }
}
