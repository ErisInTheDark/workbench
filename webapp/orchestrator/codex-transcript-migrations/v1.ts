/*
 * Exports:
 * - default migrateV1: start non-blocking transcript cleanup for raw journals and stale atomic-write temp files. Keywords: transcript, migration, storage, cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type AtomicJsonStore from "../AtomicJsonStore";
import { log, logError } from "../process-helpers";

const STALE_TEMP_FILE_MS = 60 * 60 * 1000;

type CleanupCounts = {
  deleted: number;
  errors: number;
  skipped: number;
  visited: number;
};

function isRawJournal(fileName: string) {
  return fileName.endsWith(".ndjson");
}

function isTempArtifact(fileName: string) {
  return fileName.includes(".ndjson.tmp-") || fileName.includes(".json.tmp-");
}

function isWithinDirectory(rootDirectoryPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootDirectoryPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

async function removeReclaimableArtifacts(rootDirectoryPath: string, directoryPath: string, counts: CleanupCounts) {
  if (!isWithinDirectory(rootDirectoryPath, directoryPath)) {
    counts.skipped += 1;
    return;
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directoryPath, entry);
    if (!isWithinDirectory(rootDirectoryPath, entryPath)) {
      counts.skipped += 1;
      return;
    }

    counts.visited += 1;
    const stats = await fs.lstat(entryPath).catch(() => null);
    if (!stats) {
      return;
    }

    if (stats.isSymbolicLink()) {
      counts.skipped += 1;
      return;
    }

    if (stats.isDirectory()) {
      await removeReclaimableArtifacts(rootDirectoryPath, entryPath, counts);
      return;
    }

    if (stats.isFile() && isRawJournal(entry)) {
      await fs.rm(entryPath, { force: true }).then(
        () => {
          counts.deleted += 1;
        },
        () => {
          counts.errors += 1;
        },
      );
      return;
    }

    if (stats.isFile() && isTempArtifact(entry) && stats.mtimeMs < Date.now() - STALE_TEMP_FILE_MS) {
      await fs.rm(entryPath, { force: true }).then(
        () => {
          counts.deleted += 1;
        },
        () => {
          counts.errors += 1;
        },
      );
    }
  }));
}

async function runBackgroundCleanup(threadsDirectoryPath: string) {
  const startedAt = Date.now();
  const counts: CleanupCounts = {
    deleted: 0,
    errors: 0,
    skipped: 0,
    visited: 0,
  };
  log("codex-transcript", `background cleanup started root=${threadsDirectoryPath}`);
  await removeReclaimableArtifacts(threadsDirectoryPath, threadsDirectoryPath, counts);
  log("codex-transcript", [
    "background cleanup finished",
    `deleted=${counts.deleted}`,
    `errors=${counts.errors}`,
    `skipped=${counts.skipped}`,
    `visited=${counts.visited}`,
    `durationMs=${Date.now() - startedAt}`,
  ].join(" "));
}

export default async function migrateV1(rootDirectoryPath: string, _jsonStore: AtomicJsonStore) {
  const threadsDirectoryPath = path.join(rootDirectoryPath, "threads");
  void runBackgroundCleanup(threadsDirectoryPath).catch((error) => {
    logError("codex-transcript", `background cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
