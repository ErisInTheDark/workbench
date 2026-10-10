/*
 * Exports:
 * - default GitIndexLock: remove a Git index lock only when a dead writer provably left it incomplete.
 * - GitIndexLockState: outcome of one orphan check.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";

export type GitIndexLockState = "absent" | "complete" | "held" | "removed" | "unverifiable";

/**
 * libuv's UV_FS_O_EXLOCK: opens with Windows share mode 0, so it fails with EBUSY while any other handle is open.
 * Node does not expose the constant on Windows, but libuv honours the flag.
 */
const WINDOWS_EXCLUSIVE_OPEN = 0x10000000;
const INDEX_HASHES = [["sha1", 20], ["sha256", 32]] as const;

/** A complete index ends in its content hash, or in zeros when `index.skipHash` is set. */
function isCompleteIndex(bytes: Buffer) {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "DIRC") return false;
  const version = bytes.readUInt32BE(4);
  if (version < 2 || version > 4) return false;
  return INDEX_HASHES.some(([algorithm, size]) => {
    if (bytes.length < 12 + size) return false;
    const trailer = bytes.subarray(bytes.length - size);
    return trailer.every(byte => byte === 0)
      || createHash(algorithm).update(bytes.subarray(0, bytes.length - size)).digest().equals(trailer);
  });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/*
 * Git keeps its lock handle open from O_EXCL creation until the complete index is written; only then may it close the
 * handle (git commit does so before hooks and the editor, then renames later). So on Windows an incomplete lock that
 * nobody holds open can only belong to a writer that died, e.g. one terminated with its job object. Complete locks may
 * belong to a live commit and are never touched; Git cannot distinguish those either.
 */
export default class GitIndexLock {
  static async clearOrphan(indexPath: string): Promise<GitIndexLockState> {
    const lockPath = `${indexPath}.lock`;
    let observed: Buffer;
    try {
      // Shared read: never blocks a live writer or a hook reading the lock as GIT_INDEX_FILE.
      observed = await fs.readFile(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      throw error;
    }
    if (isCompleteIndex(observed)) return "complete";
    if (process.platform !== "win32") return "unverifiable";

    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, constants.O_RDONLY | WINDOWS_EXCLUSIVE_OPEN);
    } catch (error) {
      if (errorCode(error) === "EBUSY") return "held";
      if (errorCode(error) === "ENOENT") return "absent";
      throw error;
    }
    let size: number;
    let modifiedAt: number;
    try {
      // A writer may have finished and closed between the shared read and the exclusive open.
      const bytes = await handle.readFile();
      if (isCompleteIndex(bytes)) return "complete";
      ({ size, mtimeMs: modifiedAt } = await handle.stat());
    } finally {
      await handle.close();
    }
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      // Someone opened it since; the following Git command reports the lock normally.
      if (errorCode(error) === "EBUSY" || errorCode(error) === "EPERM") return "held";
      throw error;
    }
    console.warn(`[git] removed orphaned ${size}-byte index lock ${lockPath} (unchanged for ${
      Math.max(0, Math.round((Date.now() - modifiedAt) / 1000))}s)`);
    return "removed";
  }
}
